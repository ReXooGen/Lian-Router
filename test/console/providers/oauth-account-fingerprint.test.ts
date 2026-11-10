import { describe, expect, test } from "bun:test";

/**
 * The OAuth account fingerprint decides whether a second login is accepted or
 * refused as a duplicate, so it is a user-visible contract, not an internal
 * detail. It is read here through the same helper the store uses.
 *
 * Imported through the store module rather than re-implemented: a copy of the
 * rule in a test proves only that the copy agrees with itself.
 */
const { oauthAccountFingerprintForTest } = await import(
  "../../../src/console/providers/oauth/account-fingerprint"
);

function input(overrides: Partial<{ label: string; accountLabel: string; refresh: string; access: string }>) {
  return {
    label: "zcode account",
    refresh: "",
    access: '{"planToken":"jwt-a"}',
    ...overrides,
  };
}

describe("oauth account fingerprint", () => {
  test("a refresh token is the identity when one exists", () => {
    const first = oauthAccountFingerprintForTest("zcode", input({ refresh: "refresh-a" }));
    expect(first).toBe(oauthAccountFingerprintForTest("zcode", input({ refresh: "refresh-a" })));
    expect(first).not.toBe(oauthAccountFingerprintForTest("zcode", input({ refresh: "refresh-b" })));
  });

  test("an empty refresh token does not collide every account together", () => {
    // The defect this guards: a provider whose flow returns no refresh token
    // stored the same empty envelope for every login, so the identity index
    // rejected the second account as a duplicate of the first.
    const first = oauthAccountFingerprintForTest(
      "zcode",
      input({ refresh: "", accountLabel: "one@example.com" }),
    );
    const second = oauthAccountFingerprintForTest(
      "zcode",
      input({ refresh: "", accountLabel: "two@example.com" }),
    );
    expect(first).not.toBe(second);
  });

  test("the account label is scoped to its provider", () => {
    const zcode = oauthAccountFingerprintForTest(
      "zcode",
      input({ refresh: "", accountLabel: "same@example.com" }),
    );
    const other = oauthAccountFingerprintForTest(
      "other",
      input({ refresh: "", accountLabel: "same@example.com" }),
    );
    expect(zcode).not.toBe(other);
  });

  test("with neither refresh nor label, the access credential is the identity", () => {
    const first = oauthAccountFingerprintForTest("zcode", input({ refresh: "", access: "access-a" }));
    expect(first).toBe(oauthAccountFingerprintForTest("zcode", input({ refresh: "", access: "access-a" })));
    expect(first).not.toBe(oauthAccountFingerprintForTest("zcode", input({ refresh: "", access: "access-b" })));
  });

  test("an empty envelope is the same as no token at all", () => {
    // The defect this guards: a flow with no refresh token stored
    // `{"refreshToken":""}` — a non-empty string around an empty token — so the
    // hash was identical for every login and the second account collided.
    const wrapped = oauthAccountFingerprintForTest(
      "zcode",
      input({ refresh: '{"refreshToken":""}', accountLabel: "a@example.com" }),
    );
    const absent = oauthAccountFingerprintForTest(
      "zcode",
      input({ refresh: "", accountLabel: "a@example.com" }),
    );
    expect(wrapped).toBe(absent);
    const other = oauthAccountFingerprintForTest(
      "zcode",
      input({ refresh: '{"refreshToken":""}', accountLabel: "b@example.com" }),
    );
    expect(other).not.toBe(wrapped);
  });

  test("a real envelope hashes by the token it carries, not the envelope", () => {
    const enveloped = oauthAccountFingerprintForTest(
      "zcode",
      input({ refresh: '{"refreshToken":"token-a"}' }),
    );
    const bare = oauthAccountFingerprintForTest("zcode", input({ refresh: "token-a" }));
    expect(enveloped).toBe(bare);
  });

  test("a whitespace refresh token counts as absent", () => {
    const withSpaces = oauthAccountFingerprintForTest(
      "zcode",
      input({ refresh: "   ", accountLabel: "a@example.com" }),
    );
    const withoutRefresh = oauthAccountFingerprintForTest(
      "zcode",
      input({ refresh: "", accountLabel: "a@example.com" }),
    );
    expect(withSpaces).toBe(withoutRefresh);
  });
});
