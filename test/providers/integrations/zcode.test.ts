import { describe, expect, test } from "bun:test";
import {
  ZCODE_MESSAGES_PATH,
  ZCODE_MODELS,
  ZCODE_SPEC,
  buildZcodeSystem,
  zcodeDeviceId,
  zcodeSessionId,
} from "../../../src/providers/integrations/zcode/spec";
import {
  ZCODE_ANTHROPIC_BETA,
  ZCODE_ANTHROPIC_VERSION,
  ZCODE_APP_VERSION,
  ZCODE_CLI_PREFIX,
  ZCODE_SDK_USER_AGENT,
  ZCODE_STABLE_PREFIX,
} from "../../../src/providers/integrations/zcode/identity";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "glm-5.3",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: {},
    stream: false,
    source_surface: "chat",
    ...overrides,
  };
}

/** Runs the spec's payload hook over a body the Messages encoder would emit. */
function shapedSystem(clientSystem: string | undefined): unknown {
  const payload: Record<string, unknown> = {
    model: "glm-5.3",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
  };
  if (clientSystem !== undefined) payload["system"] = [{ type: "text", text: clientSystem }];
  ZCODE_SPEC.prePayload?.(payload, request(), {
    provider_id: "zcode",
    model_id: "glm-5.3",
    wire_family: "messages",
    endpoint_path: ZCODE_MESSAGES_PATH,
    capabilities: {},
  });
  return payload["system"];
}

describe("zcode identity blocks", () => {
  test("always emits exactly three blocks, in the gateway's order", () => {
    const blocks = buildZcodeSystem("You are a helpful assistant.");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.text).toBe(ZCODE_CLI_PREFIX);
    expect(blocks[1]?.text).toBe(ZCODE_STABLE_PREFIX);
    expect(blocks[2]?.text).toBe("\n\nYou are a helpful assistant.");
  });

  test("block 2 carries the stable text byte for byte, leading newline included", () => {
    // The gateway refuses a normalised copy. Trimming or re-wrapping the
    // captured text is the single easiest way to break the lane, so the
    // leading newline and the exact length are both pinned.
    expect(ZCODE_STABLE_PREFIX.startsWith("\n")).toBe(true);
    expect(buildZcodeSystem("x")[1]?.text).toBe(ZCODE_STABLE_PREFIX);
  });

  test("cache_control rides blocks 2 and 3, never block 1", () => {
    const blocks = buildZcodeSystem("x");
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[2]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("an empty caller prompt keeps a third block rather than dropping it", () => {
    // A two-block body is the 3012 shape: the gateway counts blocks.
    const blocks = buildZcodeSystem("");
    expect(blocks).toHaveLength(3);
    expect(blocks[2]?.text).toBe("");
  });

  test("the caller's own text never lands in block 1 or 2", () => {
    const blocks = buildZcodeSystem(ZCODE_CLI_PREFIX);
    expect(blocks[0]?.text).toBe(ZCODE_CLI_PREFIX);
    expect(blocks[1]?.text).toBe(ZCODE_STABLE_PREFIX);
    expect(blocks[2]?.text).toBe(`\n\n${ZCODE_CLI_PREFIX}`);
  });
});

describe("zcode payload shaping", () => {
  test("replaces whatever the encoder emitted with the three-block shape", () => {
    const system = shapedSystem("client prompt") as { type: string; text: string }[];
    expect(system).toHaveLength(3);
    expect(system[0]?.text).toBe(ZCODE_CLI_PREFIX);
    expect(system[2]?.text).toBe("\n\nclient prompt");
  });

  test("a request with no system at all still gets three blocks", () => {
    const system = shapedSystem(undefined) as { text: string }[];
    expect(system).toHaveLength(3);
    expect(system[2]?.text).toBe("");
  });

  test("multiple client blocks are joined, not truncated to the first", () => {
    const payload: Record<string, unknown> = {
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    ZCODE_SPEC.prePayload?.(payload, request(), {
      provider_id: "zcode",
      model_id: "glm-5.3",
      wire_family: "messages",
      endpoint_path: ZCODE_MESSAGES_PATH,
      capabilities: {},
    });
    const system = payload["system"] as { text: string }[];
    expect(system[2]?.text).toBe("\n\nfirst\n\nsecond");
  });
});

describe("zcode identity headers", () => {
  const context = {
    credential: {
      provider_id: "zcode" as const,
      credential_kind: "api_key" as const,
      secret: new TextEncoder().encode("plan.jwt.value"),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
  };

  test("presents the captured client face and the plan bearer", async () => {
    const headers = await ZCODE_SPEC.buildExtraHeaders?.(context, request(), {
      provider_id: "zcode",
      model_id: "glm-5.3",
      wire_family: "messages",
      endpoint_path: ZCODE_MESSAGES_PATH,
      capabilities: {},
    });
    expect(headers?.["authorization"]).toBe("Bearer plan.jwt.value");
    expect(headers?.["x-zcode-app-version"]).toBe(ZCODE_APP_VERSION);
    expect(headers?.["anthropic-version"]).toBe(ZCODE_ANTHROPIC_VERSION);
    expect(headers?.["anthropic-beta"]).toBe(ZCODE_ANTHROPIC_BETA);
    expect(headers?.["user-agent"]).toBe(ZCODE_SDK_USER_AGENT);
    expect(headers?.["x-zcode-session-type"]).toBe("main");
  });

  test("never emits a signing header", () => {
    // A signed request authenticates but lands on the paid lane and answers
    // 429 1113 even with a full plan balance.
    const headers = zcodeSigningHeaders();
    for (const forbidden of ["x-client-sig", "x-client-pow", "x-app-id", "x-zcode-authorization"]) {
      expect(headers[forbidden]).toBeUndefined();
    }
  });

  test("the LLM face carries no device mid", () => {
    // x-device-mid belongs to the billing face; on the inference face it moves
    // the request onto the control path.
    const headers = zcodeSigningHeaders();
    expect(headers["x-device-mid"]).toBeUndefined();
  });

  test("an empty credential emits no headers at all", async () => {
    const headers = await ZCODE_SPEC.buildExtraHeaders?.(
      {
        ...context,
        credential: {
          provider_id: "zcode",
          credential_kind: "api_key",
          secret: new TextEncoder().encode("  "),
        },
      },
      request(),
      {
        provider_id: "zcode",
        model_id: "glm-5.3",
        wire_family: "messages",
        endpoint_path: ZCODE_MESSAGES_PATH,
        capabilities: {},
      },
    );
    expect(headers).toEqual({});
  });
});

function zcodeSigningHeaders(): Record<string, string> {
  const context = {
    credential: {
      provider_id: "zcode" as const,
      credential_kind: "api_key" as const,
      secret: new TextEncoder().encode("plan.jwt.value"),
    },
    deadline: Date.now() + 30_000,
    abort_signal: new AbortController().signal,
  };
  const result = ZCODE_SPEC.buildExtraHeaders?.(context, request(), {
    provider_id: "zcode",
    model_id: "glm-5.3",
    wire_family: "messages",
    endpoint_path: ZCODE_MESSAGES_PATH,
    capabilities: {},
  });
  if (result !== undefined && typeof (result as Promise<unknown>).then === "function") {
    throw new Error("buildExtraHeaders became async; this helper assumes the sync path");
  }
  return (result ?? {}) as Record<string, string>;
}

describe("zcode derived identities", () => {
  test("the device id is a stable UUID per credential", () => {
    const first = zcodeDeviceId("jwt-a");
    expect(first).toBe(zcodeDeviceId("jwt-a"));
    expect(first).not.toBe(zcodeDeviceId("jwt-b"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("the session id follows the conversation, not the request", () => {
    const a = zcodeSessionId(request({ session_id: "conv-1" }));
    expect(a).toBe(zcodeSessionId(request({ session_id: "conv-1" })));
    expect(a).not.toBe(zcodeSessionId(request({ session_id: "conv-2" })));
    expect(a).toMatch(/^session_[0-9a-f]{32}$/);
  });

  test("a client with no session id still gets a deterministic id per first turn", () => {
    const first = zcodeSessionId(request());
    expect(first).toBe(zcodeSessionId(request()));
    expect(first).not.toBe(
      zcodeSessionId(
        request({ messages: [{ role: "user", content: [{ kind: "text", text: "other" }] }] }),
      ),
    );
  });
});

describe("zcode adapter contract", () => {
  test("serves only the Messages wire", () => {
    expect(ZCODE_SPEC.supported_wire_families).toEqual(["messages"]);
    expect(ZCODE_SPEC.endpoint_paths_by_wire_family).toEqual({
      messages: ZCODE_MESSAGES_PATH,
    });
  });

  test("does not ask for an OpenAI stream_options frame on the Anthropic wire", () => {
    // The shared factory injects `stream_options` unless this is "none"; the
    // plan lane inspects the body and rejects the extra field.
    expect(ZCODE_SPEC.streaming_usage_mode).toBe("none");
  });

  test("withholds the default Authorization so exactly one bearer is sent", () => {
    expect(ZCODE_SPEC.credential_forwarding).toBe("never");
  });

  test("the catalog is the two models the plan grants name", () => {
    expect(ZCODE_MODELS.map((model) => model.modelId).sort()).toEqual([
      "glm-5.3",
      "glm-5.3-flash",
    ]);
    for (const model of ZCODE_MODELS) {
      expect(model.wireFamily).toBe("messages");
      expect(model.endpointPath).toBe(ZCODE_MESSAGES_PATH);
    }
  });

  /**
   * The base catalog keys these ids under `zai`, so a `zcode` lookup returns
   * nothing and every row would fall to the shared defaults (200k / 64k). The
   * plan lane serves 1M context, which is what the desktop client reports for
   * the same account; pinning it keeps a catalog refactor from silently
   * shrinking the window again.
   */
  test("declares the plan lane's 1M window instead of the 200k default", () => {
    for (const model of ZCODE_MODELS) {
      expect(model.contextLimit).toBe(1_000_000);
      expect(model.outputLimit).toBe(131_072);
    }
  });

  /**
   * Vision is per row. Sent the same 512×512 image, `glm-5.3-flash` named the
   * shapes and colours while `glm-5.3` reported a blank page, so only the flash
   * row publishes an image input.
   */
  test("declares image input on the flash row only", () => {
    const flash = ZCODE_MODELS.find((model) => model.modelId === "glm-5.3-flash");
    const full = ZCODE_MODELS.find((model) => model.modelId === "glm-5.3");
    expect(flash?.modalities.input).toContain("image");
    expect(full?.modalities.input).not.toContain("image");
  });
});
