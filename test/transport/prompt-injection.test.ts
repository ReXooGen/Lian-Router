import { describe, expect, test } from "bun:test";
import type { CanonicalRequest } from "../../src/transport/canonical-model";
import type { PromptInjection } from "../../src/persistence/schema";
import { selectPromptInjections } from "../../src/persistence/prompt-injection-store";
import {
  injectionModelNames,
  withPromptInjections,
} from "../../src/transport/dispatch/prompt-injection";

function injection(overrides: Partial<PromptInjection>): PromptInjection {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    tenantId: "tenant",
    scope: "global",
    target: "",
    name: "",
    active: true,
    mode: "prompt",
    preset: "custom",
    content: "",
    turns: [],
    position: "append",
    enabled: true,
    excludedClientIps: [],
    excludedApiKeyIds: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  } as CanonicalRequest;
}

describe("prompt injection resolution", () => {
  test("stacks global → key → model and skips disabled entries", () => {
    const entries = [
      injection({ scope: "global", target: "", content: "global" }),
      injection({ scope: "key", target: "key-1", content: "keyed" }),
      injection({ scope: "key", target: "key-2", content: "other key" }),
      injection({ scope: "model", target: "alias", content: "model" }),
      injection({ scope: "model", target: "provider/model", content: "resolved" }),
      injection({ scope: "global", target: "", content: "disabled", enabled: false }),
    ];
    const selected = selectPromptInjections(entries, {
      apiKeyId: "key-1",
      modelNames: ["alias", "provider/model"],
    });
    expect(selected.map((entry) => entry.content)).toEqual(["global", "keyed", "model"]);
  });

  test("a model entry matches the most specific available name", () => {
    const entries = [injection({ scope: "model", target: "provider/model", content: "resolved" })];
    const selected = selectPromptInjections(entries, {
      modelNames: ["alias", "provider/model", "model"],
    });
    expect(selected.map((entry) => entry.content)).toEqual(["resolved"]);
  });

  test("builds the candidate name list without duplicates", () => {
    const names = injectionModelNames(request({ model: "provider/model" }), [
      { provider_id: "provider", model_id: "model" },
    ]);
    expect(names).toEqual(["provider/model", "model"]);
  });

  test("skips an entry whose client IP is excluded", () => {
    const entries = [
      injection({ content: "global", excludedClientIps: ["203.0.113.7"] }),
      injection({ scope: "model", target: "model", content: "model", excludedClientIps: ["203.0.113.7"] }),
    ];
    const excluded = selectPromptInjections(entries, {
      clientIp: "203.0.113.7",
      modelNames: ["model"],
    });
    expect(excluded).toEqual([]);
    const included = selectPromptInjections(entries, {
      clientIp: "203.0.113.8",
      modelNames: ["model"],
    });
    expect(included.map((entry) => entry.content)).toEqual(["global", "model"]);
  });

  test("matches an IPv4-mapped exclusion against the bare address", () => {
    const entries = [injection({ content: "global", excludedClientIps: ["203.0.113.7"] })];
    expect(
      selectPromptInjections(entries, { clientIp: "::ffff:203.0.113.7", modelNames: [] }),
    ).toEqual([]);
  });

  test("ignores IP exclusions when the request carries no client address", () => {
    const entries = [injection({ content: "global", excludedClientIps: ["203.0.113.7"] })];
    expect(selectPromptInjections(entries, { modelNames: [] }).length).toBe(1);
  });

  test("an exclusion naming a share template covers its child key", () => {
    const entries = [injection({ content: "global", excludedApiKeyIds: ["parent-1"] })];
    expect(
      selectPromptInjections(entries, {
        apiKeyId: "child-1",
        parentApiKeyId: "parent-1",
        modelNames: [],
      }),
    ).toEqual([]);
    expect(
      selectPromptInjections(entries, {
        apiKeyId: "child-2",
        parentApiKeyId: "parent-2",
        modelNames: [],
      }).length,
    ).toBe(1);
  });

  test("skips an entry whose API key is excluded", () => {
    const entries = [
      injection({ scope: "key", target: "key-1", content: "keyed" }),
      injection({ scope: "key", target: "key-2", content: "blocked", excludedApiKeyIds: ["key-2"] }),
      injection({ scope: "model", target: "model", content: "model", excludedApiKeyIds: ["key-1"] }),
    ];
    expect(
      selectPromptInjections(entries, { apiKeyId: "key-1", modelNames: ["model"] }).map(
        (entry) => entry.content,
      ),
    ).toEqual(["keyed"]);
    expect(
      selectPromptInjections(entries, { apiKeyId: "key-2", modelNames: ["model"] }).map(
        (entry) => entry.content,
      ),
    ).toEqual(["model"]);
  });
});

describe("prompt injection application", () => {
  test("prepends and appends system prompts around the existing system text", () => {
    const result = withPromptInjections(
      request({ system: [{ kind: "text", text: "base" }] }),
      [
        injection({ content: "before", position: "prepend" }),
        injection({ scope: "key", target: "k", content: "after", position: "append" }),
      ],
    );
    expect(result.system).toEqual([
      { kind: "text", text: "before" },
      { kind: "text", text: "base" },
      { kind: "text", text: "after" },
    ]);
  });

  test("inserts scripted turns as fake history before the first user turn", () => {
    const result = withPromptInjections(request(), [
      injection({
        mode: "script",
        turns: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
        ],
      }),
    ]);
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(result.messages[0]?.content).toEqual([{ kind: "text", text: "earlier question" }]);
    expect(result.messages[2]?.content).toEqual([{ kind: "text", text: "hi" }]);
  });

  test("is idempotent: applying the same stack twice changes nothing", () => {
    const injections = [
      injection({ content: "persona", position: "prepend" }),
      injection({
        mode: "script",
        turns: [{ role: "user", content: "prime" }],
      }),
    ];
    const once = withPromptInjections(request(), injections);
    const twice = withPromptInjections(once, injections);
    expect(twice).toEqual(once);
  });

  test("leaves an embeddings request untouched", () => {
    const embeddings = request({ embedding_input: "text", messages: [] });
    const result = withPromptInjections(embeddings, [
      injection({ content: "persona" }),
    ]);
    expect(result).toBe(embeddings);
  });

  test("does not inject when the stack is empty", () => {
    const base = request();
    expect(withPromptInjections(base, [])).toBe(base);
  });
});
