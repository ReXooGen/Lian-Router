/**
 * Xiaomi MiMo free channel (`mimo-free`, and its `mmf` alias row).
 *
 * The endpoint is public but not openly callable: it is gated on a request
 * fingerprint, and the gate is enforced in three separate places, all of which
 * this module reproduces because dropping any one yields 403 "Illegal access":
 *
 *   1. A browser `User-Agent` — the edge rejects non-Chrome agents.
 *   2. A `POST /api/free-ai/bootstrap` exchange that trades a stable per-host
 *      client fingerprint for a short-lived JWT. There is no operator key: the
 *      credential is the fingerprint itself, minted here.
 *   3. A system message carrying the MiMoCode CLI signature, plus the
 *      `x-mimo-source` / `x-session-affinity` headers.
 *
 * The JWT is cached per process and re-minted on the first 401/403, which is
 * what keeps a long-lived gateway from re-bootstrapping on every request.
 *
 * The upstream declares exactly one model id, `mimo-auto`; it is copied
 * verbatim. No limits are declared — the upstream publishes none.
 */
import { createHash } from "node:crypto";
import { hostname, platform, arch, cpus, userInfo } from "node:os";
import { GatewayError } from "../../transport/gateway-error";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import type { CanonicalEvent, CanonicalRequest } from "../../transport/canonical-model";
import { canonicalToChatPayload } from "../../protocol/request/chat";
import { decodeWireResponse, decodeWireStream } from "../../protocol/registry";
import { joinUrl } from "../../protocol/primitives";
import type {
  ModelDefinition,
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
} from "../provider-registry";
import { defineModel } from "../model-definition";
import { providerBaseUrl } from "../provider-metadata";

export type MimoFreeProviderId = "mimo-free" | "mmf";

/** Bootstrap and chat share one origin; only the path differs. */
const MIMO_FREE_ORIGIN = new URL(providerBaseUrl("mimo-free"));
const MIMO_BOOTSTRAP_URL = `${MIMO_FREE_ORIGIN.origin}/api/free-ai/bootstrap`;
const MIMO_CHAT_PATH = "/api/free-ai/openai/chat";

/** The signature substring the gate looks for in a system message. */
const MIMO_SYSTEM_MARKER =
  "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";

/**
 * The edge rejects requests whose `User-Agent` is not a browser agent with
 * 403 "Illegal access". One current Chrome string is enough: the gate checks
 * the shape, and rotating it per request buys nothing while making a cached
 * failure harder to reproduce.
 */
const MIMO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MIMO_JWT_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const MIMO_SESSION_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Stable per-host client identity for the bootstrap exchange. Derived from
 * machine facts rather than random so a restart keeps the same identity and
 * does not look like a new client to the anti-abuse gate.
 */
function mimoFingerprint(): string {
  let username = "unknown-user";
  try {
    username = userInfo().username;
  } catch {
    // A container without a passwd entry is a normal deployment, not an error.
  }
  const cpu = (cpus()[0]?.model ?? "unknown-cpu").trim();
  return createHash("sha256")
    .update(`${hostname()}|${platform()}|${arch()}|${cpu}|${username}`)
    .digest("hex");
}

function mimoSessionId(): string {
  let id = "ses_";
  for (let index = 0; index < 24; index += 1) {
    id += MIMO_SESSION_CHARS[Math.floor(Math.random() * MIMO_SESSION_CHARS.length)];
  }
  return id;
}

interface CachedJwt {
  readonly token: string;
  readonly expiresAt: number;
}

const mimoJwts = new Map<string, CachedJwt>();

function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64").toString()) as unknown;
    const exp = (payload as Record<string, unknown> | null)?.["exp"];
    if (typeof exp === "number") return exp * 1000;
  } catch {
    // An opaque token carries no readable expiry; fall through to the TTL.
  }
  return Date.now() + 50 * 60 * 1000;
}

async function bootstrapMimoJwt(fetcher: typeof fetch, signal: AbortSignal): Promise<string> {
  const key = mimoFingerprint();
  const cached = mimoJwts.get(key);
  if (cached !== undefined && cached.expiresAt - MIMO_JWT_EXPIRY_BUFFER_MS > Date.now()) return cached.token;

  const response = await fetcher(MIMO_BOOTSTRAP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": MIMO_USER_AGENT,
    },
    body: JSON.stringify({ client: key }),
    signal,
  });
  if (!response.ok) throw await mapUpstreamHttpError(response, "mimo-free");
  const body: unknown = await response.json();
  const token = (body as Record<string, unknown> | null)?.["jwt"];
  if (typeof token !== "string" || token.length === 0) {
    throw new GatewayError("platform_unavailable", 502, "MiMo bootstrap returned no JWT", {}, "upstream");
  }
  mimoJwts.set(key, { token, expiresAt: jwtExpiry(token) });
  return token;
}

/** Injects the CLI signature unless the caller already sent one. */
function withMimoMarker(payload: Record<string, unknown>): Record<string, unknown> {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return payload;
  const present = messages.some(
    (message) =>
      (message as Record<string, unknown> | null)?.["role"] === "system" &&
      typeof (message as Record<string, unknown>)["content"] === "string" &&
      ((message as Record<string, unknown>)["content"] as string).includes(MIMO_SYSTEM_MARKER),
  );
  if (present) return payload;
  return { ...payload, messages: [{ role: "system", content: MIMO_SYSTEM_MARKER }, ...messages] };
}

/**
 * One static row per provider id, both naming the single id the upstream
 * publishes. `free` is a tier fact — the channel bills nothing.
 */
export function mimoFreeModels(providerId: MimoFreeProviderId): readonly ModelDefinition[] {
  return [defineModel({ id: "mimo-auto", providerId, free: true, reasoning: true })];
}

export const MIMO_FREE_MODELS: readonly ModelDefinition[] = mimoFreeModels("mimo-free");
export const MMF_MODELS: readonly ModelDefinition[] = mimoFreeModels("mmf");

export interface MimoFreeAdapterOptions {
  readonly fetch?: typeof fetch;
}

class MimoFreeAdapter implements ProviderAdapter {
  readonly provider_id: MimoFreeProviderId;
  private readonly fetchFn: typeof fetch;
  private readonly sessionId = mimoSessionId();

  constructor(providerId: MimoFreeProviderId, options: MimoFreeAdapterOptions = {}) {
    this.provider_id = providerId;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `${this.provider_id} supports chat only, got ${candidate.wire_family}`,
      );
    }
    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const payload = withMimoMarker(canonicalToChatPayload(request));
    const url = joinUrl(MIMO_FREE_ORIGIN.origin, MIMO_CHAT_PATH);

    const send = async (token: string): Promise<Response> =>
      outboundFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: request.stream ? "text/event-stream" : "application/json",
          authorization: `Bearer ${token}`,
          "x-mimo-source": "mimocode-cli-free",
          "x-session-affinity": this.sessionId,
          "user-agent": MIMO_USER_AGENT,
        },
        body: JSON.stringify(payload),
        signal: context.abort_signal,
      });

    let token = await bootstrapMimoJwt(outboundFetch, context.abort_signal);
    let response = await send(token);
    if (response.status === 401 || response.status === 403) {
      // The gate rejected the cached JWT; a fresh bootstrap is the only retry
      // worth making, and it happens before any byte reaches the client.
      mimoJwts.delete(mimoFingerprint());
      token = await bootstrapMimoJwt(outboundFetch, context.abort_signal);
      response = await send(token);
    }

    if (!response.ok) throw await mapUpstreamHttpError(response, this.provider_id);
    if (request.stream && response.body !== null) {
      yield* decodeWireStream("chat", response.body, request, { signal: context.abort_signal });
      return;
    }
    const json = (await response.json()) as Record<string, unknown>;
    yield* decodeWireResponse("chat", json, request);
  }
}

export function createMimoFreeAdapter(options: MimoFreeAdapterOptions = {}): ProviderAdapter {
  return new MimoFreeAdapter("mimo-free", options);
}

export function createMmfAdapter(options: MimoFreeAdapterOptions = {}): ProviderAdapter {
  return new MimoFreeAdapter("mmf", options);
}
