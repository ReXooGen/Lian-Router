import { providerAccounts, providerOauthStates } from "../../../persistence/schema";
import { encryptCredential, hashSecret } from "../../../security/crypto";
import type { LianRouterDatabase } from "../../../persistence/postgres";
import type { OAuthExchangeResult, OAuthLoginClient } from "../../../providers/authentication/oauth-flow-store";
import type { OAuthDevicePollResponse } from "../catalog/contracts";
import { providerJwtVerification, type ProviderRegistry } from "../../../providers/provider-registry";
import { browserAuthorizeRedirectUri, requirePublicOrigin } from "../../../config";
import { log } from "../../../observability/logger";
import { GatewayError } from "../../../transport/gateway-error";
import { Elysia, t } from "elysia";
import { ConsoleDomainError, errorResponse, requireScope } from "../../shared/errors";
import { generateOAuthState, generatePkcePair } from "../../../providers/authentication/oauth-flow-store";
import type { OAuthFlowStore } from "../../../providers/authentication/oauth-flow-store";
import { validateIssuedAccessToken } from "../../../providers/authentication/jwt-validator";
import { inlineScriptContentSecurityPolicy } from "../../../security/outbound-headers";
import type { AccessDecision } from "../../../security/access-control";
import { isUniqueViolation } from "../../../persistence/postgres";
import {
  ANTIGRAVITY_LOOPBACK_PYTHON,
  antigravityLoopbackShellSnippet,
} from "./antigravity-loopback-helper";
import type { ConsoleAccessResolver } from "../../auth/access";
/** OAuth identity is not exposed by the current exchange contract; the refresh
 * token fingerprint prevents replaying the exact same OAuth credential only. */

/** Drizzle-backed persistence for a newly completed OAuth login. */
export class DrizzleOAuthAccountStore implements OAuthAccountStore {
  constructor(private readonly db: LianRouterDatabase) {}

  async persistAccount(
    tenantId: string | null,
    providerId: string,
    input: { readonly label: string } & OAuthExchangeResult,
  ): Promise<PersistedOAuthAccount> {
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .insert(providerAccounts)
          .values({
            providerId,
            tenantId,
            label: input.label,
            credentialKind: "oauth",
            credentialCiphertext: encryptCredential(input.access),
            credentialFingerprint: hashSecret(input.refresh),
            status: "active",
          })
          .returning({ id: providerAccounts.id });
        const row = rows[0];
        if (!row) throw new Error("failed to persist OAuth account");
        await tx.insert(providerOauthStates).values({
          providerAccountId: row.id,
          refreshCiphertext: encryptCredential(input.refresh),
          expiresAt: input.expiresAt,
        });
        return { accountId: row.id };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConsoleDomainError(
          "provider_account_duplicate",
          409,
          "A provider account with this credential already exists",
        );
      }
      throw error;
    }
  }
}

/**
 * Console OAuth login domain: authorize-URL initiation, callback exchange,
 * and device-code start/poll — driven by whichever `OAuthLoginClient` is
 * registered for a given provider id.
 * LianRouter hosts the callback itself (it's a server process, not a local
 * CLI), so there is no loopback-listener/port-selection problem.
 */
export interface PersistedOAuthAccount {
  readonly accountId: string;
}

export interface OAuthAccountStore {
  persistAccount(
    tenantId: string | null,
    providerId: string,
    input: { readonly label: string } & OAuthExchangeResult,
  ): Promise<PersistedOAuthAccount>;
}

export interface OAuthLoginConfig {
  readonly providerRegistry: ProviderRegistry;
  readonly oauthFlowStore: OAuthFlowStore;
  readonly accountStore: OAuthAccountStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
}

async function requireClient(
  registry: ProviderRegistry,
  providerId: string,
): Promise<OAuthLoginClient> {
  const client = await registry.resolveLoginClient(providerId);
  if (!client)
    throw new ConsoleDomainError(
      "oauth_not_supported",
      404,
      `Provider ${providerId} has no OAuth login client registered`,
      { providerId },
    );
  return client;
}

function successPage(providerId: string, wantsJson: boolean): Response {
  if (wantsJson) {
    return Response.json({
      providerId,
      message: `${providerId} account connected. You may close this tab.`,
    });
  }
  const closeScript = "window.close();";
  return new Response(
    `<!doctype html><html><body><p>${providerId} account connected. You may close this tab.</p><script>${closeScript}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": inlineScriptContentSecurityPolicy([closeScript]),
      },
    },
  );
}

/**
 * Message shown in the browser when a token exchange throws.
 *
 * `GatewayError.origin` marks which boundary produced the error, and its own
 * contract calls a non-upstream error "a safe public error". So a
 * `lianrouter`-origin message — authored by one of our integrations, already
 * sanitized — is shown as-is: without it, an actionable failure such as "MiMo
 * Desktop is running and holds its cookie store locked" reaches the operator
 * only through the server log, and the dialog says nothing they can act on.
 * Anything else (an upstream body, a network failure, an arbitrary throw) keeps
 * the generic wording, because an upstream response can echo credentials.
 */
function publicExchangeFailure(error: unknown): string {
  if (error instanceof GatewayError && error.origin === "gateway") return error.message;
  return "token exchange failed — check the console log for details";
}

function failurePage(message: string, wantsJson: boolean): Response {
  if (wantsJson) {
    return Response.json(
      { error: message, code: "oauth_callback_failed" },
      { status: 400 },
    );
  }
  const escapedMessage = message.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
  return new Response(
    `<!doctype html><html><body><p>OAuth login failed: ${escapedMessage}</p></body></html>`,
    {
      status: 400,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": inlineScriptContentSecurityPolicy([]),
      },
    },
  );
}

export function createOAuthLoginOperations(config: OAuthLoginConfig) {
  const operations = {
    async beginAuthorize(
        access: AccessDecision | undefined,
        providerId: string,
        accountLabel: string,
      ): Promise<{ authorizeUrl: string; state: string }> {
        const a = requireScope(access, "dashboard:write");
        const client = await requireClient(config.providerRegistry, providerId);
        if (typeof client.buildAuthorizeUrl !== "function") {
          throw new ConsoleDomainError(
            "browser_code_not_supported",
            409,
            `Provider ${providerId} only supports device-code login — use "Login with device code" instead`,
            { providerId },
          );
        }
        if (typeof client.exchangeCode !== "function") {
          throw new ConsoleDomainError(
            "browser_code_not_supported",
            409,
            `Provider ${providerId} only supports device-code login — use "Login with device code" instead`,
            { providerId },
          );
        }
        const state = generateOAuthState();
        const { codeVerifier, codeChallenge } = generatePkcePair();
        const redirectUri = browserAuthorizeRedirectUri();
        await config.oauthFlowStore.savePending(state, {
          providerId,
          codeVerifier,
          accountLabel,
          tenantId: a.tenantId,
          redirectUri,
        });
        return { authorizeUrl: client.buildAuthorizeUrl({ state, codeChallenge, redirectUri }), state };
      },
    async handleCallback(
        providerId: string,
        code: string,
        state: string,
        wantsJson = false,
      ): Promise<Response> {
        const flow = await config.oauthFlowStore.consumePending(state);
        if (!flow || flow.providerId !== providerId)
          return failurePage("unknown or expired state", wantsJson);
        const client = await requireClient(config.providerRegistry, providerId);
        if (!client.exchangeCode) {
          return failurePage("provider does not support browser authorization", wantsJson);
        }
        try {
          const result = await client.exchangeCode(code, flow.codeVerifier, flow.redirectUri);
          const tokenCheck = await validateIssuedAccessToken(
            result.access,
            providerJwtVerification(providerId),
          );
          if (!tokenCheck.valid) {
            throw new ConsoleDomainError(
              "oauth_token_invalid",
              400,
              `Provider ${providerId} returned an access token that failed validation (${tokenCheck.reason})`,
              { providerId },
            );
          }
          await config.accountStore.persistAccount(flow.tenantId, providerId, {
            label: result.accountLabel ?? flow.accountLabel,
            ...result,
          });
          await config.snapshotInvalidator?.invalidate();
          return successPage(providerId, wantsJson);
        } catch (error) {
          // Upstream token-endpoint bodies can echo credentials or sensitive
          // diagnostics — the browser gets a generic failure; the bounded
          // detail stays server-side in the console log.
          log.error(
            `[oauth] token exchange failed for ${providerId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error instanceof Error ? error : undefined,
          );
          return failurePage(publicExchangeFailure(error), wantsJson);
        }
      },
    async handleCallbackError(
        providerId: string,
        state: string,
        wantsJson = false,
      ): Promise<Response> {
        const flow = await config.oauthFlowStore.consumePending(state);
        if (!flow || flow.providerId !== providerId)
          return failurePage("unknown or expired state", wantsJson);
        return failurePage("authorization was denied by the provider", wantsJson);
      },
    async beginLoopback(
        access: AccessDecision | undefined,
        providerId: string,
        accountLabel: string,
      ): Promise<{
        state: string;
        codeVerifier: string;
        codeChallenge: string;
        authorizeBase: string;
        scope: string;
        clientId: string;
        extra: Record<string, string>;
        ttlSeconds: number;
        shellSnippet: string;
        helperScriptUrl: string;
      }> {
        const a = requireScope(access, "dashboard:write");
        const client = await requireClient(config.providerRegistry, providerId);
        if (
          typeof client.buildAuthorizeUrl !== "function" ||
          typeof client.exchangeCode !== "function"
        ) {
          throw new ConsoleDomainError(
            "browser_code_not_supported",
            409,
            `Provider ${providerId} does not expose a browser authorize URL`,
            { providerId },
          );
        }
        // Loopback flow is only valid for providers whose OAuth client identity
        // is a Google-style "Desktop Application": Google rejects any public
        // HTTPS redirect for those client ids, so the authorize URL has to be
        // built from a redirect the user's own machine will listen on. The
        // helper CLI the dashboard hands out picks a random local port and
        // posts the code back to /oauth/loopback/complete; the server never
        // commits a `redirectUri` here because the final value is chosen on
        // the user's side at runtime.
        if (providerId !== "antigravity") {
          throw new ConsoleDomainError(
            "loopback_not_supported",
            409,
            `Provider ${providerId} does not require the loopback OAuth flow — use /oauth/authorize instead`,
            { providerId },
          );
        }
        const state = generateOAuthState();
        const { codeVerifier, codeChallenge } = generatePkcePair();
        // Loopback flows store the verifier under a sentinel redirectUri. The
        // real one arrives on the complete call and must match the authorize
        // round-trip exactly, so the sentinel acts as "unset" rather than a
        // placeholder the client could ever send back.
        await config.oauthFlowStore.savePending(state, {
          providerId,
          codeVerifier,
          accountLabel,
          tenantId: a.tenantId,
          redirectUri: "loopback:pending",
        });
        // The authorize URL is NOT precomputed; the helper CLI builds it after
        // picking a local port. We only expose the pieces the CLI needs to
        // construct it (base URL, scope, client id, extra params like
        // `access_type=offline&prompt=consent`).
        const authorizeUrl = client.buildAuthorizeUrl({
          state,
          codeChallenge,
          redirectUri: "LOOPBACK_PLACEHOLDER",
        });
        const parsed = new URL(authorizeUrl);
        const authorizeBase = `${parsed.origin}${parsed.pathname}`;
        const scope = parsed.searchParams.get("scope") ?? "";
        const clientId = parsed.searchParams.get("client_id") ?? "";
        const extra: Record<string, string> = {};
        for (const key of ["access_type", "prompt"]) {
          const value = parsed.searchParams.get(key);
          if (value !== null) extra[key] = value;
        }
        const consoleOrigin = requirePublicOrigin();
        const shellSnippet = antigravityLoopbackShellSnippet({
          console: consoleOrigin,
          providerId,
          accountLabel,
          state,
          codeChallenge,
          codeVerifier,
          clientId,
          scope,
          authorizeBase,
          extra,
        });
        return {
          state,
          codeVerifier,
          codeChallenge,
          authorizeBase,
          scope,
          clientId,
          extra,
          ttlSeconds: 900,
          shellSnippet,
          helperScriptUrl: `${consoleOrigin}/console/api/providers/antigravity/oauth/helper.py`,
        };
      },
    async completeLoopback(
        providerId: string,
        input: { state: string; code: string; redirectUri: string },
      ): Promise<{ accountId: string; email: string | undefined }> {
        const flow = await config.oauthFlowStore.consumePending(input.state);
        if (!flow || flow.providerId !== providerId) {
          throw new ConsoleDomainError(
            "oauth_state_invalid",
            400,
            "Unknown or expired loopback state — restart the loopback flow",
          );
        }
        if (flow.redirectUri !== "loopback:pending") {
          throw new ConsoleDomainError(
            "oauth_state_invalid",
            400,
            "State was not registered for the loopback flow",
          );
        }
        // Loopback redirect URIs must be loopback: Google only accepts
        // 127.0.0.1 / localhost for a Desktop OAuth client id, and letting
        // the client post any URI here would turn the complete endpoint into
        // an open OAuth relay for the same client credentials.
        let parsedRedirect: URL;
        try {
          parsedRedirect = new URL(input.redirectUri);
        } catch {
          throw new ConsoleDomainError(
            "oauth_redirect_invalid",
            400,
            "redirectUri must be a valid URL",
          );
        }
        if (parsedRedirect.protocol !== "http:") {
          throw new ConsoleDomainError(
            "oauth_redirect_invalid",
            400,
            "Loopback redirect must be http (Google only accepts http on 127.0.0.1/localhost)",
          );
        }
        if (parsedRedirect.hostname !== "127.0.0.1" && parsedRedirect.hostname !== "localhost") {
          throw new ConsoleDomainError(
            "oauth_redirect_invalid",
            400,
            "Loopback redirect host must be 127.0.0.1 or localhost",
          );
        }
        const client = await requireClient(config.providerRegistry, providerId);
        if (!client.exchangeCode) {
          throw new ConsoleDomainError(
            "browser_code_not_supported",
            409,
            "Provider does not support browser authorization",
          );
        }
        try {
          const result = await client.exchangeCode(input.code, flow.codeVerifier, input.redirectUri);
          const tokenCheck = await validateIssuedAccessToken(
            result.access,
            providerJwtVerification(providerId),
          );
          if (!tokenCheck.valid) {
            throw new ConsoleDomainError(
              "oauth_token_invalid",
              400,
              `Provider ${providerId} returned an access token that failed validation (${tokenCheck.reason})`,
              { providerId },
            );
          }
          const persisted = await config.accountStore.persistAccount(flow.tenantId, providerId, {
            label: result.accountLabel ?? flow.accountLabel,
            ...result,
          });
          await config.snapshotInvalidator?.invalidate();
          return { accountId: persisted.accountId, email: result.accountLabel };
        } catch (error) {
          log.error(
            `[oauth] loopback token exchange failed for ${providerId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            error instanceof Error ? error : undefined,
          );
          throw error;
        }
      },
    async startDevice(
        access: AccessDecision | undefined,
        providerId: string,
        accountLabel: string,
      ): Promise<{
        verificationUri: string;
        userCode: string;
        deviceAuthId: string;
        intervalSeconds: number;
        expiresInSeconds: number;
      }> {
        const a = requireScope(access, "dashboard:write");
        const client = await requireClient(config.providerRegistry, providerId);
        if (!client.supportsDeviceCode || !client.startDeviceAuth)
          throw new ConsoleDomainError(
            "device_code_not_supported",
            409,
            `Provider ${providerId} does not support device-code login`,
            { providerId },
          );
        const started = await client.startDeviceAuth({
          providerId,
          tenantId: a.tenantId,
          accountLabel,
        });
        const { providerState, ...publicStarted } = started;
        await config.oauthFlowStore.saveDevice(started.deviceAuthId, {
          providerId,
          accountLabel,
          tenantId: a.tenantId,
          ...(providerState === undefined ? {} : { providerState }),
        });
        return publicStarted;
      },
    async pollDevice(
        access: AccessDecision | undefined,
        providerId: string,
        deviceAuthId: string,
      ): Promise<OAuthDevicePollResponse> {
        const a = requireScope(access, "dashboard:write");
        const correlation = await config.oauthFlowStore.getDevice(deviceAuthId);
        if (
          !correlation ||
          correlation.providerId !== providerId ||
          correlation.tenantId !== a.tenantId
        )
          throw new ConsoleDomainError("device_flow_unknown", 404, "Unknown or expired device-code flow", {
            deviceAuthId,
          });
        const client = await requireClient(config.providerRegistry, providerId);
        if (!client.pollDeviceAuth)
          throw new ConsoleDomainError(
            "device_code_not_supported",
            409,
            "Provider does not support device-code login",
          );
        const polled = await client.pollDeviceAuth(deviceAuthId, {
          providerId,
          tenantId: a.tenantId,
          accountLabel: correlation.accountLabel,
          ...(correlation.providerState === undefined
            ? {}
            : { providerState: correlation.providerState }),
        });
        if (polled.status === "pending") return { status: "pending" };
        if (polled.status === "failed") {
          await config.oauthFlowStore.deleteDevice(deviceAuthId);
          return { status: "failed", reason: polled.reason };
        }
        const tokenCheck = await validateIssuedAccessToken(
          polled.result.access,
          providerJwtVerification(providerId),
        );
        if (!tokenCheck.valid) {
          await config.oauthFlowStore.deleteDevice(deviceAuthId);
          throw new ConsoleDomainError(
            "oauth_token_invalid",
            400,
            `Provider ${providerId} returned an access token that failed validation (${tokenCheck.reason})`,
            { providerId },
          );
        }
        // Delete only after persistAccount succeeds: a failure here (DB error)
        // must leave the device-flow state intact so the poller can retry
        // persisting the already-exchanged token instead of losing it and
        // forcing the operator through device authorization again.
        const persisted = await config.accountStore.persistAccount(
          correlation.tenantId,
          providerId,
          {
            label: polled.result.accountLabel ?? correlation.accountLabel,
            ...polled.result,
          },
        );
        await config.oauthFlowStore.deleteDevice(deviceAuthId);
        await config.snapshotInvalidator?.invalidate();
        return { status: "complete", accountId: persisted.accountId };
      },
  };
  return operations;
}

function oauthErrorResponse(error: unknown, set: { status?: number | string }) {
  return errorResponse(error, set, "OAuth login operation failed", {
    detailsPolicy: "always-include",
  });
}

const accountLabelBody = t.Optional(t.Object({ accountLabel: t.Optional(t.String()) }));
const devicePollBody = t.Object({ deviceAuthId: t.String() });
const loopbackCompleteBody = t.Object({
  state: t.String({ minLength: 1 }),
  code: t.String({ minLength: 1 }),
  redirectUri: t.String({ minLength: 1 }),
});

export function createOAuthLoginRoutes(config: OAuthLoginConfig): Elysia {
  const factory = createOAuthLoginOperations(config);
  return new Elysia({ prefix: "/providers" })
    .post(
      "/:providerId/oauth/authorize",
      { body: accountLabelBody },
      async ({ request, params, body, set }) => {
        try {
          set.status = 201;
          return await factory.beginAuthorize(
            config.accessResolver(request),
            params.providerId,
            body?.accountLabel ?? params.providerId,
          );
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
    .get("/:providerId/oauth/callback", async ({ params, query, request }) => {
      const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
      const code = typeof query["code"] === "string" ? query["code"] : "";
      const state = typeof query["state"] === "string" ? query["state"] : "";
      const providerError = typeof query["error"] === "string" ? query["error"] : "";
      if (providerError && state)
        return factory.handleCallbackError(params.providerId, state, wantsJson);
      if (!code || !state) return failurePage("missing code or state", wantsJson);
      return factory.handleCallback(params.providerId, code, state, wantsJson);
    })
    .post(
      "/:providerId/oauth/device/start",
      { body: accountLabelBody },
      async ({ request, params, body, set }) => {
        try {
          set.status = 201;
          return await factory.startDevice(
            config.accessResolver(request),
            params.providerId,
            body?.accountLabel ?? params.providerId,
          );
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
    .post(
      "/:providerId/oauth/device/poll",
      { body: devicePollBody },
      async ({ request, params, body, set }) => {
        try {
          return await factory.pollDevice(
            config.accessResolver(request),
            params.providerId,
            body.deviceAuthId,
          );
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
    .post(
      "/:providerId/oauth/loopback/start",
      { body: accountLabelBody },
      async ({ request, params, body, set }) => {
        try {
          set.status = 201;
          return await factory.beginLoopback(
            config.accessResolver(request),
            params.providerId,
            body?.accountLabel ?? params.providerId,
          );
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
    .post(
      "/:providerId/oauth/loopback/complete",
      { body: loopbackCompleteBody },
      async ({ params, body, set }) => {
        try {
          // No access-resolver check: the state consumed from the Redis flow
          // store IS the authentication — only a caller who ran /start can
          // present a valid, unconsumed state. This mirrors how `callback`
          // handles its own cross-domain redirect without a session cookie.
          return await factory.completeLoopback(params.providerId, {
            state: body.state,
            code: body.code,
            redirectUri: body.redirectUri,
          });
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
    .get("/:providerId/oauth/helper.py", ({ params, set }) => {
      // Public download — the script is harmless without the operator's
      // JSON config, which the dashboard only hands to a logged-in session.
      if (params.providerId !== "antigravity") {
        set.status = 404;
        return "helper is only provided for the antigravity provider";
      }
      set.headers["content-type"] = "text/x-python; charset=utf-8";
      set.headers["cache-control"] = "public, max-age=300";
      return ANTIGRAVITY_LOOPBACK_PYTHON;
    }) as unknown as Elysia;
}

