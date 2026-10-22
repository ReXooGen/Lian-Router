/**
 * [OpenAI]-compatible /embeddings response decoder: wire JSON → canonical
 * events. Embeddings never stream, so this is the only decoder for the wire.
 */
import { canonicalTerminal } from "../primitives";
import type { CanonicalEvent, CanonicalRequest, UsageRecord } from "../../transport/canonical-model";
import { parseEmbeddingsResponse } from "../request/embeddings";

export function parseEmbeddingsResponseToEvents(
  json: Record<string, unknown>,
  request: CanonicalRequest,
): CanonicalEvent[] {
  const parsed = parseEmbeddingsResponse(json);
  const model = parsed.model ?? request.model;
  const events: CanonicalEvent[] = [
    {
      type: "message_start",
      sequence_number: 1,
      model,
    },
  ];
  for (const vector of parsed.vectors) {
    events.push({
      type: "embedding",
      sequence_number: events.length + 1,
      index: vector.index,
      embedding: vector.embedding,
    });
  }
  const usage: UsageRecord | undefined =
    parsed.inputTokens === undefined
      ? undefined
      : {
          input_tokens: parsed.inputTokens,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          uncached_input_tokens: parsed.inputTokens,
          output_tokens: 0,
          reasoning_tokens: 0,
          estimated_cost: null,
          total_tokens: parsed.inputTokens,
        };
  events.push(
    canonicalTerminal({
      sequenceNumber: events.length + 1,
      state: "complete",
      stopReason: "stop",
      ...(usage === undefined ? {} : { usage }),
    }),
  );
  return events;
}
