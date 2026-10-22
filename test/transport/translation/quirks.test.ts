import { describe, expect, test } from "bun:test";
import { applyParamQuirks, findParamQuirk } from "../../../src/transport/translation/quirks";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

function requestWith(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: "claude-opus-4-5",
    stream: false,
    messages: [],
    generation_controls: {
      temperature: 0.7,
      max_tokens: 8192,
    },
    ...overrides,
  } as CanonicalRequest;
}

describe("applyParamQuirks", () => {
  test("strips temperature for anthropic claude models", () => {
    const request = requestWith();
    const next = applyParamQuirks(request, "anthropic");
    expect(next.generation_controls.temperature).toBeUndefined();
    expect(next.generation_controls.max_tokens).toBe(8192);
    // Original request untouched.
    expect(request.generation_controls.temperature).toBe(0.7);
  });

  test("strips sampling controls for buddy Opus 4.7+ routes", () => {
    // Anthropic removed temperature/top_p/top_k in Opus 4.7. The buddy
    // gateways proxy those models, so a non-default value reaches Anthropic
    // and comes back as HTTP 400 "the request parameters were rejected by the
    // model provider" — the probe path always sets temperature: 0.2.
    for (const providerId of ["cb", "cbcn", "workbuddy"]) {
      for (const model of ["claude-opus-4.7-1m", "claude-opus-4.8", "claude-opus-5"]) {
        const next = applyParamQuirks(
          requestWith({ model, generation_controls: { temperature: 0.2, top_p: 0.9, top_k: 5, max_tokens: 1024 } }),
          providerId,
        );
        expect({ providerId, model, controls: next.generation_controls }).toEqual({
          providerId,
          model,
          controls: { max_tokens: 1024 },
        });
      }
    }
  });

  test("keeps sampling controls on older buddy Claude generations", () => {
    const next = applyParamQuirks(
      requestWith({ model: "claude-opus-4.6", generation_controls: { temperature: 0.2, max_tokens: 1024 } }),
      "cb",
    );
    expect(next.generation_controls.temperature).toBe(0.2);
  });

  test("leaves non-matching providers untouched", () => {
    const request = requestWith();
    expect(applyParamQuirks(request, "groq")).toBe(request);
  });

  test("model matcher limits the quirk to claude models", () => {
    const nonClaude = requestWith({ model: "gpt-5" });
    expect(applyParamQuirks(nonClaude, "anthropic")).toBe(nonClaude);
  });

  test("returns the original reference when nothing changed", () => {
    const noControls = requestWith({
      generation_controls: { max_tokens: 100 },
    });
    expect(applyParamQuirks(noControls, "anthropic")).toBe(noControls);
  });

  test("findParamQuirk matches provider and optional model regex", () => {
    expect(findParamQuirk("anthropic", "claude-sonnet-4-6")).toBeDefined();
    expect(findParamQuirk("anthropic", "gpt-5")).toBeUndefined();
    expect(findParamQuirk("zai", "claude-like-model")).toBeUndefined();
  });
});
