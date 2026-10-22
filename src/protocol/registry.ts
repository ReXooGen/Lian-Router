import type { CanonicalEvent, CanonicalRequest, WireFamily } from "../transport/canonical-model";
import { canonicalToChatPayload } from "./request/chat";
import { canonicalToResponsesPayload } from "./request/responses";
import { canonicalToClaudeMessagesPayload } from "./request/messages";
import { canonicalToEmbeddingsPayload } from "./request/embeddings";
import { decodeChatSseStream, parseChatResponseToEvents } from "./response/chat";
import { decodeResponsesSseStream, parseResponsesResponseToEvents } from "./response/responses";
import { claudeResponseToEvents, parseClaudeSseStream } from "./response/messages";
import { parseEmbeddingsResponseToEvents } from "./response/embeddings";

export interface CodecContext {
  readonly isOAuth?: boolean;
  readonly sessionId?: string;
  readonly supportsPromptCaching?: boolean;
  readonly signal?: AbortSignal;
}

export function encodeWireRequest(
  wireFamily: WireFamily,
  request: CanonicalRequest,
  context?: CodecContext,
): Record<string, unknown> {
  switch (wireFamily) {
    case "chat":
      return canonicalToChatPayload(request, context?.supportsPromptCaching !== false);
    case "responses":
      return canonicalToResponsesPayload(request, context?.supportsPromptCaching !== false);
    case "messages":
      return canonicalToClaudeMessagesPayload(request, {
        ...(context?.isOAuth === undefined ? {} : { isOAuth: context.isOAuth }),
      });
    case "embeddings":
      return canonicalToEmbeddingsPayload(request);
    default:
      throw new Error(`unsupported wire family: ${wireFamily}`);
  }
}

export function decodeWireResponse(
  wireFamily: WireFamily,
  json: Record<string, unknown>,
  request: CanonicalRequest,
  context?: CodecContext,
): readonly CanonicalEvent[] {
  switch (wireFamily) {
    case "chat":
      return parseChatResponseToEvents(json, request);
    case "responses":
      return parseResponsesResponseToEvents(json, request);
    case "messages":
      return claudeResponseToEvents(json, request, context?.isOAuth ?? false);
    case "embeddings":
      return parseEmbeddingsResponseToEvents(json, request);
    default:
      throw new Error(`unsupported wire family: ${wireFamily}`);
  }
}

export function decodeWireStream(
  wireFamily: WireFamily,
  body: ReadableStream<Uint8Array>,
  request: CanonicalRequest,
  context?: CodecContext,
): AsyncIterable<CanonicalEvent> {
  switch (wireFamily) {
    case "chat":
      return decodeChatSseStream(body, request, context?.signal);
    case "responses":
      return decodeResponsesSseStream(body, request, context?.signal);
    case "messages":
      return parseClaudeSseStream(body, context?.signal, context?.isOAuth ?? false);
    case "embeddings":
      throw new Error("embeddings responses are not streamed");
    default:
      throw new Error(`unsupported wire family: ${wireFamily}`);
  }
}
