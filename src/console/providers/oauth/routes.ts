import { providerAccounts, providerOauthStates } from "../../../persistence/schema";
import { encryptCredential } from "../../../security/crypto";
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
import { oauthAccountFingerprint } from "./account-fingerprint";
import {
  AUTOCLAW_OAUTH_REDIRECT_URI,
  AutoClawOAuthError,
} from "../../../providers/integrations/autoclaw/oauth";
import {
  AutoClawOAuthClient,
  beginAutoClawAuthorize,
  readAutoClawCaptchaConfig,
  verifyAutoClawToken,
} from "../../../providers/integrations/autoclaw/oauth-client";
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
            accountEmail: exchangeEmail(input),
            credentialKind: "oauth",
            credentialCiphertext: encryptCredential(input.access),
            credentialFingerprint: oauthAccountFingerprint(providerId, input),
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
 * The login email an OAuth exchange reported, when its shape carries one.
 *
 * AutoClaw's result packs `displayName` from `user_name`/`email` in one field,
 * so a value that parses as an email is stored separately from the label. This
 * lets the accounts list show which mailbox backs a credential without a
 * profile round-trip per row.
 */
export function exchangeEmail(result: { readonly accountLabel?: string | null }): string | null {
  const label = result.accountLabel?.trim();
  return label !== undefined && label.includes("@") ? label : null;
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

/**
 * The tab the vendor's redirect lands in.
 *
 * Deliberately tiny and same-origin only: no fonts, no scripts, no external
 * assets, so a callback page can never become an injection surface or leak the
 * referrer. It closes itself on success because the operator started this from
 * the console and has nothing left to do here.
 */
function autoClawCallbackPage(ok: boolean, title: string, detail: string): string {
  const accent = ok ? "#2f855a" : "#c53030";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14161a;color:#e6e8eb;
       font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{max-width:420px;padding:28px;text-align:center}
  h1{margin:0 0 8px;font-size:17px;color:${accent}}
  p{margin:0;color:#9aa3ad;font-size:13px}
</style></head>
<body><main><h1>${title}</h1><p>${detail}</p></main>
${ok ? "<script>setTimeout(() => { location.replace('/console/providers/autoclaw'); }, 1400)</script>" : ""}
</body></html>`;
}

const accountLabelBody = t.Optional(t.Object({ accountLabel: t.Optional(t.String()) }));
/**
 * AutoClaw's authorize step is captcha-gated and its `state` is minted by the
 * vendor, so it cannot ride the generic browser-code route: that route builds a
 * URL from a locally generated state, which the exchange endpoint rejects.
 */
const autoClawStartBody = t.Optional(
  t.Object({ accountLabel: t.Optional(t.String()), captchaVerifyParam: t.Optional(t.String()) }),
);
/**
 * A token obtained elsewhere: from the AutoClaw desktop app, or from a login the
 * operator finished in a browser on another machine.
 */
const autoClawTokenBody = t.Object({
  token: t.String({ minLength: 1 }),
  accountLabel: t.Optional(t.String()),
});
/** The callback's code plus the state the vendor minted with it. */
const autoClawCompleteBody = t.Object({
  code: t.String({ minLength: 1 }),
  state: t.String({ minLength: 1 }),
  accountLabel: t.Optional(t.String()),
});
/**
 * The redirect target a browser login must name.
 *
 * Z.ai validates `redirect_uri` only once the browser holds a login session:
 * pre-auth requests get a `307 -> /auth?...` for any URI, which makes the
 * endpoint look permissive. Signed in, the same request is refused for every
 * URI except this client's registered loopback, so the registered value is the
 * only usable one. Its server is the desktop app's; the dashboard and the
 * OAuth bridge cover the gap by handing the code straight back here.
 */
function autoClawCallbackUri(): string {
  return AUTOCLAW_OAUTH_REDIRECT_URI;
}

/**
 * The shipped AutoClaw client's own app identity.
 *
 * Public constants of the desktop build, not deployment secrets: every AutoClaw
 * client signs with these, and the gateway only checks that the digest matches.
 */
const AUTOCLAW_SIGNER = {
  appId: "100003",
  appKey: "38d2391985e2369a5fb8227d8e6cd5e5",
} as const;

/**
 * The device id the gateway associates with a login.
 *
 * Derived per process rather than random per request: the gateway records the
 * device that first completed a flow, and a value that changes per login makes
 * every attempt look like a new device.
 */
function autoClawDeviceId(): string {
  return `lianrouter-${process.platform}`;
}

const devicePollBody = t.Object({ deviceAuthId: t.String() });
const loopbackCompleteBody = t.Object({
  state: t.String({ minLength: 1 }),
  code: t.String({ minLength: 1 }),
  redirectUri: t.String({ minLength: 1 }),
});

export function createOAuthLoginRoutes(config: OAuthLoginConfig): Elysia {
  const factory = createOAuthLoginOperations(config);
  return new Elysia({ prefix: "/providers" })
    /**
     * AutoClaw: mint an authorization URL, captcha included.
     *
     * The vendor signs the `state` it hands back, and its exchange endpoint
     * verifies that signature — so the operator must open exactly this URL and
     * come back with exactly this state.
     */
    .post(
      "/autoclaw/oauth/authorize",
      { body: autoClawStartBody },
      async ({ request, body, set }) => {
        try {
          const access = config.accessResolver(request);
          requireScope(access, "dashboard:write");
          set.status = 201;
          const navigateUri = autoClawCallbackUri();
          const started = await beginAutoClawAuthorize({
            signer: AUTOCLAW_SIGNER,
            deviceId: autoClawDeviceId(),
            ...(body?.captchaVerifyParam ? { captchaVerifyParam: body.captchaVerifyParam } : {}),
            navigateUri,
          }).catch((error: unknown) => {
            // An unsolved captcha is the normal first answer, not a server
            // fault: the gateway refuses to mint a URL until the challenge is
            // answered, so the operator needs that fact and the code, not 500.
            if (error instanceof AutoClawOAuthError) {
              throw new ConsoleDomainError(
                "autoclaw_oauth_failed",
                400,
                error.message,
                { providerId: "autoclaw", upstreamCode: error.code },
              );
            }
            throw error;
          });
          // The callback arrives with no console session, so the tenant and the
          // exact `navigate_uri` this URL was minted for have to be remembered
          // against the vendor's `state`. Consuming it there also makes the
          // state single-use.
          await config.oauthFlowStore.savePending(started.state, {
            providerId: "autoclaw",
            codeVerifier: "",
            accountLabel: body?.accountLabel?.trim() || "AutoClaw",
            tenantId: access?.tenantId ?? null,
            redirectUri: navigateUri,
          });
          return started;
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
    /**
     * AutoClaw: the vendor will never send a browser here.
     *
     * Kept as an explicit dead end rather than deleted: an operator who pastes
     * this URL somewhere, or a deployment whose client registration ever changes,
     * should get an answer that names the real destination instead of a 404 that
     * looks like the console is broken. If a code does arrive, the login is
     * finished: the vendor only rejects the advertised target, not the exchange.
     */
    .get("/autoclaw/oauth/callback", async ({ request, set }) => {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      const origin = new URL(request.url).origin;
      set.headers["content-type"] = "text/html; charset=utf-8";
      if (code === null) {
        set.status = 400;
        return autoClawCallbackPage(
          false,
          "Not the redirect target",
          "AutoClaw only accepts http://localhost:18432/auth/callback-zai. If you reached this page some other way, start the login again from the dashboard.",
        );
      }
      try {
        const state = url.searchParams.get("state") ?? "";
        const pending = await config.oauthFlowStore.consumePending(state);
        if (pending === undefined || pending.providerId !== "autoclaw") {
          set.status = 400;
          return autoClawCallbackPage(
            false,
            "Login expired",
            "This login link was already used or has expired. Start the login again from the dashboard.",
          );
        }
        const client = new AutoClawOAuthClient({
          signer: AUTOCLAW_SIGNER,
          deviceId: autoClawDeviceId(),
          navigateUri: pending.redirectUri,
        });
        const exchanged = await client.exchangeLogin({ code, state });
        const persisted = await config.accountStore.persistAccount(pending.tenantId, "autoclaw", {
          label: pending.accountLabel || exchanged.accountLabel || "AutoClaw",
          ...exchanged,
        });
        await config.snapshotInvalidator?.invalidate();
        return autoClawCallbackPage(
          true,
          "Account connected",
          `AutoClaw account ${persisted.accountId.slice(0, 8)} is ready. Return to ${origin}.`,
        );
      } catch (error) {
        return autoClawCallbackPage(
          false,
          "Login failed",
          error instanceof AutoClawOAuthError
            ? error.message
            : error instanceof Error
              ? error.message
              : "The exchange failed.",
        );
      }
    })
    /**
     * AutoClaw: redeem the callback's code.
     *
     * No access check on purpose, matching `/oauth/loopback/complete`: the
     * vendor-signed `state` is the authentication. Only a caller who obtained a
     * live state from the authorize step can present one the gateway accepts,
     * and the gateway itself rejects anything else.
     */
    .post(
      "/autoclaw/oauth/complete",
      { body: autoClawCompleteBody },
      async ({ request, body, set }) => {
        try {
          const access = config.accessResolver(request);
          // The state was minted by the vendor during `authorize`, which also
          // remembered the tenant that started it. Reading it back means a URL
          // pasted from a different browser still lands on the right tenant;
          // a state that was never seen here falls back to the session.
          const pending = await config.oauthFlowStore.consumePending(body.state);
          const client = new AutoClawOAuthClient({
            signer: AUTOCLAW_SIGNER,
            deviceId: autoClawDeviceId(),
            navigateUri: autoClawCallbackUri(),
          });
          const exchanged = await client.exchangeLogin({ code: body.code, state: body.state }).catch(
            (error: unknown) => {
              // The vendor's own codes are the useful half of this failure: a
              // rejected code and a rejected state are different operator
              // actions, and collapsing them into a 500 hides which.
              if (error instanceof AutoClawOAuthError) {
                throw new ConsoleDomainError(
                  "autoclaw_oauth_failed",
                  400,
                  error.message,
                  { providerId: "autoclaw", upstreamCode: error.code },
                );
              }
              throw error;
            },
          );
          const persisted = await config.accountStore.persistAccount(
            pending?.tenantId ?? access?.tenantId ?? null,
            "autoclaw",
            {
              label: body.accountLabel?.trim() || exchanged.accountLabel || "AutoClaw",
              ...exchanged,
            },
          );
          await config.snapshotInvalidator?.invalidate();
          return { accountId: persisted.accountId };
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
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
    /**
     * AutoClaw: store a token that was obtained somewhere else.
     *
     * This is the path that works from a headless deployment. The authorize
     * step is captcha-gated, and an Aliyun token is bound to the browser's own
     * IP, so a server cannot mint one for an operator sitting elsewhere. The
     * desktop app already holds a valid token for the account, so accepting one
     * pasted by the operator needs no challenge at all — and the token is
     * verified against the gateway before it is stored, so a stale or foreign
     * value is rejected here rather than becoming a failing account.
     */
    .post(
      "/autoclaw/oauth/token",
      { body: autoClawTokenBody },
      async ({ request, body, set }) => {
        try {
          const access = config.accessResolver(request);
          requireScope(access, "dashboard:write");
          const token = body.token.trim();
          const check = await verifyAutoClawToken(token);
          if (!check.valid) {
            throw new ConsoleDomainError(
              "autoclaw_token_invalid",
              400,
              check.reason ?? "AutoClaw did not accept this token",
              { providerId: "autoclaw" },
            );
          }
          const persisted = await config.accountStore.persistAccount(access?.tenantId ?? null, "autoclaw", {
            label: body.accountLabel?.trim() || check.accountLabel || "AutoClaw",
            access: token,
            refresh: "",
            expiresAt: new Date("9999-12-31T00:00:00.000Z"),
            ...(check.accountLabel !== undefined ? { accountLabel: check.accountLabel } : {}),
          });
          await config.snapshotInvalidator?.invalidate();
          set.status = 201;
          return { accountId: persisted.accountId };
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
    /**
     * AutoClaw: read the challenge the authorize step will demand.
     *
     * Separate from `authorize` because the dashboard has to render a widget
     * before a login can start: the vendor refuses to mint a URL until the
     * challenge is solved, so `authorize` answering "captcha not answered" is
     * the normal first reply and the client needs the challenge parameters to
     * do anything about it. This route is what makes the browser flow usable
     * without a human reading a comment to find out which challenge to load.
     */
    .get(
      "/autoclaw/oauth/captcha",
      async ({ request, set }) => {
        try {
          const access = config.accessResolver(request);
          requireScope(access, "dashboard:read");
          return await readAutoClawCaptchaConfig({
            signer: AUTOCLAW_SIGNER,
            deviceId: autoClawDeviceId(),
          }).catch((error: unknown) => {
            if (error instanceof AutoClawOAuthError) {
              throw new ConsoleDomainError(
                "autoclaw_oauth_failed",
                502,
                error.message,
                { providerId: "autoclaw", upstreamCode: error.code },
              );
            }
            throw error;
          });
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

