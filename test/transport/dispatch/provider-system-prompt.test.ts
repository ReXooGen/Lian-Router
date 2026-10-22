import { describe, expect, test } from "bun:test";
import { withProviderSystemPrompt } from "../../../src/transport/dispatch/provider-system-prompt";
import { encodeWireRequest } from "../../../src/protocol/registry";
import type { CanonicalRequest, ContentPart } from "../../../src/transport/canonical-model";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "example-model",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

function textOf(parts: readonly ContentPart[] | undefined): string[] {
  return (parts ?? []).flatMap((part) => (part.kind === "text" ? [part.text] : []));
}

describe("provider system prompt injection", () => {
  test("prepends the provider text as a system part", () => {
    const next = withProviderSystemPrompt(request(), "Answer in Indonesian.");
    expect(textOf(next.system)).toEqual(["Answer in Indonesian."]);
  });

  test("keeps the client's own system prompt after the provider text", () => {
    // Order matters: the provider's instruction is the outer contract, and the
    // client's prompt must survive rather than being replaced.
    const next = withProviderSystemPrompt(
      request({ system: [{ kind: "text", text: "You are a helpful assistant." }] }),
      "Answer in Indonesian.",
    );
    expect(textOf(next.system)).toEqual(["Answer in Indonesian.", "You are a helpful assistant."]);
  });

  test("returns the same request object when the provider configured nothing", () => {
    // The common path must not allocate, and must not add an empty system array
    // that encoders would then emit as a blank message.
    const original = request();
    expect(withProviderSystemPrompt(original, undefined)).toBe(original);
    expect(withProviderSystemPrompt(original, "")).toBe(original);
    expect(withProviderSystemPrompt(original, "   ")).toBe(original);
  });

  test("trims surrounding whitespace instead of forwarding it", () => {
    const next = withProviderSystemPrompt(request(), "  be brief  ");
    expect(textOf(next.system)).toEqual(["be brief"]);
  });

  test("does not mutate the request it was given", () => {
    const original = request();
    const next = withProviderSystemPrompt(original, "hint");
    expect(original.system).toBeUndefined();
    expect(next).not.toBe(original);
    // Messages are shared by reference; only `system` is rebuilt.
    expect(next.messages).toBe(original.messages);
  });

  test("carries the provider text through every wire family", () => {
    // `system` is emitted by all four encoders, which is why the text lands
    // there rather than in the Responses-only `instructions`.
    for (const surface of ["chat", "messages", "responses", "completion"] as const) {
      const next = withProviderSystemPrompt(request({ source_surface: surface }), "route hint");
      expect(textOf(next.system)).toEqual(["route hint"]);
    }
  });

  test("applies independently per provider across failover attempts", () => {
    // Two candidates, two different providers: each attempt injects its own
    // text, and the second must not inherit the first's.
    const base = request();
    const first = withProviderSystemPrompt(base, "provider A hint");
    const second = withProviderSystemPrompt(base, "provider B hint");
    expect(textOf(first.system)).toEqual(["provider A hint"]);
    expect(textOf(second.system)).toEqual(["provider B hint"]);
  });

  test("reaches the chat wire payload as a system message", () => {
    // The helper is only useful if the encoder actually serializes it; this
    // asserts the text on the payload the provider receives.
    const next = withProviderSystemPrompt(request(), "Answer in Indonesian.");
    const payload = encodeWireRequest("chat", next);
    const messages = payload["messages"];
    if (!Array.isArray(messages)) throw new Error("chat payload has no messages array");
    expect(messages[0]).toEqual({ role: "system", content: "Answer in Indonesian." });
  });

  test("reaches the messages wire payload", () => {
    const next = withProviderSystemPrompt(
      request({ source_surface: "messages" }),
      "Answer in Indonesian.",
    );
    const payload = encodeWireRequest("messages", next);
    // Anthropic carries system content in a top-level field, not a message.
    expect(JSON.stringify(payload["system"])).toContain("Answer in Indonesian.");
  });
});
