import { describe, expect, test } from "bun:test";
import {
  handleProviderProxyRequest,
  type ProviderProxyHandlerDeps,
} from "../../../src/transport/dispatch/proxy-request";
import type { PreparedProxyRequest } from "../../../src/transport/request/preparer";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ResolvedApiKey } from "../../../src/security/api-key-auth";
import type { ProviderAdapter } from "../../../src/providers/provider-registry";
import { invalidatePromptInjectionCache } from "../../../src/persistence/prompt-injection-store";
import {
  consoleSettings,
  promptInjections,
  type PromptInjection,
} from "../../../src/persistence/schema";

/**
 * Prompt Injection at the dispatch boundary: a stored row must reach the
 * adapter's canonical request through the real `handleProviderProxyRequest`
 * path, not only through the pure injector.
 */

const tenantId = "tenant-injection";

const authorization: ResolvedApiKey = {
  id: "key-injection",
  tenantId,
  scopes: [],
  snapshot: { api_key_id: "key-injection", tenant_id: tenantId },
};

function injection(overrides: Partial<PromptInjection>): PromptInjection {
  return {
    id: "row-1",
    tenantId,
    scope: "global",
    target: "",
    name: "",
    active: true,
    mode: "prompt",
    preset: "custom",
    content: "PERSONA",
    turns: [],
    position: "prepend",
    enabled: true,
    excludedClientIps: [],
    excludedApiKeyIds: [],
    excludedProviders: [],
    excludedModels: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function canonicalRequest(): CanonicalRequest {
  return {
    model: "fast",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
  };
}

function terminal(): CanonicalEvent {
  return {
    type: "terminal",
    sequence_number: 0,
    state: "complete",
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      uncached_input_tokens: 1,
      output_tokens: 1,
      reasoning_tokens: 0,
      estimated_cost: 0,
    },
  };
}

/** Array that also answers Drizzle's `.limit()` overrides. */
function rows<T>(values: readonly T[]): readonly T[] & { limit: () => Promise<readonly T[]> } {
  return Object.assign([...values], { limit: async () => values });
}

describe("handleProviderProxyRequest — prompt injection", () => {
  async function dispatchWith(input: {
    readonly stored: readonly PromptInjection[];
    readonly authorization: ResolvedApiKey;
    readonly clientAddress?: string;
  }): Promise<{ status: number; captured?: CanonicalRequest }> {
    const candidate = {
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-5",
      wire_family: "chat" as const,
      endpoint: "/v1/messages",
      capability_profile: {},
      provider_account_id: "account-1",
    };
    const preparedRequest: PreparedProxyRequest = {
      canonicalRequest: canonicalRequest(),
      authorization: input.authorization,
      candidate,
      eligibleRouteCandidates: [candidate],
      plan: {
        revision: 1,
        candidates: [candidate],
        requested_model: "fast",
        resolved_model: "claude-sonnet-4-5",
        provider_id: "anthropic",
      },
      estimatedInputTokens: 10,
      estimatedOutputTokens: 10,
      deadlineMs: Date.now() + 60_000,
      routingEngine: {
        reserve: async () => ({
          candidate,
          lease_id: "reservation",
          expires_at: Date.now() + 60_000,
          acquired_at: Date.now(),
        }),
        release: async () => {},
      } as never,
      admissionService: {
        admit: async () => ({
          reservationId: "lease-1",
          apiKeyId: input.authorization.id,
          released: false,
          commitUsage: async () => {},
          release: async () => {},
        }),
      } as never,
    };

    const stateStore = new ProxyRequestStateStore();
    const request = new Request("https://gateway.test/v1/chat/completions", { method: "POST" });
    const state = stateStore.initialize(request, Date.now(), 60_000);
    state.preparedRequest = preparedRequest;
    if (input.clientAddress !== undefined) {
      state.clientIdentity = { address: input.clientAddress, source: "tcp-peer" };
    }

    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            if (table === promptInjections) return rows(input.stored);
            if (table === consoleSettings) return rows([]);
            return rows([
              {
                id: "account-1",
                providerId: "anthropic",
                credentialKind: "none",
                credentialCiphertext: null,
              },
            ]);
          },
        }),
      }),
    };

    let captured: CanonicalRequest | undefined;
    const adapter: ProviderAdapter = {
      provider_id: "anthropic",
      dispatch: async function* (dispatchRequest) {
        captured = dispatchRequest;
        yield terminal();
      },
    };

    const deps: ProviderProxyHandlerDeps = {
      db: db as never,
      providerAdapters: new Map([["anthropic", adapter]]),
      stateStore,
    };

    const response = await handleProviderProxyRequest(request, deps);
    return captured === undefined
      ? { status: response.status }
      : { status: response.status, captured };
  }

  function systemTexts(captured: CanonicalRequest | undefined): string[] {
    return (captured?.system ?? [])
      .filter((part) => part.kind === "text")
      .map((part) => (part.kind === "text" ? part.text : ""));
  }

  test("applies the stored stack before the adapter encodes the request", async () => {
    invalidatePromptInjectionCache();
    const { status, captured } = await dispatchWith({
      authorization,
      stored: [
        injection({ content: "GLOBAL" }),
        injection({
          id: "row-2",
          scope: "key",
          target: authorization.id,
          content: "KEYED",
          position: "append",
        }),
        injection({
          id: "row-3",
          scope: "model",
          target: "claude-sonnet-4-5",
          content: "MODEL",
          position: "append",
        }),
      ],
    });
    expect(status).toBe(200);
    expect(systemTexts(captured)).toEqual(["GLOBAL", "KEYED", "MODEL"]);
    // The script-free stack must not disturb the conversation.
    expect(captured?.messages.map((message) => message.role)).toEqual(["user"]);
  });

  test("an exclusion naming a share template also skips that template's child key", async () => {
    invalidatePromptInjectionCache();
    const child: ResolvedApiKey = {
      id: "child-key",
      tenantId,
      scopes: [],
      snapshot: { api_key_id: "child-key", tenant_id: tenantId },
      parentKeyId: "parent-template",
    };
    const { status, captured } = await dispatchWith({
      authorization: child,
      stored: [injection({ content: "GLOBAL", excludedApiKeyIds: ["parent-template"] })],
    });
    expect(status).toBe(200);
    expect(systemTexts(captured)).toEqual([]);
  });

  test("a client-IP exclusion reaches dispatch with the authenticated address", async () => {
    invalidatePromptInjectionCache();
    const { captured } = await dispatchWith({
      authorization,
      clientAddress: "203.0.113.7",
      stored: [injection({ content: "GLOBAL", excludedClientIps: ["203.0.113.7"] })],
    });
    expect(systemTexts(captured)).toEqual([]);
  });

  test("a provider exclusion is resolved from the candidate, not the request", async () => {
    // The client asked for "fast"; the provider is a routing decision. Only the
    // candidate list carries it, so this test fails unless dispatch forwards
    // the candidate provider ids to the resolver.
    invalidatePromptInjectionCache();
    const skipped = await dispatchWith({
      authorization,
      stored: [injection({ content: "GLOBAL", excludedProviders: ["anthropic"] })],
    });
    expect(systemTexts(skipped.captured)).toEqual([]);

    invalidatePromptInjectionCache();
    const kept = await dispatchWith({
      authorization,
      stored: [injection({ content: "GLOBAL", excludedProviders: ["autoclaw"] })],
    });
    expect(systemTexts(kept.captured)).toEqual(["GLOBAL"]);
  });

  test("a model exclusion reaches dispatch under the resolved model id", async () => {
    invalidatePromptInjectionCache();
    const skipped = await dispatchWith({
      authorization,
      stored: [injection({ content: "GLOBAL", excludedModels: ["claude-sonnet-4-5"] })],
    });
    expect(systemTexts(skipped.captured)).toEqual([]);

    invalidatePromptInjectionCache();
    const kept = await dispatchWith({
      authorization,
      stored: [injection({ content: "GLOBAL", excludedModels: ["glm-5.3"] })],
    });
    expect(systemTexts(kept.captured)).toEqual(["GLOBAL"]);
  });
});
