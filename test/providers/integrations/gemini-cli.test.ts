import { describe, expect, test } from "bun:test";
import {
  GEMINI_CLI_MODELS,
  buildGeminiCliEnvelope,
  createGeminiCliAdapter,
} from "../../../src/providers/integrations/gemini-cli";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../../src/providers/provider-registry";

const REQUEST: CanonicalRequest = {
  model: "gemini-2.5-pro",
  system: [{ kind: "text", text: "be terse" }],
  messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
  generation_controls: {},
  stream: false,
  source_surface: "chat",
};

const TARGET: ProviderDispatchTarget = {
  provider_id: "gemini-cli",
  model_id: "gemini-2.5-pro",
  wire_family: "chat",
  endpoint_path: "",
  capabilities: {},
};

function contextFor(secret: string): ProviderDispatchContext {
  return {
    credential: {
      provider_id: "gemini-cli",
      credential_kind: "oauth",
      secret: new TextEncoder().encode(secret),
    },
    deadline: Date.now() + 5_000,
    abort_signal: new AbortController().signal,
  };
}

describe("Gemini CLI envelope", () => {
  test("wraps the Gemini payload in {project, model, request}", () => {
    const envelope = buildGeminiCliEnvelope(REQUEST, "gemini-2.5-pro", "proj-1");
    expect(envelope["project"]).toBe("proj-1");
    expect(envelope["model"]).toBe("gemini-2.5-pro");
    const inner = envelope["request"] as Record<string, unknown>;
    expect(Array.isArray(inner["contents"])).toBe(true);
    expect(inner["systemInstruction"]).toBeDefined();
  });

  test("omits project when unknown rather than sending an empty string", () => {
    const envelope = buildGeminiCliEnvelope(REQUEST, "gemini-2.5-pro", undefined);
    expect("project" in envelope).toBe(false);
  });
});

describe("Gemini CLI dispatch", () => {
  test("posts to the fixed RPC with a Bearer token and decodes the Gemini response", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createGeminiCliAdapter({ fetch: fakeFetch, project: "proj-1" });
    expect(adapter.provider_id).toBe("gemini-cli");

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.dispatch(REQUEST, TARGET, contextFor("ya29.token"))) events.push(event);

    expect(capturedUrl).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(capturedHeaders["authorization"]).toBe("Bearer ya29.token");
    expect(capturedBody["model"]).toBe("gemini-2.5-pro");
    expect(capturedBody["project"]).toBe("proj-1");
    const text = events
      .map((event) => (event.type === "content_delta" && event.content.kind === "text" ? event.content.text : ""))
      .join("");
    expect(text).toBe("pong");
    const terminal = events.find((event) => event.type === "terminal");
    expect(terminal !== undefined && terminal.type === "terminal" ? terminal.state : undefined).toBe("complete");
  });

  test("streaming posts to streamGenerateContent with alt=sse", async () => {
    let capturedUrl = "";
    const fakeFetch = (async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createGeminiCliAdapter({ fetch: fakeFetch });
    const events: CanonicalEvent[] = [];
    for await (const event of adapter.dispatch(
      { ...REQUEST, stream: true },
      TARGET,
      contextFor("ya29.token"),
    )) {
      events.push(event);
    }

    expect(capturedUrl).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    const text = events
      .map((event) => (event.type === "content_delta" && event.content.kind === "text" ? event.content.text : ""))
      .join("");
    expect(text).toBe("hi");
  });

  test("the catalog carries all seven Cloud Code Assist ids", () => {
    expect(GEMINI_CLI_MODELS.map((model) => model.modelId)).toEqual([
      "gemini-3.1-pro-preview",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  });
});
