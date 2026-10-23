// Public enrollment routes for shared API-key templates.
//
// Share URLs reveal policy and allow one child key to be created per canonical
// client IP. The child bearer is returned only by the successful issue call.

import { Elysia } from "elysia";
import { and, eq, isNull, or } from "drizzle-orm";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { models, providers } from "../../persistence/schema";
import { canonicalClientIpKey } from "../../security/ip-boundary";
import { isModelAllowed, isProviderAllowed, type ApiKeyAuthorizationSnapshot } from "../../security/api-key-auth";
import { API_CONTENT_SECURITY_POLICY, X_FRAME_OPTIONS } from "../../security/outbound-headers";
import { generateApiKeySecret } from "../domains/api-keys/contracts";
import { decryptCredentialToString, encryptCredential } from "../../security/crypto";
import { hashShareToken, type ShareLinkStore, type ShareApiKeyRow } from "../../persistence/share-store";
import type { ShareActivityPort } from "./share-usage";
import { resolveEffectivePublicBaseUrl } from "../../runtime/public-base-url";

/** Minimum accepted token length; generated tokens are 43 base64url chars. */
const MIN_TOKEN_LENGTH = 20;

/** Device-key length bounds; the page sends a 43-char base64url id. */
const MIN_DEVICE_KEY_LENGTH = 16;
const MAX_DEVICE_KEY_LENGTH = 128;

/**
 * Parses the enrollment device identifier from a JSON body.
 *
 * Bounded and opaque: the value is never interpreted, only matched against the
 * column it was stored under. Returns `undefined` so callers can distinguish
 * "absent" from "present but unusable" without a second error code.
 */
function parseDeviceKey(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = (body as Record<string, unknown>)["deviceId"];
  if (typeof raw !== "string") return undefined;
  if (raw.length < MIN_DEVICE_KEY_LENGTH || raw.length > MAX_DEVICE_KEY_LENGTH) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  return raw;
}

export interface ShareRouterOptions {
  readonly db: LianRouterDatabase;
  readonly shareStore: ShareLinkStore;
  readonly shareActivity: ShareActivityPort;
  /** Resolves the normalized client IP through the trusted-proxy boundary. */
  readonly resolveClientIp: (request: Request) => string | null;
}

export interface ShareModelAccess {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly wireFamily: string;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly vision: boolean;
  readonly webSearch: boolean;
  readonly source: string | null;
}

function shareHeaders(): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": API_CONTENT_SECURITY_POLICY,
    "x-frame-options": X_FRAME_OPTIONS,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: shareHeaders() });
}

function notFound(): Response {
  return json({ error: { code: "link_not_found", message: "Share link is unavailable" } }, 404);
}

function providerOf(slug: string): string {
  const index = slug.indexOf("/");
  return index === -1 ? "" : slug.slice(0, index);
}

function modelPrefixAllows(
  prefix: string | null,
  providerId: string,
  modelId: string,
): boolean {
  return prefix === null || modelId.startsWith(prefix) || `${providerId}/${modelId}`.startsWith(prefix);
}

function modelVision(modalities: unknown): boolean {
  if (typeof modalities !== "object" || modalities === null) return false;
  const input = "input" in modalities ? modalities.input : undefined;
  return Array.isArray(input) && input.includes("image");
}

/** Resolves the models a share recipient may use and their display metadata. */
async function modelsForShare(db: LianRouterDatabase, row: ShareApiKeyRow): Promise<ShareModelAccess[]> {
  const snapshot: ApiKeyAuthorizationSnapshot = {
    api_key_id: row.id,
    tenant_id: row.tenantId,
    provider_allowlist: row.providerAllowlist,
    model_allowlist: row.modelAllowlist,
    model_denylist: row.modelDenylist,
  };
  const providerScope = or(isNull(providers.tenantId), eq(providers.tenantId, row.tenantId));
  const rows = await db
    .select({
      providerId: models.providerId,
      modelId: models.modelId,
      wireFamily: models.wireFamily,
      contextLimit: models.contextLimit,
      outputLimit: models.outputLimit,
      modalities: models.modalities,
      reasoning: models.reasoning,
      toolCall: models.toolCall,
      webSearch: models.webSearch,
      source: models.source,
    })
    .from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models.enabled, true), eq(providers.enabled, true), providerScope));

  const configured = row.modelAllowlist;
  const candidates = configured !== null && configured.length > 0
    ? configured
    : rows.map((entry) => `${entry.providerId}/${entry.modelId}`);
  const allowed = new Set<string>();
  for (const slug of candidates) {
    const providerId = providerOf(slug);
    const modelId = providerId === "" ? slug : slug.slice(providerId.length + 1);
    if (!isProviderAllowed(snapshot, providerId)) continue;
    if (!isModelAllowed(snapshot, modelId, providerId || undefined, slug)) continue;
    if (!modelPrefixAllows(row.modelPrefix, providerId, modelId)) continue;
    allowed.add(slug);
  }
  return [...allowed]
    .sort((left, right) => left.localeCompare(right))
    .map((slug) => {
      const requestedProvider = providerOf(slug);
      const requestedModel = requestedProvider === "" ? slug : slug.slice(requestedProvider.length + 1);
      const matching = rows.filter((entry) =>
        entry.modelId === requestedModel &&
        (requestedProvider === "" || entry.providerId === requestedProvider)
      );
      const first = matching[0];
      const providerId = requestedProvider || first?.providerId || "custom";
      return {
        id: slug,
        providerId,
        modelId: requestedModel,
        wireFamily: first?.wireFamily ?? "chat",
        contextLimit: matching.reduce<number | null>(
          (highest, entry) => entry.contextLimit === null ? highest : Math.max(highest ?? 0, entry.contextLimit),
          null,
        ),
        outputLimit: matching.reduce<number | null>(
          (highest, entry) => entry.outputLimit === null ? highest : Math.max(highest ?? 0, entry.outputLimit),
          null,
        ),
        reasoning: matching.some((entry) => entry.reasoning),
        toolCall: matching.some((entry) => entry.toolCall),
        vision: matching.some((entry) => modelVision(entry.modalities)),
        webSearch: matching.some((entry) => entry.webSearch),
        source: first?.source ?? null,
      };
    });
}


/** Creates the public enrollment page and one-time shared-key issuance route. */
export function createShareRouter(options: ShareRouterOptions): Elysia {
  const { db, shareStore } = options;

  return new Elysia()
    .get("/share/:token/data", async ({ params, request }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const tokenHash = hashShareToken(token);
      const row = await shareStore.getApiKeyByShareToken(tokenHash);
      if (row === null) return notFound();

      const clientIp = options.resolveClientIp(request);
      const clientIpKey = clientIp === null ? undefined : canonicalClientIpKey(clientIp);
      const [shareModels, activeChild, activity] = await Promise.all([
        modelsForShare(db, row),
        clientIpKey === undefined ? null : shareStore.getActiveSharedKeyForIp(clientIpKey, row.id),
        options.shareActivity.getPublicShareActivity(row.tenantId, row.id),
      ]);
      const alreadyIssued = activeChild !== null;
      void shareStore.touchView(tokenHash).catch(() => undefined);
      return json({
        name: row.name,
        keyPrefix: row.keyPrefix,
        // The base URL a recipient should point their client at. Behind a
        // tunnel or reverse proxy the page's own origin is the proxy's
        // address, so a console-started tunnel wins, then the
        // operator-configured value. `null` means "use the origin you loaded
        // this page from".
        apiBaseUrl: resolveEffectivePublicBaseUrl() ?? null,
        canIssue: clientIpKey !== undefined && !alreadyIssued,
        alreadyIssued,
        // Drives the locked-out page's copy: a child without stored ciphertext
        // cannot be re-revealed, so auto-recovery would spin forever.
        recoverable: activeChild?.recoverable === true,
        dailyLimit: row.dailyTokenLimit,
        monthlyLimit: row.monthlyTokenLimit,
        oneTimeLimit: row.lifetimeTokenBudget,
        requestsPerMinute: row.requestsPerMinute,
        maxConcurrentRequests: row.maxConcurrentRequests,
        providerAllowlist: row.providerAllowlist,
        modelPrefix: row.modelPrefix,
        models: shareModels,
        // An empty resolved list means the template grants no model at all.
        // Distinguish "the template asked for specific models and none of them
        // survived the provider allowlist" from "the template grants nothing
        // specific", so the page can name the misconfiguration instead of
        // implying open access. The recipient cannot use any model either way,
        // and issuing a key they cannot spend is worse than saying so.
        policyConflict:
          shareModels.length === 0 && row.modelAllowlist !== null && row.modelAllowlist.length > 0,
        modelDenylist: row.modelDenylist,
        notes: {
          title: row.notesTitle,
          subtitle: row.notesSubtitle,
          body: row.notesBody,
        },
        expiresAt: row.expiresAt,
        activity,
      });
    })
    .post("/share/:token/issue", async ({ params, request, set }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const clientIp = options.resolveClientIp(request);
      if (clientIp === null)
        return json({ error: { code: "client_ip_unavailable", message: "Client IP is unavailable" } }, 503);
      const clientIpKey = canonicalClientIpKey(clientIp);
      if (clientIpKey === undefined)
        return json({ error: { code: "client_ip_invalid", message: "Client IP could not be normalized" } }, 400);
      const body: unknown = await request.json().catch(() => undefined);
      const deviceKey = parseDeviceKey(body);
      if (deviceKey === undefined)
        return json(
          { error: { code: "device_id_required", message: "A stable enrollment deviceId is required" } },
          400,
        );

      const tokenHash = hashShareToken(token);
      const template = await shareStore.getApiKeyByShareToken(tokenHash);
      if (template === null) return notFound();
      const generated = generateApiKeySecret(template.keyPrefix ?? undefined);
      const issued = await shareStore.issueSharedApiKey(tokenHash, {
        keyHash: generated.hash,
        keyPrefix: generated.prefix,
        clientIp,
        clientIpKey,
        keyEncrypted: encryptCredential(generated.secret),
        deviceKey,
      });
      if (issued.kind === "link_unavailable") return notFound();
      if (issued.kind === "ip_limit") {
        return json(
          { error: { code: "shared_key_ip_limit", message: "This IP address already has an active shared API key" } },
          409,
        );
      }
      set.status = 201;
      return json({
        key: generated.secret,
        keyId: issued.apiKeyId,
        keyPrefix: issued.keyPrefix,
        createdAt: issued.createdAt.toISOString(),
      }, 201);
    })
    .post("/share/:token/reveal", async ({ params, request }) => {
      if (typeof params.token !== "string") return notFound();
      const token = params.token;
      if (token.length < MIN_TOKEN_LENGTH) return notFound();
      const clientIp = options.resolveClientIp(request);
      // Fail closed on an unusable client identity: a reveal that cannot
      // compare the caller's canonical IP against the issued row must not
      // fall back to device matching alone.
      if (clientIp === null)
        return json({ error: { code: "client_ip_unavailable", message: "Client IP is unavailable" } }, 503);
      const clientIpKey = canonicalClientIpKey(clientIp);
      if (clientIpKey === undefined)
        return json({ error: { code: "client_ip_invalid", message: "Client IP could not be normalized" } }, 400);
      const body: unknown = await request.json().catch(() => undefined);
      const deviceKey = parseDeviceKey(body);
      if (deviceKey === undefined)
        return json({ error: { code: "device_id_required", message: "A stable enrollment deviceId is required" } }, 400);

      const tokenHash = hashShareToken(token);
      const found = await shareStore.revealSharedKeyForDevice(tokenHash, clientIpKey, deviceKey);
      if (found === null)
        return json(
          { error: { code: "reveal_unavailable", message: "No recoverable key is bound to this device and IP" } },
          404,
        );
      return json({ key: decryptCredentialToString(found.ciphertext) });
    }) as unknown as Elysia;
}
