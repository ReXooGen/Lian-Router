/**
 * Zed hosted LLM adapter.
 *
 * Zed's cloud is a multi-format proxy, so this cannot be a declarative
 * OpenAI-compatible spec. Three things are provider-specific:
 *
 *   1. **Auth is a two-hop exchange.** The credential holds the native-app
 *      `user_id` + `access_token`; `/client/llm_tokens` trades them for a
 *      short-lived LLM bearer. The user-token header is the non-standard
 *      `<user_id> <access_token>`, not `Bearer`.
 *   2. **The request is an envelope, not a chat body.** `{thread_id, prompt_id,
 *      provider, model, provider_request}`, where `provider_request` is the
 *      body of whichever upstream Zed fronts for that model (Anthropic, Gemini,
 *      OpenAI Responses, or OpenAI chat for xAI).
 *   3. **The response is NDJSON, not SSE.** Each line is `{"event": <chunk>}`,
 *      `{"status": …}`, or `[DONE]`, and the chunk is provider-shaped.
 *
 * The provider-shaped chunk is decoded by re-framing it as an SSE `data:` line
 * for the matching wire codec, so the per-provider translation stays in
 * `src/protocol/` rather than being reimplemented here.
 */
import { GatewayError } from "../../transport/gateway-error";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import type { CanonicalEvent, CanonicalRequest } from "../../transport/canonical-model";
import { canonicalToChatPayload } from "../../protocol/request/chat";
import { canonicalToResponsesPayload } from "../../protocol/request/responses";
import { canonicalToClaudeMessagesPayload } from "../../protocol/request/messages";
import { buildGeminiPayload } from "../../protocol/request/gemini";
import { decodeWireStream } from "../../protocol/registry";
import { isRecord, joinUrl } from "../../protocol/primitives";
import { postUpstreamJson } from "../../protocol/transport/openai";
import {
  readCredentialSecret,
  type ModelDefinition,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
} from "../provider-registry";
import { defineModel } from "../model-definition";
import { providerBaseUrl } from "../provider-metadata";
import type { DiscoveryInput } from "../discovery/discovery-types";

export const ZED_PROVIDER_ID = "zed" as const;
export const ZED_BASE_URL = providerBaseUrl(ZED_PROVIDER_ID);

/** Zed fronts a rotating catalog; the static list is empty by construction. */
export const ZED_MODELS: readonly ModelDefinition[] = [];

/**
 * `provider` values `cloud.zed.dev` matches exactly. An unrecognized value
 * fails the whole request before the model is read, so the mapping is total.
 */
type ZedUpstream = "anthropic" | "open_ai" | "google" | "x_ai";

const ZED_UPSTREAM_BY_WIRE: Readonly<Record<ZedUpstream, "messages" | "responses" | "chat">> = {
  anthropic: "messages",
  open_ai: "responses",
  google: "chat",
  x_ai: "chat",
};

/** LLM bearer lifetime; refreshed well before the hour the endpoint grants. */
const ZED_LLM_TOKEN_TTL_MS = 50 * 60 * 1000;
const ZED_MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

export interface ZedCredential {
  readonly userId: string;
  readonly accessToken: string;
  /** Organization the LLM token is scoped to; resolved from `/client/users/me` when absent. */
  readonly organizationId?: string;
  /** Zed client system id, forwarded when the credential carries one. */
  readonly systemId?: string;
}

/**
 * Parses the native-app credential. Zed's own login hands the browser a
 * `user_id` and an RSA-encrypted `access_token`; the operator pastes the
 * decrypted pair, so this reads the two fields and nothing else.
 */
export function parseZedCredential(raw: string): ZedCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new GatewayError(
      "authentication_failed",
      401,
      'Zed requires a JSON credential: {"userId": "…", "accessToken": "…"}',
    );
  }
  if (!isRecord(parsed)) {
    throw new GatewayError("authentication_failed", 401, "Zed credential must be a JSON object");
  }
  const userId = parsed["userId"] ?? parsed["user_id"];
  const accessToken = parsed["accessToken"] ?? parsed["access_token"];
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new GatewayError("authentication_failed", 401, "Zed credential is missing userId");
  }
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new GatewayError("authentication_failed", 401, "Zed credential is missing accessToken");
  }
  const organizationId = parsed["organizationId"] ?? parsed["organization_id"];
  const systemId = parsed["systemId"] ?? parsed["system_id"];
  return {
    userId: userId.trim(),
    accessToken: accessToken.trim(),
    ...(typeof organizationId === "string" && organizationId.trim().length > 0
      ? { organizationId: organizationId.trim() }
      : {}),
    ...(typeof systemId === "string" && systemId.trim().length > 0 ? { systemId: systemId.trim() } : {}),
  };
}

/** The non-standard user-token header Zed's cloud reads. */
export function zedUserAuthHeader(credential: ZedCredential): string {
  return `${credential.userId} ${credential.accessToken}`;
}

/** `provider` field for a model, resolved from the live catalog then the id. */
export function zedUpstreamFor(provider: unknown, model: string): ZedUpstream {
  const raw = typeof provider === "string" ? provider.toLowerCase() : "";
  if (raw === "anthropic") return "anthropic";
  if (raw === "openai" || raw === "open_ai") return "open_ai";
  if (raw === "google" || raw === "gemini") return "google";
  if (raw === "xai" || raw === "x_ai" || raw === "x-ai") return "x_ai";
  const id = model.toLowerCase();
  if (id.includes("claude")) return "anthropic";
  if (id.includes("gemini")) return "google";
  if (id.includes("grok") || id.includes("xai")) return "x_ai";
  return "open_ai";
}

interface CachedLlmToken {
  readonly token: string;
  readonly expiresAt: number;
}

const llmTokens = new Map<string, CachedLlmToken>();

interface CachedModelCatalog {
  readonly providerById: ReadonlyMap<string, string>;
  readonly expiresAt: number;
}

const modelCatalogs = new Map<string, CachedModelCatalog>();

function zedCacheKey(credential: ZedCredential, organizationId: string): string {
  // The token is the identity: two accounts on one host must not share a
  // cached bearer, and the trailing slice is enough to separate them without
  // keeping the whole secret in a map key.
  return `${credential.userId}:${organizationId}:${credential.accessToken.slice(-16)}`;
}

async function fetchZedOrganizationId(
  credential: ZedCredential,
  baseUrl: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: zedUserAuthHeader(credential),
  };
  if (credential.systemId !== undefined) headers["x-zed-system-id"] = credential.systemId;
  const response = await fetcher(joinUrl(baseUrl, "/client/users/me"), { headers, signal });
  if (!response.ok) throw await mapUpstreamHttpError(response, ZED_PROVIDER_ID);
  const body: unknown = await response.json();
  const explicit = isRecord(body) ? body["default_organization_id"] : undefined;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const organizations = isRecord(body) ? body["organizations"] : undefined;
  if (Array.isArray(organizations)) {
    for (const entry of organizations) {
      if (!isRecord(entry)) continue;
      if (entry["is_personal"] === true && typeof entry["id"] === "string") return entry["id"];
    }
    for (const entry of organizations) {
      if (isRecord(entry) && typeof entry["id"] === "string") return entry["id"];
    }
  }
  throw new GatewayError(
    "authentication_failed",
    401,
    "Zed account has no organization; add organizationId to the credential",
  );
}

async function mintZedLlmToken(
  credential: ZedCredential,
  baseUrl: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const organizationId =
    credential.organizationId ?? (await fetchZedOrganizationId(credential, baseUrl, fetcher, signal));
  const key = zedCacheKey(credential, organizationId);
  const cached = llmTokens.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: zedUserAuthHeader(credential),
  };
  if (credential.systemId !== undefined) headers["x-zed-system-id"] = credential.systemId;
  const response = await fetcher(joinUrl(baseUrl, "/client/llm_tokens"), {
    method: "POST",
    headers,
    body: JSON.stringify({ organization_id: organizationId }),
    signal,
  });
  if (!response.ok) throw await mapUpstreamHttpError(response, ZED_PROVIDER_ID);
  const body: unknown = await response.json();
  const token = isRecord(body) ? body["token"] : undefined;
  const value =
    typeof token === "string"
      ? token
      : Array.isArray(token) && typeof token[0] === "string"
        ? (token[0] as string)
        : isRecord(token) && typeof token["value"] === "string"
          ? (token["value"] as string)
          : undefined;
  if (value === undefined) {
    throw new GatewayError("platform_unavailable", 502, "Zed returned no LLM token", {}, "upstream");
  }
  llmTokens.set(key, { token: value, expiresAt: Date.now() + ZED_LLM_TOKEN_TTL_MS });
  return value;
}

/** Live `model → provider` map, cached per account for an hour. */
async function zedProviderCatalog(
  credential: ZedCredential,
  baseUrl: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const key = `${credential.userId}:${credential.accessToken.slice(-16)}`;
  const cached = modelCatalogs.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.providerById;

  const token = await mintZedLlmToken(credential, baseUrl, fetcher, signal);
  const response = await fetcher(joinUrl(baseUrl, "/models"), {
    headers: { accept: "application/json", authorization: `Bearer ${token}`, "x-zed-client-supports-x-ai": "true" },
    signal,
  });
  if (!response.ok) return new Map();
  const body: unknown = await response.json();
  const entries = isRecord(body) && Array.isArray(body["models"]) ? body["models"] : [];
  const providerById = new Map<string, string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry["id"] !== "string") continue;
    if (typeof entry["provider"] === "string") providerById.set(entry["id"], entry["provider"]);
  }
  modelCatalogs.set(key, { providerById, expiresAt: Date.now() + ZED_MODEL_CACHE_TTL_MS });
  return providerById;
}

/**
 * Model discovery from Zed's own catalog. Limits and capabilities come from the
 * fields the upstream publishes; an undeclared one stays at the shared default
 * rather than being invented.
 */
export async function discoverZedModels(input: DiscoveryInput): Promise<readonly ModelDefinition[] | null> {
  let credential: ZedCredential;
  try {
    credential = parseZedCredential(input.credential);
  } catch {
    return null;
  }
  const fetcher = (input.fetcher ?? fetch) as typeof fetch;
  const signal = input.signal ?? AbortSignal.timeout(10_000);
  let token: string;
  try {
    token = await mintZedLlmToken(credential, ZED_BASE_URL, fetcher, signal);
  } catch {
    return null;
  }
  const response = await fetcher(joinUrl(ZED_BASE_URL, "/models"), {
    headers: { accept: "application/json", authorization: `Bearer ${token}`, "x-zed-client-supports-x-ai": "true" },
    signal,
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  const entries = isRecord(body) && Array.isArray(body["models"]) ? body["models"] : [];
  const models: ModelDefinition[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"].length === 0) continue;
    if (entry["is_disabled"] === true) continue;
    const context = entry["max_token_count"];
    const output = entry["max_output_tokens"];
    models.push(
      defineModel({
        id: entry["id"],
        providerId: ZED_PROVIDER_ID,
        ...(typeof context === "number" ? { ctx: context } : {}),
        ...(typeof output === "number" ? { out: output } : {}),
        vision: entry["supports_images"] === true,
        reasoning: entry["supports_thinking"] === true,
        toolCall: entry["supports_tools"] === true,
      }),
    );
  }
  return models;
}

/** Parses one NDJSON line into a Zed frame, or `undefined` for noise. */
function parseZedLine(line: string): Record<string, unknown> | undefined {
  let text = line.replace(/\r$/, "").trim();
  if (text.length === 0) return undefined;
  if (text.startsWith("data:")) text = text.slice(5).trimStart();
  if (text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Frames provider-shaped chunks as SSE `data:` lines so the matching wire codec
 * can decode them. Pull-based: each decoder read pulls one upstream line, so a
 * streamed answer is not buffered to completion before the first event.
 */
function zedSseStream(events: AsyncIterator<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
    },
  });
}

/** Yields the provider-shaped `event` payloads of a Zed NDJSON body. */
async function* zedEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = parseZedLine(line);
        if (frame === undefined) continue;
        const emitted = zedFrameEvent(frame);
        if (emitted === "done") return;
        if (emitted !== undefined) yield emitted;
        newline = buffer.indexOf("\n");
      }
    }
    const tail = parseZedLine(buffer + decoder.decode());
    if (tail !== undefined) {
      const emitted = zedFrameEvent(tail);
      if (emitted !== undefined && emitted !== "done") yield emitted;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Reduces one Zed frame to its event payload. `status` frames are control
 * messages: a failure aborts the turn, `stream_ended` ends it cleanly.
 */
function zedFrameEvent(frame: Record<string, unknown>): Record<string, unknown> | "done" | undefined {
  const status = frame["status"];
  if (status !== undefined) {
    if (typeof status === "string") return status === "stream_ended" ? "done" : undefined;
    if (isRecord(status)) {
      const failure = isRecord(status["failed"]) ? status["failed"] : status;
      const message = failure["message"] ?? failure["error"] ?? failure["code"];
      throw new GatewayError(
        "platform_unavailable",
        502,
        typeof message === "string" ? `Zed: ${message}` : "Zed reported a failed stream",
        {},
        "upstream",
      );
    }
    return undefined;
  }
  const event = frame["event"];
  return isRecord(event) ? event : undefined;
}

/** The upstream body for one model, in the format that upstream speaks. */
function zedProviderRequest(
  upstream: ZedUpstream,
  model: string,
  request: CanonicalRequest,
): Record<string, unknown> {
  const wire = ZED_UPSTREAM_BY_WIRE[upstream];
  if (wire === "messages") return { ...canonicalToClaudeMessagesPayload(request), model, stream: true };
  if (wire === "responses") return { ...canonicalToResponsesPayload(request), model, stream: true };
  if (upstream === "google") {
    const payload = buildGeminiPayload(request);
    // Zed's hosted Gemini speaks the Vertex safety vocabulary, not the public
    // enum, so the client's safetySettings would be rejected.
    delete payload["safetySettings"];
    return payload;
  }
  return { ...canonicalToChatPayload(request), model, stream: true };
}

export interface ZedAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

class ZedAdapter implements ProviderAdapter {
  readonly provider_id = ZED_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: ZedAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? ZED_BASE_URL).replace(/\/+$/, "");
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
        `zed supports chat only, got ${candidate.wire_family}`,
      );
    }
    const secret = readCredentialSecret(context.credential, "Zed credential is required");
    const credential = parseZedCredential(secret);
    const model = candidate.model_id || request.model;
    if (model.length === 0) throw new GatewayError("invalid_request", 400, "Zed model is required");

    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const providers = await zedProviderCatalog(credential, this.baseUrl, outboundFetch, context.abort_signal);
    const upstream = zedUpstreamFor(providers.get(model), model);
    const token = await mintZedLlmToken(credential, this.baseUrl, outboundFetch, context.abort_signal);

    const envelope: Record<string, unknown> = {
      provider: upstream,
      model,
      provider_request: zedProviderRequest(upstream, model, request),
    };
    const threadId = request.thread_id ?? request.conversation_id ?? request.session_id;
    if (threadId !== undefined) envelope["thread_id"] = threadId;
    if (request.turn_id !== undefined) envelope["prompt_id"] = request.turn_id;

    const { res, signal, release } = await postUpstreamJson(
      joinUrl(this.baseUrl, "/completions"),
      {
        "content-type": "application/json",
        accept: "application/x-ndjson, text/event-stream, */*",
        authorization: `Bearer ${token}`,
        "x-zed-client-supports-status-messages": "true",
        "x-zed-client-supports-stream-ended-request-completion-status": "true",
      },
      envelope,
      context,
      outboundFetch,
    );
    try {
      if (!res.ok) throw await mapUpstreamHttpError(res, ZED_PROVIDER_ID);
      if (res.body === null) {
        throw new GatewayError("platform_unavailable", 502, "Zed returned an empty stream", {}, "upstream");
      }
      // A 401 or an expired-token header means the cached bearer died early;
      // the next request mints a fresh one rather than retrying mid-stream.
      if (res.headers.has("x-zed-expired-token") || res.headers.has("x-zed-outdated-token")) {
        llmTokens.delete(zedCacheKey(credential, credential.organizationId ?? ""));
      }
      const events = zedEvents(res.body);
      yield* decodeWireStream(ZED_UPSTREAM_BY_WIRE[upstream], zedSseStream(events), request, { signal });
    } finally {
      release();
    }
  }
}

export function createZedAdapter(options: ZedAdapterOptions = {}): ProviderAdapter {
  return new ZedAdapter(options);
}
