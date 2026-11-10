import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProviderDispatchTarget, ProviderAdapter } from "../../../src/providers/provider-registry";
import { candidateFor, canonicalRequest, dispatchContext, dispatchJson } from "../../helpers/provider-dispatch";
import { createApiKeyAdapter } from "../../../src/providers/integrations/configured-provider";
import { modelsDevCatalog } from "../../../src/providers/discovery/models-dev-catalog";
import {
  OPENCODE_FREE_MODELS,
  OPENCODE_FREE_SPEC,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_SPEC,
  OPENCODE_ZEN_MODELS,
  OPENCODE_ZEN_SPEC,
} from "../../../src/providers/integrations/opencode";
import { _resetStableOpenCodeSessionsForTesting, _stableOpenCodeSessionCountForTesting, stableOpenCodeSessionId } from "../../../src/providers/integrations/opencode-fingerprint";
import { VERSION_SOURCES, _resetOpenCodeVersion, getOpenCodeVersion, resolveOpenCodeVersion } from "../../../src/providers/operations/client-versions";

const CHAT_OK: Record<string, unknown> = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
};

const TIERS: readonly {
  readonly id: ProviderDispatchTarget["provider_id"];
  readonly create: (fetchImpl: typeof fetch) => ProviderAdapter;
  readonly path: string;
  readonly forwardsCredential: boolean;
  readonly desktopHeaders: boolean;
}[] = [
  {
    id: "opencodeft",
    create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
    path: "/zen/v1/chat/completions",
    forwardsCredential: false,
    desktopHeaders: true,
  },
  {
    id: "opencodezen",
    create: (fetchImpl) => createApiKeyAdapter(OPENCODE_ZEN_SPEC, fetchImpl),
    path: "/zen/v1/chat/completions",
    forwardsCredential: true,
    desktopHeaders: true,
  },
  {
    id: "opencodego",
    create: (fetchImpl) => createApiKeyAdapter(OPENCODE_GO_SPEC, fetchImpl),
    path: "/zen/go/v1/chat/completions",
    forwardsCredential: true,
    desktopHeaders: false,
  },
];

describe("OpenCode provider header policy", () => {
  test("Free withholds the credential; Zen and Go forward it", async () => {
    for (const tier of TIERS) {
      const captured = await dispatchJson({
        create: tier.create,
        candidate: candidateFor(tier.id, "chat", tier.path),
        context:
          tier.id === "opencodeft"
            ? dispatchContext(tier.id, { credential_kind: "none" })
            : dispatchContext(tier.id),
      });

      expect(captured.url).toContain(tier.path);
      // Free injects the hard-coded `Bearer public`; Zen/Go forward the
      // account secret.
      const expectedAuth = tier.id === "opencodeft"
        ? "Bearer public"
        : tier.forwardsCredential
          ? "Bearer test-secret-token"
          : null;
      expect(captured.headers["authorization"] ?? null).toBe(expectedAuth);
      expect(captured.headers["x-opencode-client"] ?? null).toBe(
        tier.desktopHeaders ? "desktop" : null,
      );
    }
  });

  test("Zen reuses the stable session per credential and mints a fresh request id each dispatch", async () => {
    // `x-opencode-session` is the client handle: it carries prompt-cache
    // affinity and identifies the conversation upstream. Minting a new session
    // per dispatch would look like a brand-new client every turn. The adapter
    // caches a session per (credential, egress) pair; repeat dispatches of the
    // same pair reuse it, request ids stay fresh.
    _resetStableOpenCodeSessionsForTesting();
    const sessions = new Set<string>();
    const requests = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const captured = await dispatchJson({
        create: (fetchImpl) => createApiKeyAdapter(OPENCODE_ZEN_SPEC, fetchImpl),
        candidate: candidateFor("opencodezen", "chat", "/zen/v1/chat/completions"),
      });
      const session = captured.headers["x-opencode-session"] ?? "";
      const request = captured.headers["x-opencode-request"] ?? "";
      const userAgent = captured.headers["user-agent"] ?? "";
      const project = captured.headers["x-opencode-project"];

      expect(session).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(session).toHaveLength(30);
      expect(request).toMatch(/^msg_[0-9a-f]{30}$/);
      expect(project).toBe("global");
      expect(userAgent).toMatch(/^opencode\/\d+\.\d+\.\d+/);
      const semverPart = userAgent.replace("opencode/", "");
      const [major, minor] = semverPart.split(".").map((n) => parseInt(n, 10));
      expect((major ?? 0) > 1 || ((major ?? 0) === 1 && (minor ?? 0) >= 18)).toBe(true);

      sessions.add(session);
      // Request ids must be unique per dispatch (the real CLI mints a new one
      // per user turn); if dedupe ever broke this, upstream correlation would
      // collapse every request onto one logical message.
      expect(requests.has(request)).toBe(false);
      requests.add(request);
    }
    // All dispatches shared one credential identity → one cached session.
    expect(sessions.size).toBe(1);
  });

  test("Go keeps API-key auth on the separate base and disables response storage", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_GO_SPEC, fetchImpl),
      candidate: candidateFor("opencodego", "responses", "/zen/go/v1/responses"),
      request: canonicalRequest({ surface: "responses" }),
    });

    expect(captured.url).toContain("/zen/go/v1/responses");
    expect(captured.headers["authorization"]).toBe("Bearer test-secret-token");
    expect(captured.headers["x-opencode-client"]).toBeUndefined();
    expect(captured.body["store"]).toBe(false);
  });

  test("drops incompatible prompt cache fields on Responses requests", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "responses", "/zen/v1/responses"),
      request: { ...canonicalRequest({ surface: "responses" }), cache_hint: "stable_prefix" },
      context: dispatchContext("opencodeft", { credential_kind: "none" }),
    });

    expect(captured.body["prompt_cache_options"]).toBeUndefined();
    expect(captured.body["prompt_cache_breakpoint"]).toBeUndefined();
    expect(captured.body["prompt_cache_key"]).toBeUndefined();
  });

  test("completes every OpenCode tool schema required list", async () => {
    const captured = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "responses", "/zen/v1/responses"),
      context: dispatchContext("opencodeft", { credential_kind: "none" }),
      request: {
        ...canonicalRequest({ surface: "responses" }),
        tools: [
          {
            name: "lookup",
            jsonSchema: {
              type: "object",
              properties: {
                command: { type: "string" },
                async: { type: "boolean" },
                options: {
                  type: "object",
                  properties: {
                    cwd: { type: "string" },
                    pty: { type: "boolean" },
                  },
                  required: ["cwd"],
                },
              },
              required: ["command"],
            },
          },
        ],
      },
    });
    const tools = captured.body.tools as Array<Record<string, unknown>>;
    const lookup = tools.find((tool) => tool.name === "lookup");
    const parameters = lookup?.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, unknown>;
    const options = properties.options as Record<string, unknown>;
    expect(parameters.required).toEqual(["command", "async", "options"]);
    expect(options.required).toEqual(["cwd", "pty"]);
  });

  test("backfills the read/bash agent fingerprint on Free Responses payloads", async () => {
    const free = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "responses", "/zen/v1/responses"),
      request: canonicalRequest({ surface: "responses" }),
    });
    const tools = free.body["tools"] as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool["name"])).toEqual(["bash", "glob", "grep", "read"]);
    expect(free.body["stream"]).toBe(true);
  });

  test("preserves Studio tools while backfilling the Free agent fingerprint", async () => {
    const free = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions"),
      request: { ...canonicalRequest(), tools: [{ name: "printf", jsonSchema: { type: "object" } }] },
    });
    const tools = free.body["tools"] as Array<Record<string, unknown>>;
    expect(tools.map((tool) => (tool["function"] as Record<string, unknown>)?.["name"])).toEqual([
      "printf",
      "bash",
      "glob",
      "grep",
      "read",
    ]);
  });

  test("clamps a caller output budget above the catalog limit to the model's output limit", async () => {
    // MiMo's 1M-context sibling makes clients send max_tokens: 1000000; the
    // shared Zen upstream rejects input + max_tokens over the context window
    // with a 400 before generating a single token (observed 2026-10-07).
    const free = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions", "mimo-v2.6-flash-free"),
      request: {
        ...canonicalRequest(),
        generation_controls: { max_tokens: 1_000_000, max_completion_tokens: 1_000_000 },
      },
      context: dispatchContext("opencodeft", { credential_kind: "none" }),
    });
    expect(free.body["max_tokens"]).toBe(32_000);
    expect(free.body["max_completion_tokens"]).toBe(32_000);

    // A budget at or below the limit passes through untouched.
    const within = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions", "mimo-v2.6-flash-free"),
      request: { ...canonicalRequest(), generation_controls: { max_tokens: 4_096 } },
      context: dispatchContext("opencodeft", { credential_kind: "none" }),
    });
    expect(within.body["max_tokens"]).toBe(4_096);

    // Unknown model ids are untouched (no catalog row, no guess).
    const unknown = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions", "test-model"),
      request: { ...canonicalRequest(), generation_controls: { max_tokens: 1_000_000 } },
      context: dispatchContext("opencodeft", { credential_kind: "none" }),
    });
    expect(unknown.body["max_tokens"]).toBe(1_000_000);
  });

  test("never duplicates caller-declared agent tools on Free payloads", async () => {
    const free = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions"),
      request: {
        ...canonicalRequest(),
        tools: [
          { name: "read", jsonSchema: { type: "object" } },
          { name: "bash", jsonSchema: { type: "object" } },
        ],
      },
    });
    const tools = free.body["tools"] as Array<Record<string, unknown>>;
    expect(tools.map((tool) => (tool["function"] as Record<string, unknown>)?.["name"])).toEqual([
      "read",
      "bash",
      "glob",
      "grep",
    ]);
  });
});

/**
 * `x-opencode-session` is the client handle upstream attributes a request to.
 * These pin the two properties that make it one: a conversation keeps its
 * handle, and a different client — different account, or different egress
 * address — never inherits somebody else's. Quota is not among them: the free
 * allowance is keyed on the source address, not on this handle.
 */
describe("OpenCode session identity", () => {
  function freeContext(egress?: string) {
    return dispatchContext("opencodeft", { credential_kind: "none" }, egress);
  }

  test("two egress pools get different session ids", async () => {
    _resetStableOpenCodeSessionsForTesting();
    const viaA = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions"),
      context: freeContext("pool-a"),
    });
    const viaB = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions"),
      context: freeContext("pool-b"),
    });

    expect(viaA.headers["x-opencode-session"]).toMatch(/^ses_/);
    expect(viaA.headers["x-opencode-session"]).not.toBe(viaB.headers["x-opencode-session"]);
  });

  test("one egress pool reuses one session id across dispatches", async () => {
    _resetStableOpenCodeSessionsForTesting();
    const first = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions"),
      context: freeContext("pool-a"),
    });
    const second = await dispatchJson({
      create: (fetchImpl) => createApiKeyAdapter(OPENCODE_FREE_SPEC, fetchImpl),
      candidate: candidateFor("opencodeft", "chat", "/zen/v1/chat/completions"),
      context: freeContext("pool-a"),
    });

    expect(second.headers["x-opencode-session"]).toBe(first.headers["x-opencode-session"]);
    // The request id still advances per turn.
    expect(second.headers["x-opencode-request"]).not.toBe(first.headers["x-opencode-request"]);
  });

  test("distinct accounts and direct egress are distinct clients", async () => {
    _resetStableOpenCodeSessionsForTesting();
    const sessions = new Set<string>();
    const contexts = [
      dispatchContext("opencodezen", { account_id: "account-1" }),
      dispatchContext("opencodezen", { account_id: "account-2" }),
      dispatchContext("opencodezen", { credential_kind: "none" }, "pool-a"),
    ];
    for (const context of contexts) {
      const captured = await dispatchJson({
        create: (fetchImpl) => createApiKeyAdapter(OPENCODE_ZEN_SPEC, fetchImpl),
        candidate: candidateFor("opencodezen", "chat", "/zen/v1/chat/completions"),
        context,
      });
      sessions.add(captured.headers["x-opencode-session"] ?? "");
    }

    expect(sessions.size).toBe(contexts.length);
  });

  test("a spent free-tier allowance rotates the session for the retry", async () => {
    _resetStableOpenCodeSessionsForTesting();
    const limitBody = {
      type: "error",
      error: {
        type: "FreeUsageLimitError",
        message: "Free usage limit reached. Subscribe to OpenCode Go to keep going.",
      },
    };
    let attempt = 0;
    const sessions: string[] = [];
    const adapter = createApiKeyAdapter(OPENCODE_FREE_SPEC, (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      sessions.push(new Headers(init?.headers as HeadersInit).get("x-opencode-session") ?? "");
      attempt += 1;
      return attempt === 1
        ? new Response(JSON.stringify(limitBody), { status: 429, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify(CHAT_OK), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch);

    const context = freeContext("pool-a");
    const target = candidateFor("opencodeft", "chat", "/zen/v1/chat/completions");
    const request = canonicalRequest();

    await expect(async () => {
      for await (const _event of adapter.dispatch(request, target, context)) {
        // drain
      }
    }).toThrow(/FreeUsageLimitError|OpenCode Free usage limit/);
    // The retry is a new client: same identity, same egress, fresh handle.
    for await (const _event of adapter.dispatch(request, target, context)) {
      // drain
    }

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).not.toBe(sessions[1]);
  });

  test("a plain 429 and a 500 keep the session", async () => {
    for (const [status, body] of [
      [429, { error: { message: "slow down" } }],
      [500, { error: { message: "upstream exploded" } }],
    ] as const) {
      _resetStableOpenCodeSessionsForTesting();
      const sessions: string[] = [];
      const adapter = createApiKeyAdapter(OPENCODE_FREE_SPEC, (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        sessions.push(new Headers(init?.headers as HeadersInit).get("x-opencode-session") ?? "");
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch);

      const context = freeContext("pool-a");
      const target = candidateFor("opencodeft", "chat", "/zen/v1/chat/completions");
      for (let dispatch = 0; dispatch < 2; dispatch += 1) {
        await expect(async () => {
          for await (const _event of adapter.dispatch(canonicalRequest(), target, context)) {
            // drain
          }
        }).toThrow();
      }

      expect(sessions).toHaveLength(2);
      expect(sessions[1]).toBe(sessions[0]);
    }
  });

  test("the session map stays bounded by its cap", async () => {
    _resetStableOpenCodeSessionsForTesting();
    for (let index = 0; index < 1_005; index += 1) {
      stableOpenCodeSessionId(dispatchContext("opencodeft", { credential_kind: "none" }, `pool-${index}`));
    }

    expect(_stableOpenCodeSessionCountForTesting()).toBe(1_000);
  });
});

describe("OpenCode bundled catalog", () => {
  /**
   * Tenant aliases and fallback combos address this model by name
   * (`mimo-2.6-flash` → `opencodeft/mimo-v2.6-flash-free`). `seedBundledModels`
   * prunes every `builtin` row the catalog stops declaring, so dropping the row
   * silently turns each alias into `model_not_found` for a model the live
   * endpoint still serves.
   */
  test("declares the MiMo flash model every tier's aliases target", () => {
    for (const models of [OPENCODE_FREE_MODELS, OPENCODE_ZEN_MODELS]) {
      const mimo = models.find((model) => model.modelId === "mimo-v2.6-flash-free");

      expect(mimo).toBeDefined();
      expect(mimo?.wireFamily).toBe("chat");
      expect(mimo?.endpointPath).toBe("/zen/v1/chat/completions");
      expect(mimo?.contextLimit).toBe(200_000);
      expect(mimo?.outputLimit).toBe(32_000);
      expect(mimo?.modalities.input).toEqual(["text", "image", "document", "audio"]);
      expect(mimo?.reasoning).toBe(true);
    }
  });

  /**
   * The free tier rotates: ids upstream deprecates must leave the catalog, and
   * replacements must declare explicit limits when the committed snapshot
   * predates them. `step-5-preview-free` and `mimo-v2.5-free` were dropped
   * upstream (both answered `502 Unexpected server error`); the current
   * replacements below were verified live against `GET /zen/v1/models`.
   */
  test("declares the snapshot-predated free rows with explicit limits", () => {
    for (const models of [OPENCODE_FREE_MODELS, OPENCODE_ZEN_MODELS]) {
      const beam = models.find((model) => model.modelId === "beam-free");

      expect(beam).toBeDefined();
      expect(beam?.wireFamily).toBe("chat");
      expect(beam?.endpointPath).toBe("/zen/v1/chat/completions");
      expect(beam?.contextLimit).toBe(1_048_576);
      expect(beam?.outputLimit).toBe(131_072);
      expect(beam?.modalities.input).toEqual(["text"]);
      expect(beam?.reasoning).toBe(true);
      expect(beam?.cost.input).toBe(0);
      expect(beam?.cost.output).toBe(0);
    }
  });

  /**
   * The `-free` ids are the free tier's current serving of these families
   * (200k/32k per models.dev's current data, image input on DeepSeek, the
   * full multimodal quartet on GLM). The bare ids stay paid-tier-only: the
   * free tier dispatching them answered `502 Unexpected server error`.
   */
  test("declares the -free DeepSeek and GLM flash rows on Free", () => {
    const deepseek = OPENCODE_FREE_MODELS.find((model) => model.modelId === "deepseek-v4.1-flash-free");
    expect(deepseek).toBeDefined();
    expect(deepseek?.wireFamily).toBe("chat");
    expect(deepseek?.endpointPath).toBe("/zen/v1/chat/completions");
    expect(deepseek?.contextLimit).toBe(200_000);
    expect(deepseek?.outputLimit).toBe(32_000);
    expect(deepseek?.modalities.input).toEqual(["text", "image"]);
    expect(deepseek?.reasoning).toBe(true);
    expect(deepseek?.cost.input).toBe(0);

    const glm = OPENCODE_FREE_MODELS.find((model) => model.modelId === "glm-5.3-flash-free");
    expect(glm).toBeDefined();
    expect(glm?.wireFamily).toBe("chat");
    expect(glm?.endpointPath).toBe("/zen/v1/chat/completions");
    expect(glm?.contextLimit).toBe(200_000);
    expect(glm?.outputLimit).toBe(32_000);
    expect(glm?.modalities.input).toEqual(["text", "image", "document", "audio"]);
    expect(glm?.reasoning).toBe(true);
  });

  test("declares the live free-tier additions with snapshot limits", () => {
    // Verified live by generating once per id on 2026-10-25: both answer on
    // `/zen/v1/chat/completions`. A 403 from the gate would only have proved the
    // id is accepted, not that it still serves.
    const lightning = OPENCODE_FREE_MODELS.find(
      (model) => model.modelId === "nemotron-3.5-lightning-free",
    );
    expect(lightning).toBeDefined();
    expect(lightning?.endpointPath).toBe("/zen/v1/chat/completions");
    expect(lightning?.contextLimit).toBe(262_144);
    expect(lightning?.outputLimit).toBe(262_144);
    expect(lightning?.modalities.input).toEqual(["text"]);
    expect(lightning?.reasoning).toBe(true);
    expect(lightning?.cost.input).toBe(0);
    expect(lightning?.cost.output).toBe(0);

    const minimax = OPENCODE_FREE_MODELS.find(
      (model) => model.modelId === "minimax-m3.1-flash-free",
    );
    expect(minimax).toBeUndefined();

    const flint = OPENCODE_FREE_MODELS.find((model) => model.modelId === "flint-40b-free");
    expect(flint).toBeDefined();
    expect(flint?.wireFamily).toBe("chat");
    expect(flint?.endpointPath).toBe("/zen/v1/chat/completions");
    expect(flint?.contextLimit).toBe(262_144);
    expect(flint?.outputLimit).toBe(65_536);
    expect(flint?.modalities.input).toEqual(["text"]);
    expect(flint?.reasoning).toBe(true);
    expect(flint?.cost.input).toBe(0);
    expect(flint?.cost.output).toBe(0);
  });

  test("keeps the bare DeepSeek and GLM flash ids off the Free tier", () => {
    for (const stale of [
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
      "step-5-preview-free",
      "mimo-v2.5-free",
      "longcat-2.5-preview-free",
      "minimax-m3.1-flash-free",
    ]) {
      expect(OPENCODE_FREE_MODELS.find((model) => model.modelId === stale)).toBeUndefined();
    }
    // The live `/zen/v1/models` free set, minus `jev-1.13-free` (System One
    // protocol on `/zen/v1/systemone`, not a chat row this catalog can serve).
    const freeIds = OPENCODE_FREE_MODELS.map((model) => model.modelId).sort();
    expect(freeIds).toEqual([
      "beam-free",
      "big-pickle",
      "deepseek-v4.1-flash-free",
      "flint-40b-free",
      "glm-5.3-flash-free",
      "mimo-v2.6-flash-free",
      "muse-spark-1.2-contributor-free",
      "muse-spark-1.3-contributor-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
      "nemotron-3.5-super-vl-free",
    ]);
    // Paid tier keeps the snapshot-covered bare rows.
    for (const bare of ["deepseek-v4.1-flash", "glm-5.3-flash"]) {
      const row = OPENCODE_ZEN_MODELS.find((model) => model.modelId === bare);
      expect(row).toBeDefined();
      expect(row?.endpointPath).toBe("/zen/v1/chat/completions");
    }
  });

  /**
   * Retired ids must not stay in the catalog: a row that cannot generate is a
   * routing candidate that fails every dispatch. Measured 2026-10-25 —
   * `minimax-m3.1-flash-free` and both `muse-spark-*-contributor-free` ids
   * answer `410 ModelDeprecated`; `union-alpha` answers `400` "Model is
   * unavailable" on both `/chat/completions` and `/messages`.
   * `longcat-2.5-preview-free` is a different case: it passes the gate but was
   * never proven to generate, so it is retired as unverified rather than dead.
   */
  test("does not declare tombstoned or unverified free ids", () => {
    const retired = [
      "minimax-m3.1-flash-free",
      "union-alpha",
      "longcat-2.5-preview-free",
    ];
    for (const id of retired) {
      expect({ id, present: OPENCODE_FREE_MODELS.some((model) => model.modelId === id) }).toEqual({
        id,
        present: false,
      });
    }
  });

  /**
   * `union-alpha` was the free tier's only Messages model. With it gone the
   * family has no row behind it, and a declared-but-empty family turns a
   * capability map into a failure path: the adapter would accept a Messages
   * candidate and post an Anthropic-shaped payload at a route this catalog
   * cannot serve. (The shared factory does serialize the `messages` wire; the
   * omission is about having no model, not about a missing codec.)
   */
  test("declares only the wire families its catalog can serve", () => {
    for (const spec of [OPENCODE_FREE_SPEC, OPENCODE_ZEN_SPEC, OPENCODE_GO_SPEC]) {
      expect(spec.supported_wire_families).toEqual(["chat", "responses"]);
      expect(spec.endpoint_paths_by_wire_family?.messages).toBeUndefined();
    }
  });

  /**
   * A hardcoded `ctx`/`out` silently overrides the committed models.dev
   * snapshot, and a wrong limit is not cosmetic: an overstated context lets
   * through a request the upstream then rejects, while an understated one caps
   * what the model can serve. Every row the snapshot covers must therefore
   * agree with it; a row the snapshot predates must declare its own limits
   * instead of inheriting the generic default.
   */
  test("limits agree with the models.dev snapshot on every tier", () => {
    const tiers = [
      ["opencodeft", OPENCODE_FREE_MODELS, "opencode"],
      ["opencodezen", OPENCODE_ZEN_MODELS, "opencode"],
      ["opencodego", OPENCODE_GO_MODELS, "opencode-go"],
    ] as const;

    for (const [tier, models, providerId] of tiers) {
      for (const model of models) {
        const label = `${tier}/${model.modelId}`;
        const entry = modelsDevCatalog.resolve(providerId, model.modelId);
        if (!entry || entry.contextLimit == null || entry.outputLimit == null) {
          expect({ model: label, ctx: model.contextLimit }).not.toEqual({ model: label, ctx: null });
          expect({ model: label, out: model.outputLimit }).not.toEqual({ model: label, out: null });
          continue;
        }
        expect({ model: label, ctx: model.contextLimit, out: model.outputLimit }).toEqual({
          model: label,
          ctx: entry.contextLimit,
          out: entry.outputLimit,
        });
      }
    }
  });
});

describe("OpenCode client version floor", () => {
  const registryAnswer = (version: string): typeof fetch =>
    (async () =>
      new Response(JSON.stringify({ version }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  // Both ends: a version cached by an earlier suite would otherwise answer
  // before this test's fetcher is ever consulted.
  beforeEach(() => {
    _resetOpenCodeVersion();
  });
  afterEach(() => {
    _resetOpenCodeVersion();
  });

  /**
   * The free gate answers `426 UpgradeRequired` for any `user-agent` below
   * 1.18.0. A registry publishing an older artifact must therefore never
   * replace the pinned fallback, or every free dispatch fails at the gate
   * instead of at the model.
   */
  test("a discovered version below the floor keeps the pinned fallback", async () => {
    const resolved = await resolveOpenCodeVersion(registryAnswer("1.17.9"));
    expect(resolved).toBe(VERSION_SOURCES.opencode.fallback);
    expect(getOpenCodeVersion()).toBe("1.18.32");
  });

  test("a discovered version at or above the floor is adopted", async () => {
    const resolved = await resolveOpenCodeVersion(registryAnswer("1.18.34"));
    expect(resolved).toBe("1.18.34");
  });
});
