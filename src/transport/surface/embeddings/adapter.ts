import type { CanonicalEvent, CanonicalRequest } from "../../canonical-model";
import type { SurfaceAdapter, SurfaceInput, SurfaceOutput } from "../adapters";
import { isRecord, readString } from "../../../protocol/primitives";
import { asJsonBytes } from "../chat/encode";
import { GatewayError } from "../../gateway-error";

/**
 * OpenAI Embeddings surface (`POST /v1/embeddings`).
 *
 * Unlike the chat surfaces this request carries no messages, tools, or
 * reasoning: `input` is the whole request. The canonical request keeps the
 * same envelope so routing, admission, account health, egress pools, and
 * telemetry are shared with every other surface; only the payload and the
 * response shape differ.
 */
export class EmbeddingsAdapter implements SurfaceAdapter {
  readonly surface = "embeddings" as const;

  matchesBodyShape(body: unknown): boolean {
    if (!isRecord(body)) return false;
    if ("messages" in body) return false;
    const input = body["input"];
    return (
      typeof input === "string" ||
      (Array.isArray(input) &&
        input.length > 0 &&
        input.every((entry) => typeof entry === "string"))
    );
  }

  parse(input: SurfaceInput | unknown): CanonicalRequest {
    const value = isRecord(input) && "body" in input ? input["body"] : input;
    const body = isRecord(value) ? value : {};
    const model = readString(body, "model") ?? "";
    if (model.length === 0) {
      throw new GatewayError("invalid_request", 400, "embeddings request requires a model");
    }
    if (body["stream"] === true) {
      throw new GatewayError(
        "capability_unsupported",
        400,
        "embeddings requests do not support streaming",
        { surface: "embeddings" },
      );
    }
    const rawInput = body["input"];
    let embeddingInput: string | readonly string[];
    if (typeof rawInput === "string") {
      embeddingInput = rawInput;
    } else if (
      Array.isArray(rawInput) &&
      rawInput.length > 0 &&
      rawInput.every((entry) => typeof entry === "string")
    ) {
      embeddingInput = rawInput as readonly string[];
    } else {
      throw new GatewayError(
        "invalid_request",
        400,
        "embeddings input must be a string or an array of strings",
      );
    }
    const dimensions =
      typeof body["dimensions"] === "number" && Number.isInteger(body["dimensions"])
        ? body["dimensions"]
        : undefined;
    const encoding = body["encoding_format"];
    const encodingFormat = encoding === "base64" ? "base64" : "float";
    return {
      model,
      messages: [],
      generation_controls: {},
      stream: false,
      source_surface: "embeddings",
      embedding_input: embeddingInput,
      ...(dimensions === undefined ? {} : { dimensions }),
      encoding_format: encodingFormat,
      ...(typeof body["user"] === "string" && body["user"].length > 0
        ? { metadata: { user: body["user"] } }
        : {}),
    };
  }

  encode(events: CanonicalEvent[], options: { model?: string } = {}): SurfaceOutput {
    const vectors = events
      .filter(
        (event): event is Extract<CanonicalEvent, { type: "embedding" }> =>
          event.type === "embedding",
      )
      .sort((left, right) => left.index - right.index)
      .map((event) => ({ object: "embedding" as const, index: event.index, embedding: event.embedding }));
    const terminal = events.find(
      (event): event is Extract<CanonicalEvent, { type: "terminal" }> =>
        event.type === "terminal",
    );
    const start = events.find(
      (event) => event.type === "message_start" || event.type === "response_start",
    );
    const usage = terminal?.usage;
    return {
      bytes: asJsonBytes({
        object: "list",
        data: vectors,
        model:
          (start !== undefined && "model" in start ? start.model : undefined) ??
          options.model ??
          "",
        ...(usage === undefined
          ? {}
          : {
              usage: {
                prompt_tokens: usage.input_tokens,
                total_tokens: usage.total_tokens ?? usage.input_tokens,
              },
            }),
      }),
      content_type: "application/json",
    };
  }
}

/** Singleton adapter for registry composition without mutable state. */
export const embeddingsAdapter = new EmbeddingsAdapter();
