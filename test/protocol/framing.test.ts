import { describe, expect, test } from "bun:test";
import type { CanonicalEvent, CanonicalRequest } from "../../src/transport/canonical-model";
import type {
  ProviderDispatchContext,
  ResolvedCredential,
} from "../../src/providers/provider-registry";
import { sendClaudeMessagesRequest } from "../../src/protocol/transport/messages";
import { bodyIsSse, stripTrailingSseTerminator } from "../../src/protocol/transport/framing";

/**
 * Upstreams that append the SSE terminator to a JSON body, or label that body
 * `text/event-stream`, must still decode: a strict parser turns a complete
 * answer into a 502 "not valid JSON" for the first shape and into an empty
 * stream for the second.
 */

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  } as CanonicalRequest;
}

function context(): ProviderDispatchContext {
  const credential: ResolvedCredential = {
    provider_id: "anthropic",
    credential_kind: "api_key",
    secret: new TextEncoder().encode("test-secret-token"),
  };
  return {
    credential,
    deadline: Date.now() + 10_000,
    abort_signal: new AbortController().signal,
  };
}

const CLAUDE_JSON = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "test-model",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
});

async function collect(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const collected: CanonicalEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function dispatchClaude(
  body: string,
  contentType: string,
  stream = false,
): Promise<CanonicalEvent[]> {
  return collect(
    sendClaudeMessagesRequest(
      "https://api.example.com/v1/messages",
      { "content-type": "application/json" },
      "{}",
      context(),
      request({ stream }),
      (async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": contentType },
        })) as unknown as typeof fetch,
    ),
  );
}

function textOf(events: readonly CanonicalEvent[]): string {
  return events
    .filter((event) => event.type === "content_delta" && event.content.kind === "text")
    .map((event) => (event.type === "content_delta" && event.content.kind === "text" ? event.content.text : ""))
    .join("");
}

describe("upstream framing helpers", () => {
  test("strips only a trailing SSE terminator, never an interior marker", () => {
    expect(stripTrailingSseTerminator('{"a":1}\n\ndata: [DONE]\n')).toBe('{"a":1}');
    // The marker is inside a JSON string value, so the body continues past it.
    expect(stripTrailingSseTerminator('{"text":"send data: [DONE]"}')).toBe(
      '{"text":"send data: [DONE]"}',
    );
  });

  test("classifies a buffered body by its framing, not its header", () => {
    expect(bodyIsSse('data: {"x":1}')).toBe(true);
    expect(bodyIsSse('event: message_start')).toBe(true);
    // A keepalive comment before the first frame is still SSE framing.
    expect(bodyIsSse(': heartbeat\ndata: {"x":1}')).toBe(true);
    expect(bodyIsSse('{"choices":[]}')).toBe(false);
  });
});

describe("Claude Messages response framing tolerance", () => {
  test("decodes a JSON body with a trailing SSE terminator", async () => {
    const events = await dispatchClaude(`${CLAUDE_JSON}\ndata: [DONE]\n`, "application/json");
    expect(textOf(events)).toBe("hello");
    expect(events.some((event) => event.type === "terminal")).toBe(true);
  });

  test("decodes a JSON body mislabeled text/event-stream for a non-stream caller", async () => {
    const events = await dispatchClaude(CLAUDE_JSON, "text/event-stream");
    expect(textOf(events)).toBe("hello");
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal?.type === "terminal" ? terminal.state : undefined).toBe("complete");
  });

  test("still parses a genuine SSE body for a non-stream caller", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join("\n\n");
    const events = await dispatchClaude(sse, "text/event-stream");
    expect(textOf(events)).toBe("hello");
  });
});
