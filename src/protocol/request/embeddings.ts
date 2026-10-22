import type { CanonicalRequest } from "../../transport/canonical-model";
import { isRecord } from "../primitives";

/**
 * Canonical → OpenAI Embeddings wire body.
 *
 * `input` is forwarded exactly as the client sent it (one string or an ordered
 * batch), because batching is part of the request's meaning: reordering or
 * splitting it would change the indexes the client maps back. `encoding_format`
 * is only sent when the caller asked for base64; the upstream default is float.
 */
export function canonicalToEmbeddingsPayload(
  request: CanonicalRequest,
): Record<string, unknown> {
  if (request.embedding_input === undefined) {
    throw new Error("embeddings request requires input");
  }
  const payload: Record<string, unknown> = {
    model: request.model,
    input: request.embedding_input,
  };
  if (request.dimensions !== undefined) payload["dimensions"] = request.dimensions;
  if (request.encoding_format === "base64") payload["encoding_format"] = "base64";
  const user = request.metadata?.["user"];
  if (typeof user === "string" && user.length > 0) payload["user"] = user;
  return payload;
}

/** Reads the upstream embeddings envelope into vectors plus usage. */
export function parseEmbeddingsResponse(json: Record<string, unknown>): {
  readonly model?: string;
  readonly vectors: ReadonlyArray<{ readonly index: number; readonly embedding: readonly number[] | string }>;
  readonly inputTokens?: number;
} {
  const data = json["data"];
  if (!Array.isArray(data)) {
    throw new Error("embeddings response is missing data[]");
  }
  const vectors = data.map((entry, position) => {
    if (!isRecord(entry)) throw new Error("embeddings response entry is not an object");
    const embedding = entry["embedding"];
    if (typeof embedding === "string") {
      return { index: typeof entry["index"] === "number" ? entry["index"] : position, embedding };
    }
    if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) {
      throw new Error("embeddings response entry has no numeric vector");
    }
    return {
      index: typeof entry["index"] === "number" ? entry["index"] : position,
      embedding: embedding as readonly number[],
    };
  });
  const usage = isRecord(json["usage"]) ? json["usage"] : undefined;
  const promptTokens =
    typeof usage?.["prompt_tokens"] === "number" ? usage["prompt_tokens"] : undefined;
  const model = typeof json["model"] === "string" ? json["model"] : undefined;
  return {
    ...(model === undefined ? {} : { model }),
    vectors,
    ...(promptTokens === undefined ? {} : { inputTokens: promptTokens }),
  };
}
