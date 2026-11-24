// Regression coverage for the compatibility-profile validator: it must enforce
// the canonical protected-header policy (`src/security/outbound-headers.ts`)
// plus the adapter-owned names, and accept ordinary custom headers. The
// validator previously carried its own drifted denylist, so these assertions
// pin the unified policy rather than the copy that used to sit beside it.
import { describe, expect, test } from "bun:test";
import { normalizeSystemPrompt, validateCompatibilityProfile, MAX_PROVIDER_SYSTEM_PROMPT } from "../../../src/console/providers/catalog/contracts";
import type { CompatibilityProfile } from "../../../src/providers/provider-metadata";
import { GatewayError } from "../../../src/transport/gateway-error";

function reject(headers: Readonly<Record<string, string>>): GatewayError {
  try {
    validateCompatibilityProfile({ extra_headers: headers } satisfies CompatibilityProfile);
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error(`expected ${JSON.stringify(headers)} to be rejected`);
}

describe("validateCompatibilityProfile — extra_headers protection", () => {
  test("rejects every name in the canonical protected-header set", () => {
    for (const name of [
      "host",
      "content-type",
      "authorization",
      "x-api-key",
      "cookie",
      "connection",
      "proxy-connection",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "via",
      "forwarded",
      "x-real-ip",
      "x-lianrouter-surface",
      "x-lianrouter-tenant",
    ]) {
      expect(reject({ [name]: "value" }).message).toBe(
        `header ${name} is not allowed as custom header`,
      );
    }
  });

  test("rejects every x-forwarded-* name by prefix", () => {
    for (const name of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-port",
      "x-forwarded-prefix",
      "x-forwarded-anything",
    ]) {
      expect(reject({ [name]: "value" }).message).toBe(
        `header ${name} is not allowed as custom header`,
      );
    }
  });

  test("rejects adapter-owned names", () => {
    for (const name of [
      "anthropic-version",
      "anthropic-beta",
      "x-stainless-os",
      "x-account-id",
      "x-app",
      "originator",
      "openai-beta",
    ]) {
      expect(reject({ [name]: "value" }).message).toBe(
        `header ${name} is not allowed as custom header`,
      );
    }
  });

  test("matches protected names case-insensitively", () => {
    const error = reject({ Authorization: "value" });
    expect(error.code).toBe("invalid_request");
    expect(error.status).toBe(400);
    expect(error.message).toBe("header Authorization is not allowed as custom header");
  });

  test("accepts ordinary custom headers", () => {
    expect(() =>
      validateCompatibilityProfile({
        extra_headers: { "x-custom-header": "value", "x-routing-hint": "1" },
      } satisfies CompatibilityProfile),
    ).not.toThrow();
  });
});

describe("validateCompatibilityProfile — cli_identity", () => {
  test("accepts the boolean flag the dashboard always sends", () => {
    // Every custom-provider create/update carries `cli_identity`; rejecting it
    // here surfaced as "unknown compatibility_profile field cli_identity has no
    // runtime reader" even though `resolveCustomCliHeaders` reads it.
    expect(() =>
      validateCompatibilityProfile({ cli_identity: true } satisfies CompatibilityProfile),
    ).not.toThrow();
    expect(() =>
      validateCompatibilityProfile({ cli_identity: false } satisfies CompatibilityProfile),
    ).not.toThrow();
  });

  test("rejects a non-boolean value with a typed 400", () => {
    const error = (() => {
      try {
        validateCompatibilityProfile({
          cli_identity: "yes",
        } as unknown as CompatibilityProfile);
      } catch (caught) {
        return caught as GatewayError;
      }
      throw new Error("expected cli_identity string to be rejected");
    })();
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.code).toBe("invalid_request");
    expect(error.status).toBe(400);
    expect(error.message).toBe("cli_identity must be boolean");
  });
});

describe("provider system prompt normalization", () => {
  test("trims a real prompt and keeps it", () => {
    expect(normalizeSystemPrompt("  be brief  ")).toBe("be brief");
  });

  test("maps empty input to null so the column clears instead of storing blank", () => {
    // A blank string would otherwise become an empty system message that every
    // wire encoder emits on every request.
    expect(normalizeSystemPrompt("")).toBeNull();
    expect(normalizeSystemPrompt("   \n\t ")).toBeNull();
    expect(normalizeSystemPrompt(undefined)).toBeNull();
  });

  test("rejects a prompt past the ceiling rather than truncating it", () => {
    // Truncating would silently send a half-sentence instruction; the operator
    // has to see that it did not fit.
    const tooLong = "x".repeat(MAX_PROVIDER_SYSTEM_PROMPT + 1);
    expect(() => normalizeSystemPrompt(tooLong)).toThrow("at most");
  });

  test("accepts a prompt exactly at the ceiling", () => {
    const atLimit = "x".repeat(MAX_PROVIDER_SYSTEM_PROMPT);
    expect(normalizeSystemPrompt(atLimit)).toHaveLength(MAX_PROVIDER_SYSTEM_PROMPT);
  });
});

// Regression: the edit dialog round-trips `iconUrl` inside the profile; the
// whitelist must admit the presentation fields it already shape-validates or
// every save carrying an icon/credential link 400s.
test("accepts presentation-only fields it shape-validates", () => {
  validateCompatibilityProfile({
    iconUrl: "https://cdn.example.com/icon.png",
    credentialUrl: "https://example.com/keys",
  } as never);
  validateCompatibilityProfile({
    iconUrl: `data:image/png;base64,${"A".repeat(64)}`,
  } as never);
});

/**
 * The runtime-reader whitelist is the second gate a profile passes: a field the
 * shape validator accepts must also be admitted here, or every console save
 * carrying it answers 400 "has no runtime reader". `userAgent` cleared the first
 * gate and failed the second, which is why the identity select saved nothing and
 * reported an error the operator could not act on.
 */
describe("validateCompatibilityProfile — runtime-reader whitelist", () => {
  test("admits an identity preset", () => {
    expect(() =>
      validateCompatibilityProfile({ userAgent: "omp" } satisfies CompatibilityProfile),
    ).not.toThrow();
  });

  test("admits a literal identity", () => {
    expect(() =>
      validateCompatibilityProfile({ userAgent: "my-agent/1.2.3" } satisfies CompatibilityProfile),
    ).not.toThrow();
  });

  test("still rejects a field with no reader at all", () => {
    expect(() =>
      validateCompatibilityProfile({ notARealField: "x" } as unknown as CompatibilityProfile),
    ).toThrow(/has no runtime reader/);
  });
});
