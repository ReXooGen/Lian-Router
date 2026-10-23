/**
 * Gemini CLI (Cloud Code Assist) adapter.
 *
 * Cloud Code Assist serves the Gemini `generateContent` body behind a fixed
 * RPC, not a per-model path:
 *
 *   POST https://cloudcode-pa.googleapis.com/v1internal:{generate,streamGenerate}Content
 *   { project, model, request: <gemini payload> }
 *
 * The inner `request` is exactly what Gemini's v1beta endpoint accepts, so this
 * module reuses `buildGeminiPayload` and the Gemini response decoders. What is
 * its own is the envelope and the fixed action path — hence a distinct adapter
 * rather than a mode of `gemini.ts`, whose URL carries the model.
 *
 * Auth is a Google OAuth access token (Cloud Code Assist has no API-key mode).
 */
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

export const GEMINI_CLI_PROVIDER_ID = "gemini-cli" as const;
export const GEMINI_CLI_BASE_URL = providerBaseUrl(GEMINI_CLI_PROVIDER_ID);

/** Fixed RPC actions; the model travels inside the envelope, not the URL. */
const GEMINI_CLI_GENERATE_PATH = ":generateContent" as const;
const GEMINI_CLI_STREAM_PATH = ":streamGenerateContent?alt=sse" as const;

/**
 * Cloud Code Assist catalog. These are the ids the CLI backend serves; they are
 * not identical to the public Gemini catalog (`gemini-3-pro-preview` and
 * `gemini-2.5-flash-lite` exist here and not on the v1beta list), so the two
 * catalogs stay separate rather than sharing `GEMINI_MODELS`.
 */
export const GEMINI_CLI_MODELS: readonly ModelDefinition[] = [
  "gemini-3.1-pro-preview",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
].map((id) =>
  defineModel({
    id,
    endpoint: GEMINI_CLI_GENERATE_PATH,
    ctx: 1_000_000,
    out: 65_536,
    vision: true,
    reasoning: true,
  }),
);

/**
 * Wraps the Gemini payload in the Cloud Code Assist envelope. `project` is
 * omitted when unknown: the backend resolves a default project for a token
 * that has not onboarded one, and sending an empty string is rejected.
 */
export function buildGeminiCliEnvelope(
  request: CanonicalRequest,
  model: string,
  project: string | undefined,
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    model,
    request: buildGeminiPayload(request),
  };
  if (project !== undefined && project.length > 0) envelope["project"] = project;
  return envelope;
}

export interface GeminiCliAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  /** Cloud project the account is onboarded into; omitted for the backend default. */
  readonly project?: string;
}

class GeminiCliAdapter implements ProviderAdapter {
  readonly provider_id = GEMINI_CLI_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly project: string | undefined;

  constructor(options: GeminiCliAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? GEMINI_CLI_BASE_URL).replace(/\/+$/, "");
    this.project = options.project;
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
        `gemini-cli supports chat/responses/messages, got ${candidate.wire_family}`,
      );
    }
    const accessToken = readCredentialSecret(context.credential, "Gemini CLI access token is required");

    const model = candidate.model_id || request.model;
    const url = `${this.baseUrl}${request.stream ? GEMINI_CLI_STREAM_PATH : GEMINI_CLI_GENERATE_PATH}`;
    const payload = buildGeminiCliEnvelope(request, model, this.project);

    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const lifecycle = createUpstreamDeadlineLifecycle(context);

    try {
      const response = await outboundFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
          accept: request.stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify(payload),
        signal: lifecycle.signal,
      });
      if (!response.ok) throw await mapUpstreamHttpError(response, GEMINI_CLI_PROVIDER_ID);

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

      if (!response.body) {
        throw new GatewayError("platform_unavailable", 502, "Gemini CLI returned empty stream", {}, "upstream");
      }
      let seq = 1;
      yield { type: "response_start", sequence_number: seq++, model: request.model } as CanonicalEvent;
      const activeCalls = new Set<string>();
      let rawUsage: Record<string, unknown> | undefined;
      let finishReason: string | undefined;
      let outputCalls = 0;
      for await (const sse of decodeSseEvents(response.body as ReadableStream<Uint8Array>, { signal: lifecycle.signal })) {
        const data = sse.data.trim();
        if (!data || data === "[DONE]") continue;
        const parsedEvent = decodeGeminiStreamEvent(data, "Gemini CLI stream error");
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

export function createGeminiCliAdapter(options: GeminiCliAdapterOptions = {}): ProviderAdapter {
  return new GeminiCliAdapter(options);
}
