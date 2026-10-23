/**
 * Vertex AI adapter.
 *
 * Vertex serves the same `generateContent` / `streamGenerateContent` envelope
 * Gemini does, so this module reuses `buildGeminiPayload` and the Gemini
 * response decoders verbatim. Two things differ, and only two:
 *
 *   1. The path is project-scoped:
 *      `/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:{action}`.
 *      A raw API key may omit the project prefix; a minted Bearer token may not
 *      (upstream answers `RESOURCE_PROJECT_INVALID` without it).
 *   2. The credential is a Google Cloud credential, not an API key header. A
 *      service-account JSON is signed into a JWT assertion and exchanged for a
 *      Bearer token; an `authorized_user` (ADC) JSON refreshes through Google's
 *      OAuth endpoint; a bare key rides `?key=`.
 *
 * Video models are deliberately absent. `veo-*` is `predictLongRunning` +
 * `fetchPredictOperation`, a long-running-operation protocol this repo has no
 * wire family for; registering them as chat rows would advertise a capability
 * dispatch cannot honour.
 */
import { createSign } from "node:crypto";
import { GatewayError } from "../../transport/gateway-error";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import type { CanonicalEvent, CanonicalRequest, CanonicalStopReason } from "../../transport/canonical-model";
import { decodeSseEvents } from "../../transport/streaming";
import { usageFromProvider } from "../usage";
import {
  readCredentialSecret,
  type ProviderDispatchTarget,
  type ModelDefinition,
  type ProviderAdapter,
  type ProviderDispatchContext,
} from "../provider-registry";
import { defineModel } from "../model-definition";
import { providerBaseUrl } from "../provider-metadata";
import { isRecord } from "../../protocol/primitives";
import { createUpstreamDeadlineLifecycle, abortFailure } from "../operations/upstream-deadline";
import { buildGeminiPayload } from "../../protocol/request/gemini";
import {
  decodeGeminiStreamEvent,
  geminiCandidate,
  responseParts,
  mapGeminiUsage,
  toCanonicalStopReason,
} from "../../protocol/response/gemini";

export const VERTEX_PROVIDER_ID = "vertex" as const;
export const VERTEX_BASE_URL = providerBaseUrl(VERTEX_PROVIDER_ID);

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Default region for a project-scoped request. `global` is the multi-region
 * endpoint Google recommends for the current Gemini generation; a model that
 * is regional-only carries its own location in the catalog row's endpoint.
 */
const VERTEX_DEFAULT_LOCATION = "global";

/** Endpoint path every chat row shares; the model id is substituted at dispatch. */
const VERTEX_CHAT_PATH = "/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent" as const;

/**
 * Vertex chat catalog. Only the chat-capable ids from the upstream registry are
 * modelled — the four `veo-*` video ids are excluded (see the module doc).
 * `gemini-4-argon` is served only from the multi-regions (`global`/`us`/`eu`),
 * never a regional location, which is why it pins `global` rather than taking
 * the default.
 */
export const VERTEX_MODELS: readonly ModelDefinition[] = [
  "gemini-4-argon",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
].map((id) =>
  defineModel({
    id,
    endpoint: VERTEX_CHAT_PATH,
    ctx: 1_000_000,
    out: 32_768,
    vision: true,
    reasoning: true,
  }),
);

interface ServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
}

interface AuthorizedUserKey {
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
}

export interface ParsedVertexCredential {
  readonly kind: "service_account" | "authorized_user" | "api_key";
  readonly serviceAccount?: ServiceAccountKey;
  readonly authorizedUser?: AuthorizedUserKey;
  readonly apiKey?: string;
  readonly projectId?: string;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

/**
 * Parses the credential secret. The secret is operator-supplied and untrusted:
 * a malformed JSON object must fall through to the raw-key path rather than
 * throw, because a plain API key is also a valid secret and is not JSON.
 */
export function parseVertexCredential(secret: string): ParsedVertexCredential {
  const trimmed = secret.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { kind: "api_key", apiKey: trimmed };
    }
    if (isRecord(parsed)) {
      const type = parsed["type"];
      if (type === "service_account" && typeof parsed["client_email"] === "string" && typeof parsed["private_key"] === "string") {
        return {
          kind: "service_account",
          serviceAccount: {
            client_email: parsed["client_email"] as string,
            private_key: parsed["private_key"] as string,
          },
          ...(typeof parsed["project_id"] === "string" ? { projectId: parsed["project_id"] as string } : {}),
        };
      }
      if (
        type === "authorized_user" &&
        typeof parsed["client_id"] === "string" &&
        typeof parsed["client_secret"] === "string" &&
        typeof parsed["refresh_token"] === "string"
      ) {
        return {
          kind: "authorized_user",
          authorizedUser: {
            client_id: parsed["client_id"] as string,
            client_secret: parsed["client_secret"] as string,
            refresh_token: parsed["refresh_token"] as string,
          },
          ...(typeof parsed["quota_project_id"] === "string"
            ? { projectId: parsed["quota_project_id"] as string }
            : {}),
        };
      }
    }
  }
  return { kind: "api_key", apiKey: trimmed };
}

/** Signed RS256 assertion for the service-account JWT bearer grant. */
export function buildVertexAssertion(account: ServiceAccountKey, now = Date.now()): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const issuedAt = Math.floor(now / 1000);
  const claims = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: VERTEX_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      exp: issuedAt + 3600,
      iat: issuedAt,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(account.private_key);
  return `${signingInput}.${base64Url(signature)}`;
}

interface VertexAccessToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

/**
 * Access tokens are cached per credential fingerprint. A service-account
 * assertion is valid for an hour, so minting one per request would triple the
 * outbound calls and risk the token endpoint's rate limit.
 */
const VERTEX_TOKEN_TTL_MS = 50 * 60 * 1000;
const VERTEX_MAX_CACHED_TOKENS = 256;
const vertexTokens = new Map<string, VertexAccessToken>();

function cacheToken(key: string, token: VertexAccessToken): void {
  const now = Date.now();
  for (const [candidate, value] of vertexTokens) {
    if (value.expiresAt <= now) vertexTokens.delete(candidate);
  }
  vertexTokens.set(key, token);
  while (vertexTokens.size > VERTEX_MAX_CACHED_TOKENS) {
    const oldest = vertexTokens.keys().next();
    if (oldest.done) break;
    vertexTokens.delete(oldest.value);
  }
}

function cachedToken(secret: string): string | undefined {
  const entry = vertexTokens.get(secret);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    vertexTokens.delete(secret);
    return undefined;
  }
  return entry.accessToken;
}

/** Exchanges a Google credential for a Bearer token. */
export async function mintVertexAccessToken(
  parsed: ParsedVertexCredential,
  secret: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const cached = cachedToken(secret);
  if (cached !== undefined) return cached;

  const form = new URLSearchParams();
  if (parsed.serviceAccount) {
    form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    form.set("assertion", buildVertexAssertion(parsed.serviceAccount));
  } else if (parsed.authorizedUser) {
    form.set("grant_type", "refresh_token");
    form.set("client_id", parsed.authorizedUser.client_id);
    form.set("client_secret", parsed.authorizedUser.client_secret);
    form.set("refresh_token", parsed.authorizedUser.refresh_token);
  } else {
    throw new GatewayError("authentication_failed", 401, "Vertex credential is not a Google service account or ADC JSON");
  }

  const response = await fetcher(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
    signal,
  });
  if (!response.ok) throw await mapUpstreamHttpError(response, VERTEX_PROVIDER_ID);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GatewayError("platform_unavailable", 502, "Vertex token endpoint returned invalid JSON", {}, "upstream");
  }
  if (!isRecord(payload) || typeof payload["access_token"] !== "string") {
    throw new GatewayError("platform_unavailable", 502, "Vertex token endpoint returned no access token", {}, "upstream");
  }
  const accessToken = payload["access_token"] as string;
  cacheToken(secret, { accessToken, expiresAt: Date.now() + VERTEX_TOKEN_TTL_MS });
  return accessToken;
}

/**
 * Builds the project-scoped request URL.
 *
 * A service-account or ADC credential always needs the project prefix. A raw
 * key may use the projectless form, but when the operator supplied a project
 * through the service-account JSON the scoped form is used so the key is
 * attributed to that project rather than whichever one the key defaults to.
 */
export function buildVertexUrl(
  baseUrl: string,
  model: string,
  action: string,
  options: { readonly projectId?: string; readonly location?: string; readonly apiKey?: string },
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const location = options.location ?? VERTEX_DEFAULT_LOCATION;
  const modelPath = encodeURIComponent(model);
  const url =
    options.projectId !== undefined
      ? `${base}/v1/projects/${encodeURIComponent(options.projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${modelPath}:${action}`
      : `${base}/v1/publishers/google/models/${modelPath}:${action}`;
  return options.apiKey !== undefined ? `${url}?key=${encodeURIComponent(options.apiKey)}` : url;
}

export interface VertexAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  /** Overrides the catalog default location; an operator may pin a region. */
  readonly location?: string;
}

class VertexAdapter implements ProviderAdapter {
  readonly provider_id = VERTEX_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly location: string | undefined;

  constructor(options: VertexAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? VERTEX_BASE_URL).replace(/\/+$/, "");
    this.location = options.location;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat" && candidate.wire_family !== "responses" && candidate.wire_family !== "messages") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `vertex supports chat/responses/messages, got ${candidate.wire_family}`,
      );
    }
    const secret = readCredentialSecret(context.credential, "Vertex credential is required");
    const parsed = parseVertexCredential(secret);

    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const lifecycle = createUpstreamDeadlineLifecycle(context);

    try {
      let apiKey: string | undefined;
      let bearer: string | undefined;
      if (parsed.kind === "api_key") {
        apiKey = parsed.apiKey;
      } else {
        bearer = await mintVertexAccessToken(parsed, secret, outboundFetch, lifecycle.signal);
      }

      const model = candidate.model_id || request.model;
      const action = request.stream ? "streamGenerateContent" : "generateContent";
      const baseUrl = buildVertexUrl(this.baseUrl, model, action, {
        ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
        ...(this.location !== undefined ? { location: this.location } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
      // `?alt=sse` is what makes `streamGenerateContent` emit SSE framing at
      // all; without it the upstream returns a JSON array.
      const url = request.stream ? `${baseUrl}&alt=sse` : baseUrl;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
      };
      if (bearer !== undefined) headers["authorization"] = `Bearer ${bearer}`;

      const response = await outboundFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(buildGeminiPayload(request)),
        signal: lifecycle.signal,
      });
      if (!response.ok) throw await mapUpstreamHttpError(response, VERTEX_PROVIDER_ID);

      // Headers arrived: the pre-stream deadline has served its purpose. The
      // gateway stall/first-chunk watchdog governs the body from here.
      lifecycle.release();

      if (!request.stream) {
        const json = (await response.json()) as Record<string, unknown>;
        const { candidate: cand, parts } = geminiCandidate(json);
        const output = responseParts(parts);
        let seq = 1;
        yield { type: "response_start", sequence_number: seq++, model: request.model } as CanonicalEvent;
        if (output.thought) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "reasoning", payload: null, summary: output.thought },
          } as CanonicalEvent;
        }
        if (output.text) {
          yield { type: "content_delta", sequence_number: seq++, content: { kind: "text", text: output.text } } as CanonicalEvent;
        }
        for (const call of output.calls) {
          yield {
            type: "tool_call_delta",
            sequence_number: seq++,
            call_id: call.id,
            name: call.name,
            arguments_delta: JSON.stringify(call.args),
          } as CanonicalEvent;
        }
        yield {
          type: "terminal",
          sequence_number: seq++,
          state: "complete",
          stop_reason: toCanonicalStopReason(cand, output.calls.length),
          ...(typeof cand["finishReason"] === "string" ? { provider_stop_reason: cand["finishReason"] as string } : {}),
          usage: usageFromProvider(mapGeminiUsage(json)),
        } as CanonicalEvent;
        return;
      }

      if (!response.body) throw new GatewayError("platform_unavailable", 502, "Vertex returned empty stream", {}, "upstream");
      let seq = 1;
      yield { type: "response_start", sequence_number: seq++, model: request.model } as CanonicalEvent;
      const activeCalls = new Set<string>();
      let rawUsage: Record<string, unknown> | undefined;
      let finishReason: string | undefined;
      let outputCalls = 0;
      for await (const sse of decodeSseEvents(response.body as ReadableStream<Uint8Array>, { signal: lifecycle.signal })) {
        const data = sse.data.trim();
        if (!data || data === "[DONE]") continue;
        const parsedEvent = decodeGeminiStreamEvent(data, "Vertex stream error");
        if (parsedEvent === undefined) continue;
        const { candidate: cand, parts } = geminiCandidate(parsedEvent);
        const output = responseParts(parts);
        if (output.thought) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "reasoning", payload: null, summary: output.thought },
          } as CanonicalEvent;
        }
        if (output.text) {
          yield { type: "content_delta", sequence_number: seq++, content: { kind: "text", text: output.text } } as CanonicalEvent;
        }
        for (const call of output.calls) {
          if (!activeCalls.has(call.id)) {
            activeCalls.add(call.id);
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              call_id: call.id,
              name: call.name,
              arguments_delta: "",
            } as CanonicalEvent;
          }
          const argsText = JSON.stringify(call.args);
          if (argsText !== "{}") {
            yield {
              type: "tool_call_delta",
              sequence_number: seq++,
              call_id: call.id,
              arguments_delta: argsText,
            } as CanonicalEvent;
          }
          outputCalls++;
        }
        if (isRecord(parsedEvent["usageMetadata"])) rawUsage = parsedEvent["usageMetadata"] as Record<string, unknown>;
        if (typeof cand["finishReason"] === "string") finishReason = cand["finishReason"] as string;
      }

      const stopMap: Record<string, CanonicalStopReason> = {
        MAX_TOKENS: "length",
        STOP: "stop",
        SAFETY: "content_filter",
      };
      const stopReason: CanonicalStopReason = finishReason
        ? (stopMap[finishReason] ?? (outputCalls > 0 ? "tool_use" : "stop"))
        : outputCalls > 0
          ? "tool_use"
          : "stop";
      // No finishReason means the stream ended without a terminal chunk:
      // truncated, never complete.
      const truncated = finishReason === undefined;
      const usageRec = usageFromProvider(rawUsage ? mapGeminiUsage({ usageMetadata: rawUsage }) : undefined);
      yield {
        type: "terminal",
        sequence_number: seq++,
        state: truncated ? "failed" : context.abort_signal.aborted ? "aborted" : "complete",
        stop_reason: stopReason,
        ...(finishReason !== undefined ? { provider_stop_reason: finishReason } : {}),
        usage: usageRec,
      } as CanonicalEvent;
    } catch (err: unknown) {
      if (err instanceof GatewayError) throw err;
      const failure = abortFailure(lifecycle.signal, err);
      if (failure) throw failure;
      throw err;
    } finally {
      lifecycle.release();
    }
  }
}

export function createVertexAdapter(options: VertexAdapterOptions = {}): ProviderAdapter {
  return new VertexAdapter(options);
}
