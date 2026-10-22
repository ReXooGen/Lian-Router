import { describe, expect, test } from "bun:test";
import { embeddingsAdapter } from "../../src/transport/surface/embeddings/adapter";
import { decodeWireResponse, encodeWireRequest } from "../../src/protocol/registry";
import { OpenAICompatibleAdapter } from "../../src/providers/compatible-adapter";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../src/providers/provider-registry";
import type { CanonicalEvent, CanonicalRequest } from "../../src/transport/canonical-model";

function parse(body: Record<string, unknown>): CanonicalRequest {
  return embeddingsAdapter.parse({ body, headers: {}, path: "/v1/embeddings" });
}

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "text-embedding-3-small",
    messages: [],
    generation_controls: {},
    stream: false,
    source_surface: "embeddings",
    embedding_input: "hello",
    ...overrides,
  } as CanonicalRequest;
}

function context(): ProviderDispatchContext {
  return {
    credential: { provider_id: "openai", credential_kind: "api_key", secret: new TextEncoder().encode("sk-test") },
    deadline: Date.now() + 5000,
    abort_signal: new AbortController().signal,
  } as ProviderDispatchContext;
}

function target(): ProviderDispatchTarget {
  return {
    provider_id: "openai",
    model_id: "text-embedding-3-small",
    wire_family: "embeddings",
    endpoint_path: "/v1/embeddings",
    capabilities: {},
  } as ProviderDispatchTarget;
}

describe("embeddings surface", () => {
  test("detects an input-only body and parses the OpenAI request", () => {
    expect(embeddingsAdapter.matchesBodyShape({ input: "hello" })).toBe(true);
    expect(embeddingsAdapter.matchesBodyShape({ input: ["a", "b"] })).toBe(true);
    expect(embeddingsAdapter.matchesBodyShape({ messages: [] })).toBe(false);
    expect(embeddingsAdapter.matchesBodyShape({ input: 42 })).toBe(false);

    const parsed = parse({
      model: "text-embedding-3-small",
      input: ["a", "b"],
      dimensions: 256,
      encoding_format: "base64",
      user: "tenant-user",
    });
    expect(parsed.source_surface).toBe("embeddings");
    expect(parsed.model).toBe("text-embedding-3-small");
    expect(parsed.embedding_input).toEqual(["a", "b"]);
    expect(parsed.dimensions).toBe(256);
    expect(parsed.encoding_format).toBe("base64");
    expect(parsed.metadata).toEqual({ user: "tenant-user" });
    expect(parsed.messages).toEqual([]);
  });

  test("rejects a streaming or input-less embeddings request", () => {
    expect(() => parse({ model: "m", input: "x", stream: true })).toThrow("streaming");
    expect(() => parse({ model: "m" })).toThrow("input");
    expect(() => parse({ input: "x" })).toThrow("model");
  });

  test("encodes vectors and usage back to the OpenAI embeddings envelope", () => {
    const events: CanonicalEvent[] = [
      { type: "message_start", sequence_number: 1, model: "text-embedding-3-small" },
      { type: "embedding", sequence_number: 2, index: 1, embedding: [0.2, 0.3] },
      { type: "embedding", sequence_number: 3, index: 0, embedding: [0.1] },
      {
        type: "terminal",
        sequence_number: 4,
        state: "complete",
        usage: {
          input_tokens: 7,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          uncached_input_tokens: 7,
          output_tokens: 0,
          reasoning_tokens: 0,
          estimated_cost: null,
          total_tokens: 7,
        },
      },
    ];
    const output = embeddingsAdapter.encode(events);
    const body = JSON.parse(new TextDecoder().decode(output.bytes));
    expect(body.object).toBe("list");
    expect(body.model).toBe("text-embedding-3-small");
    // Vectors are ordered by the upstream index, not by event arrival.
    expect(body.data).toEqual([
      { object: "embedding", index: 0, embedding: [0.1] },
      { object: "embedding", index: 1, embedding: [0.2, 0.3] },
    ]);
    expect(body.usage).toEqual({ prompt_tokens: 7, total_tokens: 7 });
  });

  test("keeps a batch input in order on the wire", () => {
    const payload = encodeWireRequest("embeddings", request({ embedding_input: ["b", "a", "c"] }));
    expect(payload).toEqual({ model: "text-embedding-3-small", input: ["b", "a", "c"] });
  });

  test("decodes an upstream embeddings body into vectors plus usage", () => {
    const events = decodeWireResponse(
      "embeddings",
      {
        object: "list",
        model: "text-embedding-3-small",
        data: [
          { object: "embedding", index: 0, embedding: [0.1, 0.2] },
          { object: "embedding", index: 1, embedding: [0.3] },
        ],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      },
      request(),
    );
    const vectors = events.filter((event) => event.type === "embedding");
    expect(vectors).toHaveLength(2);
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal).toBeDefined();
    expect(terminal && terminal.type === "terminal" ? terminal.usage?.input_tokens : undefined).toBe(4);
  });
});

describe("OpenAI-compatible embeddings dispatch", () => {
  test("posts the embeddings payload and yields vectors plus a terminal event", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          object: "list",
          model: "text-embedding-3-small",
          data: [{ object: "embedding", index: 0, embedding: [0.5, 0.25] }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const adapter = new OpenAICompatibleAdapter({
      provider_id: "openai",
      base_url: "https://api.example.com",
      authentication_header_shape: "authorization_bearer",
      supported_wire_families: ["embeddings"],
      endpoint_paths_by_wire_family: { embeddings: "/v1/embeddings" },
      fetch: fetcher,
    });
    const events: CanonicalEvent[] = [];
    for await (const event of adapter.dispatch(request(), target(), context())) {
      events.push(event);
    }
    expect(seenUrl).toBe("https://api.example.com/v1/embeddings");
    expect(seenBody).toEqual({ model: "text-embedding-3-small", input: "hello" });
    expect(events.filter((event) => event.type === "embedding")).toHaveLength(1);
    expect(events.find((event) => event.type === "terminal")).toBeDefined();
  });
});
