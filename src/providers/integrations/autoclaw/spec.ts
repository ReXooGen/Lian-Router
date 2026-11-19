import type { ProviderDispatchContext } from "../../provider-registry";
import type { CanonicalRequest, ContentPart } from "../../../transport/canonical-model";
import type { ApiKeyProviderSpec } from "../configured-provider";
import type { ModelDefinition } from "../../provider-registry";
import { defineModel } from "../../model-definition";

const AUTOCLAW_PROVIDER_ID = "autoclaw" as const;

/** The client gateway origin, shared by the completion wire and the catalog. */
const AUTOCLAW_BASE_ORIGIN = "https://autoglm-api.autoglm.ai";

/**
 * The completion path.
 *
 * Stated once because it is not the family default: an `ApiKeyProviderSpec`
 * endpoint override only applies to rows the spec builds, and a catalog row
 * without an explicit `endpoint` falls back to `defineModel`'s `/chat/completions`
 * — which joins into `/v1/chat/completions` on this base and answers 404 while
 * the probe reports a healthy account as broken.
 */
const AUTOCLAW_CHAT_PATH = "/autoclaw-proxy/proxy/autoclaw/chat/completions";

/**
 * AutoClaw — the desktop client's own completion gateway.
 *
 * The wire is the client's, not a published API: `POST /autoclaw-proxy/proxy/
 * autoclaw/chat/completions` on `autoglm-api.autoglm.ai`, carrying the account
 * JWT in `X-Authorization` rather than `Authorization`. A request without a
 * live JWT answers `401 {"error":"Invalid token"}` before any model work
 * happens (verified live).
 *
 * Two header groups are required, and they answer different questions:
 *
 *  - **App authentication** (`X-Auth-Appid` / `X-Auth-TimeStamp` / `X-Auth-Sign`)
 *    proves the caller is the AutoClaw client at all. The signature is an MD5
 *    over `appid&timestamp&appkey`, so it is a fixed public constant of the
 *    shipped client — not a per-account secret, and not something a deployment
 *    configures.
 *  - **Client identity** (`X-Version`, `X-Tm`, `X-Product`, `X-Channel`, `X-Lang`,
 *    `X-Client-Type`) describes which build is calling. `X-Tm` carries the
 *    platform, and the vendor's own analysis reports foreign harness signatures
 *    being answered with a bare `406`.
 *
 * `X-Request-Model` repeats the model id; the client sends it on every
 * completion and the gateway reads the model from there.
 *
 * The account's JWT is the credential. It is long-lived but not permanent, so a
 * deployment must be able to replace it without re-registering the account.
 */

/** The shipped client's public app credentials. */
export const AUTOCLAW_APP_ID = "100003";
export const AUTOCLAW_APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";

/**
 * Client build the identity headers claim.
 *
 * Pinned rather than discovered: lianrouter has no installed AutoClaw app to
 * read a version from. A pin is the honest minimum — the gateway accepts it
 * today — but it is the field most likely to need raising after a client
 * release, and the one to change first if completions start answering 406.
 */
export const AUTOCLAW_CLIENT_VERSION = "1.17.9";

/** Identity product/channel/system the shipped client declares. */
const AUTOCLAW_PRODUCT = "autoclaw";
const AUTOCLAW_CHANNEL = "official";

function md5Hex(value: string): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(value);
  return hasher.digest("hex");
}

/**
 * The app-level signature. `now` is injectable so a test can pin the digest
 * instead of racing the clock.
 */
export function autoClawAppSignature(appId: string, timestamp: string, appKey: string): string {
  return md5Hex(`${appId}&${timestamp}&${appKey}`);
}

/** Platform token the client sends in `X-Tm`. */
function autoClawPlatformToken(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "win" : "linux";
}

/**
 * The account JWT, read from the stored credential.
 *
 * The credential may be a bare JWT or the store's JSON envelope, and either may
 * already carry the `Bearer ` prefix the wire wants.
 */
function autoClawToken(context: ProviderDispatchContext): string {
  const secret = context.credential.secret;
  if (!secret || secret.length === 0) return "";
  const raw = new TextDecoder().decode(secret).trim();
  let token = raw;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed["accessToken"] ?? parsed["token"];
      if (typeof value === "string") token = value.trim();
    } catch {
      // A malformed envelope falls through to the raw string so upstream
      // answers a typed 401 instead of the adapter inventing a local error.
    }
  }
  if (token.length === 0) return "";
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

/** Headers shared by every AutoClaw call, signature included. */
export function autoClawAppHeaders(
  nowSeconds: number = Math.floor(Date.now() / 1000),
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const timestamp = String(nowSeconds);
  return {
    // `accept` is load-bearing, not a courtesy. Without an explicit value the
    // runtime's own default reaches the gateway and it answers a 405 HTML page
    // before reading the body (verified: the same request answers 401
    // `{"error":"Invalid token"}` with `accept: */*` and 405 without it).
    accept: "*/*",
    "user-agent": `AutoClaw/${AUTOCLAW_CLIENT_VERSION}`,
    "x-auth-appid": AUTOCLAW_APP_ID,
    "x-auth-timestamp": timestamp,
    "x-auth-sign": autoClawAppSignature(AUTOCLAW_APP_ID, timestamp, AUTOCLAW_APP_KEY),
    "x-version": AUTOCLAW_CLIENT_VERSION,
    "x-tm": autoClawPlatformToken(platform),
    "x-product": AUTOCLAW_PRODUCT,
    "x-channel": AUTOCLAW_CHANNEL,
    "x-lang": "en",
    "x-client-type": "pc",
  };
}

/**
 * The system-prompt banner the 2.x gateway allowlists.
 *
 * Not decoration and not a prompt: the overseas host refuses to route a
 * completion unless the request's `system` message opens with this exact
 * string, and answers a bare `406` with an empty body when it does not. Measured
 * 2026-11-12 against the live host: no `system` -> 406, this banner as `system`
 * -> 200, the same bytes folded into a `user` message -> 406. It is one line in
 * the shipped 2.x client, so one line here.
 *
 * This is the single field most likely to change with a client release: if
 * completions start answering 406 with a healthy token, re-read it from the
 * installed app before touching anything else.
 */
const AUTOCLAW_SYSTEM_BANNER = "You are AutoClaw. Answer the user directly and concisely.";

/** Per-dispatch headers: the app signature plus this account's JWT. */
function autoClawHeaders(
  context: ProviderDispatchContext,
  request?: CanonicalRequest,
): Record<string, string> {
  const headers = autoClawAppHeaders();
  const token = autoClawToken(context);
  if (token.length > 0) headers["x-authorization"] = token;
  // The gateway reads the model from this header rather than the body.
  if (request?.model && request.model.length > 0) headers["x-request-model"] = request.model;
  return headers;
}

/**
 * Fallback catalog.
 *
 * Mirrors the live `autoclaw-model-config` answer (verified 2026-11-12): five
 * rows, two of them vision-capable, all on a 1M context. It is a fallback, not
 * the catalog — `discoverAutoClawModels` reads the live list — and it exists so
 * an account works before a discovery pass has run.
 *
 * `outputLimit` is the gateway's own `maxTokens`, not a guess: the client
 * renders the composer from that field, and a catalog that under-reports it
 * makes the console refuse a request the gateway would have accepted.
 */
export const AUTOCLAW_FALLBACK_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "zai_auto",
    providerId: "autoclaw",
    endpoint: AUTOCLAW_CHAT_PATH,
    ctx: 1_048_576,
    out: 131_072,
    vision: true,
    reasoning: true,
  }),
  defineModel({
    id: "zai_auto-fast",
    providerId: "autoclaw",
    endpoint: AUTOCLAW_CHAT_PATH,
    ctx: 1_048_576,
    out: 393_216,
    vision: true,
    reasoning: true,
  }),
  defineModel({
    id: "zaicoding_glm-5.3",
    providerId: "autoclaw",
    endpoint: AUTOCLAW_CHAT_PATH,
    ctx: 1_048_576,
    out: 307_200,
    reasoning: true,
  }),
  defineModel({
    id: "zai_glm-5.3-flash",
    providerId: "autoclaw",
    endpoint: AUTOCLAW_CHAT_PATH,
    ctx: 1_048_576,
    out: 131_072,
    vision: true,
    reasoning: true,
  }),
  defineModel({
    id: "zai_glm-5.3-flashx-legal",
    providerId: "autoclaw",
    endpoint: AUTOCLAW_CHAT_PATH,
    ctx: 1_048_576,
    out: 307_200,
    vision: true,
    reasoning: true,
  }),
];

/**
 * Prepends the allowlisted banner, keeping one `system` message.
 *
 * Runs on the canonical request rather than the wire payload so it applies to
 * every caller — dispatch, probe, and discovery — instead of only the paths
 * that happen to serialize a system prompt themselves. A request that already
 * carries the banner is left alone, and a caller's own system text rides after
 * it rather than being replaced: the gateway only reads the opening.
 */
/**
 * Claims the head `system` turn for the allowlisted banner.
 *
 * The gate reads only the opening system message, so the banner must be the
 * first text on the wire — being present somewhere is not enough. Three callers
 * can put text ahead of it, and each of them was answering a bare `406`:
 *
 *  - `position: prepend` prompt injections, applied to the canonical request
 *    before any adapter sees it;
 *  - the provider's own configured system prompt, which rides in
 *    `request.system` and serializes before `request.messages`;
 *  - `instructions`, which the chat codec emits as `developer` turns.
 *
 * Every one of those is folded behind the banner into a single system turn: the
 * gateway refuses a request carrying two system messages, and dropping the
 * caller's text instead would silently change what they asked for.
 */
function withAutoClawBanner(request: CanonicalRequest): CanonicalRequest {
  const textOf = (parts: readonly ContentPart[] | undefined): string =>
    (parts ?? [])
      .filter((part) => part.kind === "text")
      .map((part) => (part as { text: string }).text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n");

  // Order matters: the codec emits `system`, then `instructions`, then
  // `messages`, so the folded text keeps that order and the caller's own words
  // stay in the sequence they wrote them.
  const carried = [
    textOf(request.system),
    textOf(request.instructions),
    ...request.messages
      .filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => textOf(message.content)),
  ]
    .filter((text) => text.length > 0)
    .join("\n\n");

  const head = carried.startsWith(AUTOCLAW_SYSTEM_BANNER)
    ? carried
    : carried.length === 0
      ? AUTOCLAW_SYSTEM_BANNER
      : `${AUTOCLAW_SYSTEM_BANNER}\n\n${carried}`;

  return {
    ...request,
    system: [],
    instructions: [],
    messages: [
      { role: "system", content: [{ kind: "text", text: head }] },
      ...request.messages.filter(
        (message) => message.role !== "system" && message.role !== "developer",
      ),
    ],
  };
}

export const AUTOCLAW_SPEC: ApiKeyProviderSpec = {
  provider_id: AUTOCLAW_PROVIDER_ID,
  endpoint_paths_by_wire_family: {
    chat: AUTOCLAW_CHAT_PATH,
  },
  supported_wire_families: ["chat"],
  // The JWT rides in `X-Authorization`, not `Authorization`. Leaving the
  // standard header unset keeps the bearer token from being sent twice, which
  // the gateway treats as a malformed request.
  credential_forwarding: "never",
  buildExtraHeaders: autoClawHeaders,
  prepareRequest: withAutoClawBanner,
  /**
   * `max_tokens` is refused by the overseas host.
   *
   * Measured 2026-11-12 on the live gateway with an otherwise-clean request:
   * banner + `max_tokens` -> 406, banner + `max_completion_tokens` -> 200,
   * banner alone -> 200. The 2.x client simply never sends the legacy field,
   * so the same bytes that work for it are the only bytes that work here.
   */
  prePayload: (payload) => {
    delete payload["max_tokens"];
  },
};

/**
 * The live model list, as the desktop client reads it.
 *
 * Two things about this endpoint are load-bearing and were measured, not read:
 *
 *  - It is **not** the completion path. The catalog sits at
 *    `/autoclaw-proxy/proxy/autoclaw-model-config` and answers the account JWT
 *    in the standard `authorization` header — the same token the completion
 *    wire wants in `x-authorization` answers `401 Invalid token` here.
 *  - It reports capability per row (`input`, `reasoning`, `contextWindow`,
 *    `maxTokens`), so the console no longer has to guess which models take an
 *    image. The fallback catalog is a copy of one such answer.
 *
 * A failed read is not an error: discovery reports its own outcome and the
 * caller keeps the fallback rows, because a catalog outage must not take a
 * working account out of service.
 */
const MODEL_CONFIG_PATH = "/autoclaw-proxy/proxy/autoclaw-model-config";

/** One row of the vendor's model-config answer. */
interface AutoClawModelConfigRow {
  readonly id?: unknown;
  readonly input?: unknown;
  readonly reasoning?: unknown;
  readonly contextWindow?: unknown;
  readonly maxTokens?: unknown;
}

/** Reads the account's live model list and maps it onto canonical definitions. */
export async function discoverAutoClawModels(args: {
  readonly credential: string;
  readonly fetcher?: typeof fetch;
}): Promise<readonly ModelDefinition[]> {
  const fetcher = args.fetcher ?? fetch;
  const raw = args.credential.trim();
  let token = raw;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed["accessToken"] ?? parsed["token"];
      if (typeof value === "string") token = value.trim();
    } catch {
      // A malformed envelope falls through to the raw string.
    }
  }
  token = token.replace(/^Bearer\s+/i, "");
  if (token.length === 0) return AUTOCLAW_FALLBACK_MODELS;

  const response = await fetcher(`${AUTOCLAW_BASE_ORIGIN}${MODEL_CONFIG_PATH}`, {
    method: "GET",
    headers: {
      ...autoClawAppHeaders(),
      // Standard header here; the completion wire is the one that wants the
      // `x-` variant. Sending `x-authorization` answers 401 from this route.
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (response === null || !response.ok) return AUTOCLAW_FALLBACK_MODELS;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const rows = Array.isArray(body?.["models"]) ? (body!["models"] as unknown[]) : [];
  const models: ModelDefinition[] = [];
  for (const entry of rows) {
    const row = entry as AutoClawModelConfigRow;
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    const input = Array.isArray(row.input) ? row.input.map(String) : ["text"];
    models.push(
      defineModel({
        id: row.id,
        providerId: "autoclaw",
        endpoint: AUTOCLAW_CHAT_PATH,
        ctx: typeof row.contextWindow === "number" ? row.contextWindow : 1_048_576,
        out: typeof row.maxTokens === "number" ? row.maxTokens : null,
        vision: input.includes("image"),
        reasoning: row.reasoning === true,
      }),
    );
  }
  return models.length > 0 ? models : AUTOCLAW_FALLBACK_MODELS;
}
