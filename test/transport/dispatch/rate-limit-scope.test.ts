import { describe, expect, test } from "bun:test";
import {
  classifyRateLimitScope,
  classifyUpstreamFailure,
  mapUpstreamHttpError,
} from "../../../src/transport/failure-policy";
import { shouldCooldownPool } from "../../../src/transport/dispatch/retry-policy";
import type { GatewayError } from "../../../src/transport/gateway-error";

/**
 * A 429 says something was limited, not *what* was. Cooling the egress pool on
 * a limit that belongs to the credential or to a model tier sidelines healthy
 * egress for every other request to that provider while changing nothing about
 * the limit — the operator sees a gateway that looks broken while it is
 * faithfully relaying an upstream decision.
 */
async function capture429(
  body: unknown,
  providerId: string,
  headers: Record<string, string> = {},
  status = 429,
  evidence: { readonly presentsCredential?: boolean; readonly poolLeased?: boolean } = {},
): Promise<GatewayError> {
  try {
    await mapUpstreamHttpError(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers,
      }),
      providerId,
      evidence,
    );
    throw new Error("expected the mapper to throw");
  } catch (error) {
    return error as GatewayError;
  }
}

describe("429 rate-limit scope", () => {
  test("a credential-scoped 429 does not cool the pool", async () => {
    const error = await capture429(
      { error: { code: "rate_limit_exceeded", message: "Rate limit reached for requests" } },
      "openai",
    );

    expect(error.details["rateLimitScope"]).toBe("account");
    expect(shouldCooldownPool(error)).toBe(false);
  });

  test("a provider-capacity 429 still cools the pool", async () => {
    const error = await capture429(
      { error: { code: "capacity_exhausted", message: "model is overloaded" } },
      "openai",
    );

    expect(error.details["rateLimitScope"]).toBe("provider");
    expect(shouldCooldownPool(error)).toBe(true);
  });

  test("an egress-keyed 429 cools the pool", async () => {
    // OpenCode Free presents no caller identity at all — no account and the
    // literal `Bearer public` — so the only discriminator left upstream is the
    // source address. The pool *is* the thing that was limited here.
    const error = await capture429(
      {
        type: "error",
        error: {
          type: "FreeUsageLimitError",
          message: "Free usage limit reached. Subscribe to OpenCode Go to keep going.",
        },
      },
      "opencodeft",
    );

    expect(error.details["rateLimitScope"]).toBe("network");
    expect(shouldCooldownPool(error)).toBe(true);
  });

  test("the free-tier gate surfaces an actionable message instead of sales copy", async () => {
    const error = await capture429(
      {
        type: "error",
        error: {
          type: "FreeUsageLimitError",
          message: "Free usage limit reached. Subscribe to OpenCode Go to keep going: https://opencode.ai/go",
        },
      },
      "opencodeft",
    );

    // Names the gate, says the allowance is per egress address, and states the
    // remedy the gateway actually applies (pool cooldown), then the paid tier.
    expect(error.message).toContain("FreeUsageLimitError");
    expect(error.message).toContain("keyed on the egress address");
    expect(error.message).toContain("cools this (pool, provider) pair");
    expect(error.message).toContain("opencodego");
    // Every exit on this provider shares one ASN, so more pools buy more
    // refusals. Telling the operator otherwise sends them to spend money on
    // addresses that are already spent.
    expect(error.message).not.toContain("adding pools is the only remedy");
    expect(error.message).toContain("only a different egress network changes that");
    // The upstream body is still preserved verbatim for diagnostics.
    expect(error.details["raw"]).toContain("Free usage limit reached");
    // The adapter that owns the handle reads this flag to retire it. It is set
    // only for the structured allowance error, never for a status alone.
    expect(error.details["freeTierAllowanceExhausted"]).toBe(true);
  });

  test("the free-tier gate states the cooldown the gateway is about to apply", async () => {
    // The real header from the spent free allowance: ~18h07m. A message that
    // omits it invites retries inside a window that cannot succeed.
    const error = await capture429(
      { error: { type: "FreeUsageLimitError", message: "free usage limit reached" } },
      "opencodeft",
      { "retry-after": "65256" },
    );

    expect(error.details["retryAfterMs"]).toBe(65_256_000);
    expect(error.message).toContain("for 18h 8m");
  });

  test("the free-tier gate omits a duration it was not given", async () => {
    const error = await capture429(
      { error: { type: "FreeUsageLimitError", message: "free usage limit reached" } },
      "opencodeft",
    );

    // No header means no measured TTL. Printing a made-up window would be the
    // same class of lie as the removed remedy sentence.
    expect(error.message).not.toMatch(/\bfor \d/);
    expect(error.message).toContain("cools this (pool, provider) pair so the next request");
  });

  test("the free-tier gate claims no cooldown when the request dialed direct", async () => {
    // A direct dial holds no pool slot, so `flagPoolCooldown` is skipped for it.
    // The message must not describe an action that was not taken.
    const error = await capture429(
      { error: { type: "FreeUsageLimitError", message: "free usage limit reached" } },
      "opencodeft",
      {},
      429,
      { presentsCredential: false, poolLeased: false },
    );

    expect(error.details["rateLimitScope"]).toBe("network");
    expect(error.message).not.toContain("cools this (pool, provider) pair");
    expect(error.message).toContain("This request dialed direct, so there is no proxy exit to cool");
    // The rest of the message is unchanged: the gate, the per-address keying,
    // and the paid-tier remedy are still the operator's answer.
    expect(error.message).toContain("keyed on the egress address");
    expect(error.message).toContain("only a different egress network changes that");
    expect(error.message).toContain("opencodego");
  });

  test("the free-tier gate states the cooldown when a pool was actually leased", async () => {
    const error = await capture429(
      { error: { type: "FreeUsageLimitError", message: "free usage limit reached" } },
      "opencodeft",
      { "retry-after": "65256" },
      429,
      { presentsCredential: false, poolLeased: true },
    );

    expect(error.message).toContain("cools this (pool, provider) pair for 18h 8m");
    expect(error.message).not.toContain("dialed direct");
  });

  test("a caller that cannot say whether a pool was leased keeps the cooldown sentence", async () => {
    // Token exchanges and wire-level frames have no dispatch context. Dropping
    // the remedy for them would hide it in the pooled case that is the common
    // one, so an unknown answer keeps the existing text.
    const error = await capture429(
      { error: { type: "FreeUsageLimitError", message: "free usage limit reached" } },
      "opencodeft",
    );

    expect(error.message).toContain("cools this (pool, provider) pair");
    expect(error.message).not.toContain("dialed direct");
  });

  test("a bare 429 or a 5xx does not claim the allowance was exhausted", async () => {
    for (const [status, body] of [
      [429, { error: { message: "slow down" } }],
      [500, { error: { message: "upstream exploded" } }],
    ] as const) {
      const error = await capture429(body, "opencodeft", {}, status);
      expect(error.details["freeTierAllowanceExhausted"]).toBeUndefined();
    }
  });

  test("a free-tier body from a different provider keeps its own message", async () => {
    const error = await capture429(
      { error: { type: "FreeUsageLimitError", message: "free usage limit reached" } },
      "opencodezen",
    );

    expect(error.message).toBe("free usage limit reached");
    expect(error.details["rateLimitScope"]).toBe("account");
  });

  test("a bare 429 is treated as the caller's window, not a pool fault", async () => {
    const error = await capture429("slow down", "openai");
    expect(error.details["rateLimitScope"]).toBe("account");
    expect(shouldCooldownPool(error)).toBe(false);
  });

  test("retry-after is not read as evidence about scope", async () => {
    // A retry window and a scope are independent facts: a credential limit
    // states a reset and must still not cool the pool.
    const error = await capture429(
      { error: { type: "rate_limit_error", message: "slow down" } },
      "anthropic",
      { "retry-after": "30" },
    );

    expect(error.details["retryAfterMs"]).toBe(30_000);
    expect(shouldCooldownPool(error)).toBe(false);
  });
});

describe("429 failover decision", () => {
  test("a credential-scoped 429 parks the account so routing tries another", async () => {
    const error = await capture429(
      { error: { code: "insufficient_quota", message: "You exceeded your current quota" } },
      "openai",
    );
    const policy = classifyUpstreamFailure(error);

    expect(policy.scope).toBe("account");
    expect(policy.mutatesAccount).toBe(true);
    expect(policy.retryable).toBe(true);
  });

  test("a provider-scoped 429 leaves the account in rotation", async () => {
    const error = await capture429(
      { error: { type: "overloaded_error", message: "overloaded" } },
      "anthropic",
    );
    const policy = classifyUpstreamFailure(error);

    expect(policy.scope).toBe("provider");
    expect(policy.mutatesAccount).toBe(false);
    expect(policy.retryable).toBe(true);
  });

  test("scope classification reads structured identifiers, never prose", () => {
    // A message that merely contains a word like "capacity" is not evidence.
    expect(
      classifyRateLimitScope({
        status: 429,
        body: { error: { message: "your capacity for patience is exceeded" } },
      }),
    ).toBe("account");
    expect(classifyRateLimitScope({ status: 529 })).toBe("provider");
    expect(
      classifyRateLimitScope({ status: 429, body: { error: { type: "model_at_capacity" } } }),
    ).toBe("provider");
  });
});
