import { describe, expect, test } from "bun:test";

import { assertProviderRouting } from "./common";

describe("assertProviderRouting", () => {
  // Every fixture carries a valid `systemPrompt` unless it is the field under
  // test, so a rejection here always names the intended field rather than
  // failing on a missing one.
  const valid = {
    providerId: "openai",
    strategy: "round_robin",
    rotateCount: 1,
    enabled: true,
    maxInflight: null,
    bypassProxy: false,
    systemPrompt: null,
  };

  test("rejects a non-numeric maxInflight", () => {
    expect(() => assertProviderRouting({ ...valid, maxInflight: "8" })).toThrow(
      "Invalid provider routing response",
    );
  });

  test("accepts maxInflight null with a boolean bypassProxy", () => {
    const result = assertProviderRouting(valid);
    expect(result.maxInflight).toBeNull();
    expect(result.bypassProxy).toBe(false);
    expect(result.systemPrompt).toBeNull();
  });

  test("rejects a response without rotateCount", () => {
    const { rotateCount: _rotateCount, ...withoutRotateCount } = valid;
    expect(() => assertProviderRouting(withoutRotateCount)).toThrow(
      "Invalid provider routing response",
    );
  });

  test("accepts a string systemPrompt and rejects a non-string one", () => {
    expect(assertProviderRouting({ ...valid, systemPrompt: "be brief" }).systemPrompt).toBe(
      "be brief",
    );
    // `undefined` is not a valid stored state: the column is nullable, so the
    // API always sends `null` for "none" and the dashboard must not silently
    // treat a missing field as a cleared prompt.
    expect(() => assertProviderRouting({ ...valid, systemPrompt: undefined })).toThrow(
      "Invalid provider routing response",
    );
  });
});
