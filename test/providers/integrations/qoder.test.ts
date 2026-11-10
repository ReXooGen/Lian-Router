import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  VERSION_SOURCES,
  getQoderVersion,
  resolveQoderVersion,
  _resetQoderVersion,
} from "../../../src/providers/operations/client-versions";
import {
  CN_PROFILE,
  MODERN_PROFILE,
  QODER_CN_MODEL_CONFIGS,
  QODER_CN_MODELS,
  QODER_MODEL_CONFIGS,
  QODER_REGION_PROFILES,
  buildQoderRequest,
  createQoderAdapter,
  createQoderCnAdapter,
  parseQoderModelList,
  qoderResolveEffort,
  QODER_MODELS,
} from "../../../src/providers/integrations/qoder";
import { QODER_SYSTEM_PROMPT } from "../../../src/providers/integrations/qoder-system-prompt";
import { classifyUpstreamFailure } from "../../../src/transport/failure-policy";
import type { QoderAuth } from "../../../src/providers/integrations/qoder";
import type { CanonicalEvent, CanonicalRequest } from "../../../src/transport/canonical-model";
import type { ProviderDispatchContext, ProviderDispatchTarget } from "../../../src/providers/provider-registry";

/** Body construction never embeds auth, so one constant serves every call. */
const FAKE_AUTH: QoderAuth = {
  userId: "user-1",
  userName: "operator",
  userType: "personal_standard",
  securityOauthToken: "oauth-token",
  refreshToken: "refresh-token",
  machineId: "machine-1",
};
describe("Qoder dynamic version resolver", () => {
  beforeEach(() => {
    _resetQoderVersion();
  });
  afterEach(() => {
    _resetQoderVersion();
  });

  test("defaults to the pinned modern fallback", () => {
    expect(getQoderVersion()).toBe(VERSION_SOURCES.qoder.fallback);
  });

  test("resolves latest version from registry", async () => {
    const fakeFetch = (async (url: string | URL | Request) => {
      expect(String(url)).toBe(VERSION_SOURCES.qoder.sources[0].url);
      return new Response(JSON.stringify({ version: "1.1.58" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const resolved = await resolveQoderVersion(fakeFetch);
    expect(resolved).toBe("1.1.58");
    expect(getQoderVersion()).toBe("1.1.58");
  });

  test("falls back to pinned version on network failure", async () => {
    const failingFetch = (async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;

    const resolved = await resolveQoderVersion(failingFetch);
    expect(resolved).toBe(VERSION_SOURCES.qoder.fallback);
  });
});

describe("Qoder image turns", () => {
  /**
   * An image turn carries the same part array on `content` *and* `contents`.
   *
   * The upstream reads `contents` when a turn holds an image: the native client
   * builds one array and assigns it to both fields. A text-only `contents`
   * mirror leaves the image invisible to the model, which then answers that no
   * image was attached even though `content` carries it.
   *
   * `chat_context.text` is the instruction the model actually reads. Reading it
   * back off the built message only handled string content, so an image turn
   * left it empty and the model answered "I don't see one attached".
   */
  test("mirrors the image parts into contents and keeps the instruction in chat_context", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const body = buildQoderRequest(
      "kmodel_latest",
      {
        model: "kmodel_latest",
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "What shapes are in this image?" },
              { kind: "image", payload: { url: dataUrl } },
            ],
          },
        ],
        generation_controls: {},
        stream: false,
        source_surface: "chat",
      },
      QODER_MODEL_CONFIGS["kmodel_latest"]!,
      FAKE_AUTH,
    );

    const messages = body["messages"] as Array<Record<string, unknown>>;
    const user = messages[1]!;
    const content = user["content"] as Array<Record<string, unknown>>;
    const contents = user["contents"] as Array<Record<string, unknown>>;
    expect(content.map((part) => part["type"])).toEqual(["text", "image_url"]);
    expect(contents.map((part) => part["type"])).toEqual(["text", "image_url"]);
    expect((content[1]?.["image_url"] as Record<string, unknown>)["url"]).toBe(dataUrl);
    expect((contents[1]?.["image_url"] as Record<string, unknown>)["url"]).toBe(dataUrl);
    // The model reads its instruction from here.
    expect((body["chat_context"] as Record<string, unknown>)["text"]).toBe("What shapes are in this image?");
    // The catalog declares vision, so the upstream routes it to a vision model.
    expect((body["model_config"] as Record<string, unknown>)["is_vl"]).toBe(true);
  });
});

describe("Qoder tool-call streaming", () => {
  /**
   * Qoder names a call once, on its first fragment. A continuation that invents
   * a placeholder id reads downstream as a second nameless call, and the
   * assembled tool call then loses both its `id` and its `name` — the client
   * receives `{"id":"","name":""}` and cannot execute anything.
   */
  test("repeats the call id and name across continuation fragments", async () => {
    const fragments = [
      { index: 0, id: "call_abc", function: { name: "get_weather", arguments: "" } },
      { index: 0, function: { arguments: '{"city":' } },
      { index: 0, function: { arguments: '"Jakarta"}' } },
    ];
    const frame = `data:${JSON.stringify({
      statusCodeValue: 200,
      body: JSON.stringify({
        choices: fragments.map((tc, i) => ({
          delta: { tool_calls: [tc] },
          finish_reason: i === fragments.length - 1 ? "tool_calls" : null,
        })),
      }),
    })}\n\n`;
    const fakeFetch = (async (input: string | URL | Request) => {
      const target = String(input);
      if (target.includes("jobToken")) {
        return new Response(JSON.stringify({ id: "u-test", securityOauthToken: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (!target.includes("agent_chat_generation")) {
        return new Response(JSON.stringify({ version: "1.1.81" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const deltas: Array<{ id: string; name?: string; args: string }> = [];
    for await (const event of createQoderAdapter({ fetch: fakeFetch }).dispatch(
      {
        model: "fast",
        messages: [{ role: "user", content: [{ kind: "text", text: "weather?" }] }],
        tools: [{ name: "get_weather", description: "weather", jsonSchema: { type: "object" } }],
        generation_controls: {},
        stream: true,
        source_surface: "chat",
      },
      { provider_id: "qoder", model_id: "fast", wire_family: "chat", endpoint_path: "", capabilities: {} },
      {
        credential: {
          provider_id: "qoder",
          credential_kind: "api_key",
          secret: new TextEncoder().encode("pat"),
        },
        deadline: Date.now() + 30_000,
        abort_signal: new AbortController().signal,
      },
    )) {
      if (event.type === "tool_call_delta") {
        deltas.push({
          id: event.call_id,
          ...(event.name === undefined ? {} : { name: event.name }),
          args: event.arguments_delta ?? "",
        });
      }
    }

    expect(deltas).toHaveLength(3);
    // One call, not three: every fragment reports the same identity.
    expect(new Set(deltas.map((delta) => delta.id))).toEqual(new Set(["call_abc"]));
    expect(deltas.every((delta) => delta.name === "get_weather")).toBe(true);
    expect(deltas.map((delta) => delta.args).join("")).toBe('{"city":"Jakarta"}');
  });
});

describe("Qoder device identity", () => {
  /**
   * Qoder binds a PAT to the machine that first exchanged it and throttles on
   * device count (`RESOURCE_LIMIT` / `10605`). A random id per process makes
   * every gateway restart look like a new machine using the same credential,
   * which is what a healthy account was being punished for.
   */
  test("derives one stable device id per PAT, shaped as a UUID", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input);
      if (target.includes("jobToken")) {
        // The exchange headers carry the machine id; capture what was sent.
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push(String(headers["cosy-machineid"] ?? ""));
        return new Response(JSON.stringify({ id: "u-test", securityOauthToken: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (!target.includes("agent_chat_generation")) {
        return new Response(JSON.stringify({ version: "1.1.81" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const frame = `data:${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }) })}\n\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const run = async (): Promise<void> => {
      for await (const _ of createQoderAdapter({ fetch: fakeFetch }).dispatch(
        {
          model: "fast",
          messages: [{ role: "user", content: [{ kind: "text", text: "Say OK" }] }],
          generation_controls: {},
          stream: false,
          source_surface: "chat",
        },
        { provider_id: "qoder", model_id: "fast", wire_family: "chat", endpoint_path: "", capabilities: {} },
        {
          credential: {
            provider_id: "qoder",
            credential_kind: "api_key",
            secret: new TextEncoder().encode("pat_stable_device"),
          },
          deadline: Date.now() + 30_000,
          abort_signal: new AbortController().signal,
        },
      )) void _;
    };
    await run();
    await run();

    expect(seen).toHaveLength(2);
    // Same PAT across two independent dispatches must present the same device.
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("Qoder catalog", () => {
  test("every advertised row carries the model's own effort ladder", () => {
    const qwen = QODER_MODELS.find((row) => row.modelId === "qmodel_38max");
    expect(qwen?.reasoningEfforts).toEqual(["low", "medium", "xhigh"]);
    // A model with no `thinking_config` publishes no ladder at all, so the
    // adapter must not forward an effort it would silently drop.
    expect(QODER_MODELS.find((row) => row.modelId === "auto")?.reasoningEfforts).toBeUndefined();
    expect(QODER_MODELS.every((row) => row.wireFamily === "chat")).toBe(true);
    // The live catalog prices `qfmodel` at zero (`is_free`); carrying the base
    // catalog's rate for the underlying model would bill a free tier.
    const free = QODER_MODELS.find((row) => row.modelId === "qfmodel");
    expect(free?.cost.input).toBe(0);
    expect(free?.cost.output).toBe(0);
  });

  test("parseQoderModelList reads the live chat catalog and its thinking ladders", () => {
    const parsed = parseQoderModelList({
      chat: [
        { key: "fast", display_name: "Fast", enable: true, is_vl: true, is_reasoning: false, max_input_tokens: 200_000 },
        {
          key: "gmodel",
          display_name: "GLM-5.3",
          enable: true,
          is_vl: true,
          is_reasoning: true,
          max_input_tokens: 180_000,
          thinking_config: { enabled: { efforts: { max: { is_default: true }, low: {}, high: {} }, is_default: true } },
        },
        { key: "retired", display_name: "Retired", enable: false, is_vl: false, is_reasoning: false },
      ],
    });
    expect(parsed?.map((row) => row.modelId)).toEqual(["fast", "gmodel"]);
    expect(parsed?.find((row) => row.modelId === "gmodel")?.reasoningEfforts).toEqual(["low", "high", "max"]);
    expect(parseQoderModelList({})).toBeNull();
  });
});

describe("Qoder Modern Profile contracts", () => {
  test("declares modern endpoint and business parameters", () => {
    expect(MODERN_PROFILE.chatUrl).toContain("https://api2.qoder.sh");
    expect(MODERN_PROFILE.businessProduct).toBe("cli");
    expect(MODERN_PROFILE.businessType).toBe("agent");
    expect(MODERN_PROFILE.cosyScene).toBe("assistant");
    expect(MODERN_PROFILE.mirrorTopLevelSystem).toBe(true);
    expect(MODERN_PROFILE.sendBusinessHeaders).toBe(true);
    expect(MODERN_PROFILE.sendModelSourceHeaders).toBe(true);
    expect(MODERN_PROFILE.emptyAliyunUserType).toBe(true);
  });

  test("buildQoderRequest opens with the vendor agent prompt and keeps the caller's system text after it", () => {
    const request: CanonicalRequest = {
      model: "efficient",
      system: [{ kind: "text", text: "You are an expert engineer." }],
      messages: [{ role: "user", content: [{ kind: "text", text: "Fix the bug" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };
    const body = buildQoderRequest("efficient", request, QODER_MODEL_CONFIGS["efficient"]!, FAKE_AUTH, MODERN_PROFILE, { sessionId: "session-1" });
    expect(body["aliyun_user_type"]).toBe("");
    // The upstream agent gateway identifies the calling channel by this text:
    // with tools declared and no agent prompt the model answers that it has no
    // tools. The caller's own prompt therefore rides after it, never instead.
    expect(body["system"]).toBe(`${QODER_SYSTEM_PROMPT}\n\nYou are an expert engineer.`);
    expect(body["session_id"]).toBe("session-1");
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["role"]).toBe("system");
    expect(messages[0]?.["content"]).toBe(body["system"]);
    expect(messages[1]?.["role"]).toBe("user");
    expect(messages[1]?.["content"]).toBe("Fix the bug");
    const business = body["business"] as Record<string, unknown>;
    expect(business["product"]).toBe("cli");
    expect(business["type"]).toBe("agent");
    expect(business["stage"]).toBe("start");
  });

  test("buildQoderRequest serializes the native body key order", () => {
    // The agent gateway fingerprints the serialized request, not just its
    // values: a body with the same fields in a different order is answered by
    // holding the request in the model queue (10605) instead of serving it.
    // This list is the order the official client emits and the order that was
    // verified live; changing it is a wire change, not a refactor.
    const request: CanonicalRequest = {
      model: "fast",
      messages: [{ role: "user", content: [{ kind: "text", text: "Say OK" }] }],
      generation_controls: { max_tokens: 16 },
      stream: true,
      source_surface: "chat",
    };
    const body = buildQoderRequest("fast", request, QODER_MODEL_CONFIGS["fast"]!, FAKE_AUTH);
    expect(Object.keys(body)).toEqual([
      "request_id",
      "request_set_id",
      "chat_record_id",
      "session_id",
      "stream",
      "aliyun_user_type",
      "chat_task",
      "is_reply",
      "is_retry",
      "source",
      "version",
      "agent_id",
      "task_id",
      "code_language",
      "chat_prompt",
      "image_urls",
      "chat_context",
      "model_config",
      "system",
      "messages",
      "tools",
      "parameters",
      "business",
    ]);
    // `chat_record_id` mirrors `request_id`; a queue retry rotates both while
    // `request_set_id` stays, which is what tells the upstream "already served".
    expect(body["chat_record_id"]).toBe(body["request_id"]);
    expect(body["request_set_id"]).not.toBe(body["request_id"]);
  });

  test("buildQoderRequest forwards declared tools and the model's own effort ladder", () => {
    const request: CanonicalRequest = {
      model: "qmodel_38max",
      messages: [{ role: "user", content: [{ kind: "text", text: "Weather in Jakarta?" }] }],
      tools: [
        {
          name: "get_weather",
          description: "Get current weather for a city",
          jsonSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
      tool_choice: "auto",
      reasoning: { effort: "max" },
      generation_controls: { max_tokens: 256 },
      stream: true,
      source_surface: "chat",
    };
    const body = buildQoderRequest("qmodel_38max", request, QODER_MODEL_CONFIGS["qmodel_38max"]!, FAKE_AUTH);
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect((tools[0]?.["function"] as Record<string, unknown>)["name"]).toBe("get_weather");
    const parameters = body["parameters"] as Record<string, unknown>;
    expect(parameters["tool_choice"]).toBe("auto");
    // Qwen3.8 stops at `xhigh`; a generic `max` is dropped silently upstream,
    // so the adapter clamps to the nearest accepted level instead.
    expect(parameters["reasoning_effort"]).toBe("xhigh");
    expect(parameters["enable_thinking"]).toBe(true);
  });

  test("buildQoderRequest omits thinking switches when the caller asked for no effort", () => {
    const request: CanonicalRequest = {
      model: "dmodel",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };
    const body = buildQoderRequest("dmodel", request, QODER_MODEL_CONFIGS["dmodel"]!, FAKE_AUTH);
    const parameters = body["parameters"] as Record<string, unknown>;
    expect(parameters["max_tokens"]).toBe(32_000);
    expect(parameters).not.toHaveProperty("reasoning_effort");
    expect(parameters).not.toHaveProperty("enable_thinking");
  });

  test("qoderResolveEffort clamps per model and honours a disabled arm only where published", () => {
    expect(qoderResolveEffort(QODER_MODEL_CONFIGS["dmodel"]!, "none")).toBe("none");
    expect(qoderResolveEffort(QODER_MODEL_CONFIGS["dmodel"]!, "low")).toBe("high");
    expect(qoderResolveEffort(QODER_MODEL_CONFIGS["gfmodel"]!, "low")).toBe("high");
    // ultimate publishes no `disabled` arm, so `none` falls to its lowest tier.
    expect(qoderResolveEffort(QODER_MODEL_CONFIGS["ultimate"]!, "none")).toBe("low");
    expect(qoderResolveEffort(QODER_MODEL_CONFIGS["auto"]!, "high")).toBe("none");
  });

  test("modern dispatch sends business headers, model headers, and modern endpoint", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedUrl = "";
    let capturedBodyBytes: Uint8Array | null = null;

    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      if (init?.body instanceof Uint8Array) capturedBodyBytes = init.body;
      if (capturedUrl.includes("jobToken")) {
        return new Response(
          JSON.stringify({
            id: "u-test",
            name: "test-user",
            userType: "personal_standard",
            securityOauthToken: "oauth-tok-123",
            refreshToken: "refresh-tok-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const frame = `data: ${JSON.stringify({
        statusCodeValue: 200,
        body: JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
      })}\n\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const target: ProviderDispatchTarget = {
      provider_id: "qoder",
      model_id: "efficient",
      wire_family: "chat",
      endpoint_path: "",
      capabilities: {},
    };
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
    };
    const request: CanonicalRequest = {
      model: "efficient",
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };

    for await (const _ of adapter.dispatch(request, target, ctx)) {
      // drain
    }

    expect(capturedUrl).toBe(MODERN_PROFILE.chatUrl);
    expect(capturedHeaders["cosy-business-product"]).toBe("cli");
    expect(capturedHeaders["cosy-business-type"]).toBe("agent");
    expect(capturedHeaders["cosy-scene"]).toBe("assistant");
    expect(capturedHeaders["x-model-key"]).toBe("efficient");
    expect(capturedHeaders["x-model-source"]).toBe("system");
    expect(capturedBodyBytes).not.toBeNull();
  });

  test("a 403 inside the stream envelope is credential evidence, not a bare status line", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      if (String(input).includes("jobToken")) {
        return new Response(
          JSON.stringify({
            id: "u-test",
            name: "test-user",
            userType: "personal_standard",
            securityOauthToken: "oauth-tok-123",
            refreshToken: "refresh-tok-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const frame = `data: ${JSON.stringify({
        statusCodeValue: 403,
        body: { error: { message: "Please run /login" } },
      })}\n\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const target: ProviderDispatchTarget = {
      provider_id: "qoder",
      model_id: "efficient",
      wire_family: "chat",
      endpoint_path: "",
      capabilities: {},
    };
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
    };
    const request: CanonicalRequest = {
      model: "efficient",
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };

    let thrown: unknown;
    try {
      for await (const _ of adapter.dispatch(request, target, ctx)) void _;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "authentication_failed",
      status: 403,
      message: "Please run /login",
      details: { credentialEvidence: true, providerId: "qoder" },
    });
  });

  test("a 403 envelope whose body is a bare string still surfaces that string", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      if (String(input).includes("jobToken")) {
        return new Response(
          JSON.stringify({ id: "u-test", securityOauthToken: "oauth-tok-123" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const frame = `data: ${JSON.stringify({ statusCodeValue: 403, body: "Please run /login" })}\n\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
    };
    const request: CanonicalRequest = {
      model: "efficient",
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };

    let thrown: unknown;
    try {
      for await (const _ of adapter.dispatch(
        request,
        { provider_id: "qoder", model_id: "efficient", wire_family: "chat", endpoint_path: "", capabilities: {} },
        ctx,
      )) void _;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ status: 403, message: "Please run /login" });
  });
});

describe("Qoder model queue (10605)", () => {
  /**
   * The queue verdict is upstream backpressure on the *model*, not a dead
   * credential: the native client waits and retries, and a router holding
   * several PATs rotates to a sibling instead. Both behaviours require the
   * failure to arrive as a retryable provider-scoped error — surfacing it as
   * `authentication_failed` would park a healthy account for a queue.
   */
  test("surfaces a 10605 envelope as retryable provider capacity, not a credential failure", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      if (String(input).includes("jobToken")) {
        return new Response(
          JSON.stringify({ id: "u-test", securityOauthToken: "oauth-tok-123" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const queued = JSON.stringify({
        code: "10605",
        message: JSON.stringify({ isQueued: true, retryAfterSeconds: 30, modelKey: "fast", queueType: "p3" }),
      });
      const frame = `data: ${JSON.stringify({ statusCodeValue: 403, body: queued })}\n\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      deadline: Date.now() + 10_000,
      abort_signal: new AbortController().signal,
    };

    let thrown: unknown;
    try {
      for await (const _ of adapter.dispatch(
        {
          model: "fast",
          messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
          generation_controls: {},
          stream: true,
          source_surface: "chat",
        },
        { provider_id: "qoder", model_id: "fast", wire_family: "chat", endpoint_path: "", capabilities: {} },
        ctx,
      )) void _;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "capacity_exhausted",
      status: 429,
      details: { providerId: "qoder", providerCode: "10605", rateLimitScope: "provider" },
    });
    const policy = classifyUpstreamFailure(thrown);
    expect(policy.retryable).toBe(true);
    // Rotating to a sibling PAT is the fix; the account itself stays healthy.
    expect(policy.mutatesAccount).toBe(false);
  });
});

/**
 * Reverses the adapter's body transform so a test can read the request it sent.
 *
 * The wire body is base64 with a scrambled alphabet and its thirds reordered;
 * the request ids live inside it, and asserting on them is the only way to
 * prove a queue retry is the same task.
 */
function decodeQoderBody(body: Uint8Array): Record<string, unknown> {
  const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const alphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
  const scrambled = Buffer.from(body).toString("latin1");
  let base64 = "";
  for (const char of scrambled) {
    base64 += char === "$" ? "=" : standard[alphabet.indexOf(char)] ?? char;
  }
  // Forward order was [last third, middle, first third]; reassemble it as
  // [first, middle, last] before decoding.
  const length = base64.length;
  const third = Math.floor(length / 3);
  const reordered =
    base64.slice(length - third) + base64.slice(third, length - third) + base64.slice(0, third);
  return JSON.parse(Buffer.from(reordered, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("Qoder queue recovery", () => {
  /**
   * A single-PAT provider has no sibling account to rotate to: the account IS
   * the provider. The upstream's `10605` envelope is a throttle that clears on
   * its own (its own status endpoint keeps answering `isQueued: false` while
   * the model still refuses), so the adapter waits the named delay and resends
   * with a rotated `request_id` and the same `request_set_id` — the recovery
   * the official client performs.
   */
  function queueFrame(modelKey: string): string {
    const queued = JSON.stringify({
      code: "10605",
      message: JSON.stringify({
        isQueued: true,
        modelKey,
        queueCount: 0,
        queueType: "p3",
        retryAfterSeconds: 1,
        serviceAvailable: false,
        subCode: "RESOURCE_LIMIT",
        waitTime: 1,
      }),
    });
    const envelope = JSON.stringify({ statusCodeValue: 403, body: queued });
    return `data:${envelope}\n\n`;
  }

  function contentFrame(text: string): string {
    const envelope = JSON.stringify({
      statusCodeValue: 200,
      body: JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] }),
    });
    return `data:${envelope}\n\n`;
  }

  test("waits out the named delay and resends instead of failing the account", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let chatCalls = 0;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("jobToken")) {
        return new Response(JSON.stringify({ id: "u-test", securityOauthToken: "oauth-tok-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Only the chat endpoint is the subject here: the adapter also resolves
      // the client version from npm, and answering that from this fake would
      // misreport a version lookup as a chat call.
      if (!url.includes("agent_chat_generation")) {
        return new Response(JSON.stringify({ version: "1.1.81" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      chatCalls += 1;
      bodies.push(decodeQoderBody(init?.body as Uint8Array));
      const frame = chatCalls === 1 ? queueFrame("qmodel_38max") : contentFrame("OK");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      // Generous: the queue budget is bounded by this deadline.
      deadline: Date.now() + 120_000,
      abort_signal: new AbortController().signal,
    };
    const events: CanonicalEvent[] = [];
    for await (const event of adapter.dispatch(
      {
        model: "qmodel_38max",
        messages: [{ role: "user", content: [{ kind: "text", text: "Say OK" }] }],
        generation_controls: { max_tokens: 16 },
        stream: false,
        source_surface: "chat",
      },
      { provider_id: "qoder", model_id: "qmodel_38max", wire_family: "chat", endpoint_path: "", capabilities: {} },
      ctx,
    )) events.push(event);

    expect(chatCalls).toBe(2);
    const text = events
      .map((event) => (event.type === "content_delta" && event.content.kind === "text" ? event.content.text : ""))
      .join("");
    expect(text).toBe("OK");
    // The retry is the same task: the set id survives, the request id rotates.
    expect(bodies[1]?.["request_set_id"]).toBe(bodies[0]?.["request_set_id"]);
    expect(bodies[1]?.["request_id"]).not.toBe(bodies[0]?.["request_id"]);
    // A queued attempt emits nothing before the successful one, so the caller
    // never sees a response start followed by a failure.
    expect(events.filter((event) => event.type === "response_start")).toHaveLength(1);
  });

  test("surfaces the queue when the wait would outlast the request deadline", async () => {
    let chatCalls = 0;
    const fakeFetch = (async (input: string | URL | Request) => {
      const target = String(input);
      if (target.includes("jobToken")) {
        return new Response(JSON.stringify({ id: "u-test", securityOauthToken: "oauth-tok-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (!target.includes("agent_chat_generation")) {
        return new Response(JSON.stringify({ version: "1.1.81" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      chatCalls += 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(queueFrame("qmodel_38max")));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      // Too short for even one wait: the verdict must surface, not hang.
      deadline: Date.now() + 5_000,
      abort_signal: new AbortController().signal,
    };
    let thrown: unknown;
    try {
      for await (const _ of adapter.dispatch(
        {
          model: "qmodel_38max",
          messages: [{ role: "user", content: [{ kind: "text", text: "Say OK" }] }],
          generation_controls: {},
          stream: false,
          source_surface: "chat",
        },
        { provider_id: "qoder", model_id: "qmodel_38max", wire_family: "chat", endpoint_path: "", capabilities: {} },
        ctx,
      )) void _;
    } catch (error) {
      thrown = error;
    }
    expect(chatCalls).toBe(1);
    expect(thrown).toMatchObject({ code: "capacity_exhausted", status: 429 });
  });
});

describe("Qoder pre-stream deadline release", () => {
  /**
   * The pre-stream deadline bounds TTFB only. Every other streaming adapter
   * releases the lifecycle once response headers arrive, with the comment
   * "the pre-stream deadline has served its purpose" (see `agentrouter.ts`,
   * `gemini.ts`, `antigravity.ts`, `commandcode.ts`), because from that point
   * the gateway's own stall/first-chunk watchdog owns the body.
   *
   * Qoder released only in `finally`, so its timer stayed armed across the
   * body. The failure is silent rather than loud: `decodeSseEvents` cancels its
   * reader on abort, so the read resolves as *done*, the loop exits, and
   * `qoderBodyToCanonicalEvents` then synthesizes a `state: "complete"`
   * terminal for a body it never finished reading. A healthy slow stream came
   * back as an empty successful response.
   */
  test("reads a body that outlives the pre-stream deadline", async () => {
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("jobToken")) {
        return new Response(
          JSON.stringify({
            id: "u-test",
            name: "test-user",
            userType: "personal_standard",
            securityOauthToken: "oauth-tok-123",
            refreshToken: "refresh-tok-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (!url.includes("agent_chat")) {
        return new Response(JSON.stringify({ version: "1.0.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const signal = init?.signal as AbortSignal | undefined;
      return new Response(
        new ReadableStream({
          async start(controller) {
            // The body arrives well after the deadline below has passed.
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (signal?.aborted) {
              controller.error(new Error("body aborted by the pre-stream deadline"));
              return;
            }
            const inner = JSON.stringify({
              choices: [{ delta: { content: "HELLO-FROM-BODY" }, finish_reason: null }],
            });
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify({ body: inner })}\n\ndata: [DONE]\n\n`),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderAdapter({ fetch: fakeFetch });
    const target: ProviderDispatchTarget = {
      provider_id: "qoder",
      model_id: "efficient",
      wire_family: "chat",
      endpoint_path: "",
      capabilities: {},
    };
    const ctx: ProviderDispatchContext = {
      credential: {
        provider_id: "qoder",
        credential_kind: "api_key",
        secret: new TextEncoder().encode("pat_secret_123"),
      },
      // Clears the auth prologue but not the body.
      deadline: Date.now() + 120,
      abort_signal: new AbortController().signal,
    };
    const request: CanonicalRequest = {
      model: "efficient",
      messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };

    const events: CanonicalEvent[] = [];
    for await (const event of adapter.dispatch(request, target, ctx)) events.push(event);

    const text = events
      .map((event) => (event.type === "content_delta" && event.content.kind === "text" ? event.content.text : ""))
      .join("");
    expect(text).toBe("HELLO-FROM-BODY");
  });
});

describe("Qoder CN region", () => {
  test("the CN profile resolves the CN gateway, not the intl host", () => {
    expect(CN_PROFILE.chatUrl).toContain("https://gateway.qoder.com.cn");
    expect(CN_PROFILE.chatUrl).not.toContain("qoder.sh");
    expect(QODER_REGION_PROFILES.cn).toBe(CN_PROFILE);
    expect(QODER_REGION_PROFILES.intl).toBe(MODERN_PROFILE);
  });

  test("the CN catalog is the intl tier set with CN frontier keys", () => {
    const cn = Object.keys(QODER_CN_MODEL_CONFIGS).sort();
    expect(cn).toEqual(
      [
        "auto",
        "dfmodel",
        "dmodel",
        "efficient",
        "gfmodel",
        "gmodel",
        "kmodel",
        "kmodel_latest",
        "lite",
        "mmodel",
        "performance",
        "qfmodel",
        "qmodel",
        "qmodel_38max",
        "qmodel_latest",
        "ultimate",
      ].sort(),
    );
    // Intl-only keys must not leak into the CN catalog: the gateway silently
    // downgrades an unknown key instead of rejecting it.
    expect(cn).not.toContain("qmodel_preview");
    expect(cn).not.toContain("gm51model");
    expect(QODER_CN_MODELS.map((model) => model.modelId).sort()).toEqual(cn);
  });

  test("CN dispatch exchanges the PAT and calls the CN host", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("jobToken")) {
        return new Response(
          JSON.stringify({
            id: "u-cn",
            name: "cn-user",
            userType: "personal_standard",
            securityOauthToken: "oauth-cn",
            refreshToken: "refresh-cn",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const adapter = createQoderCnAdapter({ fetch: fakeFetch });
    expect(adapter.provider_id).toBe("qoder-cn");

    const request: CanonicalRequest = {
      model: "gmodel",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      stream: true,
      source_surface: "chat",
    };
    const events: CanonicalEvent[] = [];
    for await (const event of adapter.dispatch(
      request,
      {
        provider_id: "qoder-cn",
        model_id: "gmodel",
        wire_family: "chat",
        endpoint_path: "",
        capabilities: {},
      },
      {
        credential: {
          provider_id: "qoder-cn",
          credential_kind: "api_key",
          secret: new TextEncoder().encode("pt-cn-secret"),
        },
        deadline: Date.now() + 5_000,
        abort_signal: new AbortController().signal,
      },
    )) {
      events.push(event);
    }

    const chatUrl = urls.find((url) => url.includes("agent_chat_generation"));
    expect(chatUrl).toContain("https://gateway.qoder.com.cn");
    const tokenUrl = urls.find((url) => url.includes("jobToken"));
    expect(tokenUrl).toContain("https://gateway.qoder.com.cn");
    expect(events.some((event) => event.type === "terminal")).toBe(true);
  });
});
