import { describe, expect, test } from "bun:test";
import { runAttemptLoop } from "../../../src/transport/dispatch/attempt-loop";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import { GatewayError } from "../../../src/transport/gateway-error";
import { createAuthorizationSnapshot } from "../../../src/security/api-key-auth";
import type { RouteCandidate, RoutePlan } from "../../../src/transport/routing/route-model";
import type { NetworkPoolSelector } from "../../../src/network/pool/selector";
import type { UsageRecord } from "../../../src/transport/canonical-model";

/**
 * A public provider candidate can carry many pools while the plan holds exactly
 * one candidate: a 429 keyed on the source address is the one failure another
 * attempt on the *same* candidate can survive, because re-acquiring a slot after
 * the cooldown flag picks a different exit. Without it the request died on the
 * first spent address while a hundred healthy pools sat unused.
 *
 * These run `runAttemptLoop` directly. The defect is the loop's decision, and a
 * handler-level test would drag in credential resolution and adapter dispatch
 * without adding an assertion.
 */

const PROVIDER = "ocfree-ft";
const MODEL = "mimo-v2.6-flash-free";

/** A candidate whose exits are real pool ids: the failover bound reads this. */
function pooledCandidate(poolIds: readonly string[]): RouteCandidate {
  const limits: Record<string, number> = {};
  const weights: Record<string, number> = {};
  for (const id of poolIds) {
    limits[id] = 4;
    weights[id] = 100;
  }
  return {
    provider_id: PROVIDER,
    model_id: MODEL,
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    tenant_id: "tenant-pooled",
    requires_account: false,
    network_pool_ids: poolIds,
    network_pool_required: true,
    network_pool_limits: limits,
    network_pool_weights: weights,
  };
}

function planOf(candidates: readonly RouteCandidate[]): RoutePlan {
  return {
    revision: 1,
    candidates,
    requested_model: MODEL,
    resolved_model: MODEL,
    provider_id: PROVIDER,
  };
}

/**
 * Selector that honors its own cooldown view, the way the production one does.
 *
 * It grants the first eligible pool it has not been told to cool, so a failover
 * that re-enters before flagging the spent exit lands back on that same exit —
 * the exact regression this shape catches.
 */
function cooldownAwareSelector() {
  const cooling = new Set<string>();
  const acquired: string[] = [];
  const value = {
    tryAcquireAvailablePool: async (eligiblePoolIds: readonly string[]) => {
      const poolId = eligiblePoolIds.find((id) => !cooling.has(id));
      if (poolId === undefined) return undefined;
      acquired.push(poolId);
      return { poolId, release: () => {} };
    },
    getInflight: () => 0,
    flagProviderCooldown: async (poolId: string) => {
      cooling.add(poolId);
    },
  } as unknown as NetworkPoolSelector;
  return { value, acquired, cooling };
}

function stubDb(): never {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  } as never;
}

/** A 429 whose evidence names the egress address. */
function networkRateLimit(): GatewayError {
  return new GatewayError(
    "quota_exceeded",
    429,
    "Free usage limit reached. Subscribe to OpenCode Go to keep going.",
    { providerStatus: 429, rateLimitScope: "network", retryAfterMs: 60_000 },
    "upstream",
  );
}

/** A 429 that belongs to the account, so another exit cannot change it. */
function accountRateLimit(): GatewayError {
  return new GatewayError(
    "quota_exceeded",
    429,
    "Rate limit reached for requests",
    { providerStatus: 429, rateLimitScope: "account" },
    "upstream",
  );
}

interface Harness {
  readonly dialedPools: Array<string | undefined>;
  readonly commits: UsageRecord[];
  run(input: {
    candidate: RouteCandidate;
    attempt: (
      attemptNumber: number,
      /** Trips the request's own deadline, exactly as the state timer does. */
      control: { readonly expireDeadline: () => void },
    ) => Promise<string>;
    /** Request budget in ms; defaults to a generous 60s. */
    deadlineMs?: number;
  }): Promise<string>;
}

function harness(): Harness {
  const dialedPools: Array<string | undefined> = [];
  const commits: UsageRecord[] = [];
  return {
    dialedPools,
    commits,
    async run({ candidate, attempt, deadlineMs = 60_000 }) {
      const pools = cooldownAwareSelector();
      const state = new ProxyRequestStateStore().initialize(
        new Request("https://gateway.test/v1/chat/completions", { method: "POST" }),
        Date.now(),
        deadlineMs,
      );
      return await runAttemptLoop<string, unknown>({
        state,
        deps: { db: stubDb(), poolSelector: pools.value },
        leaseSource: {
          admissionService: {
            admit: async () => ({
              reservationId: "lease-1",
              apiKeyId: "key-1",
              released: false,
              commitUsage: async (usage: UsageRecord) => {
                commits.push(usage);
              },
              release: async () => {},
            }),
          } as never,
          routingEngine: {
            reserve: async (plan: RoutePlan) => ({
              candidate: plan.candidates[0]!,
              lease_id: "reservation-1",
              expires_at: Date.now() + 60_000,
              acquired_at: Date.now(),
            }),
            release: async () => {},
          } as never,
          plan: planOf([candidate]),
          estimatedInputTokens: 10,
          estimatedOutputTokens: 10,
          authorizationSnapshot: createAuthorizationSnapshot({
            api_key_id: "key-1",
            tenant_id: "tenant-requesting",
          }),
          networkPoolId: undefined,
        },
        candidates: [candidate],
        tenantId: "tenant-requesting",
        strictPoolSelection: true,
        prepare: async () => ({
          credential: { provider_id: PROVIDER as never, credential_kind: "none" as const },
          adapter: {},
        }),
        attempt: async (context) => {
          dialedPools.push(context.leases.networkPoolId);
          return await attempt(context.attemptIndex, {
            expireDeadline: () =>
              state.abortController.abort(
                new DOMException("request deadline exceeded", "TimeoutError"),
              ),
          });
        },
        exhaustedError: new GatewayError("admission_unavailable", 503, "no eligible route"),
      });
    },
  };
}

describe("same-candidate egress failover", () => {
  test("a network-scoped 429 with more than one exit re-enters on a different exit", async () => {
    const testHarness = harness();
    let attempts = 0;

    const result = await testHarness.run({
      candidate: pooledCandidate(["pool-a", "pool-b", "pool-c"]),
      attempt: async () => {
        attempts += 1;
        if (attempts < 3) throw networkRateLimit();
        return "served";
      },
    });

    expect(result).toBe("served");
    expect(attempts).toBe(3);
    // Each spent exit is cooled before re-entry, so the selector's own local
    // view cannot hand back an address that already refused the request: the
    // three attempts land on three distinct exits.
    expect(testHarness.dialedPools).toEqual(["pool-a", "pool-b", "pool-c"]);
    // Every spent exit was refunded: the provider rejected those requests.
    expect(testHarness.commits).toHaveLength(0);
  });

  test("a network-scoped 429 with a single exit does not re-enter", async () => {
    const testHarness = harness();
    let attempts = 0;

    const surfaced = await testHarness
      .run({
        candidate: pooledCandidate(["pool-a"]),
        attempt: async () => {
          attempts += 1;
          throw networkRateLimit();
        },
      })
      .catch((error: unknown) => error);

    expect((surfaced as GatewayError).code).toBe("quota_exceeded");
    expect(attempts).toBe(1);
    expect(testHarness.dialedPools).toEqual(["pool-a"]);
  });

  test("the failover is bounded per candidate", async () => {
    const testHarness = harness();
    let attempts = 0;

    const surfaced = await testHarness
      .run({
        // More exits than the bound, so the bound is what ends the request
        // rather than the candidate running out of pools.
        candidate: pooledCandidate([
          "pool-a", "pool-b", "pool-c", "pool-d", "pool-e", "pool-f",
          "pool-g", "pool-h", "pool-i", "pool-j", "pool-k", "pool-l",
        ]),
        attempt: async () => {
          attempts += 1;
          throw networkRateLimit();
        },
      })
      .catch((error: unknown) => error);

    expect((surfaced as GatewayError).code).toBe("quota_exceeded");
    // The first attempt plus MAX_EGRESS_FAILOVERS extra exits. The value is
    // policy, derived in `attempt-loop.ts` from the spent-fraction arithmetic:
    // with 100 exits a bound of 8 puts a spent-address deployment near 4
    // failures in 100,000 instead of near 2 in 100.
    expect(attempts).toBe(9);
    expect(testHarness.dialedPools).toHaveLength(9);
    // Every attempt sampled a different exit: cooling removes it from the
    // eligible set, so the rotation never revisits a spent address.
    expect(testHarness.dialedPools).toEqual([
      "pool-a", "pool-b", "pool-c", "pool-d", "pool-e", "pool-f",
      "pool-g", "pool-h", "pool-i",
    ]);
  });

  test("the request deadline ends an all-spent candidate before the failover bound does", async () => {
    const testHarness = harness();
    let attempts = 0;
    // Twelve exits, so the bound alone would allow nine entries. The budget is
    // tripped through the request's own abort controller — the same signal the
    // deadline timer fires — so the test proves the loop honours the budget
    // without depending on wall-clock timing.
    const exits = [
      "pool-a", "pool-b", "pool-c", "pool-d", "pool-e", "pool-f",
      "pool-g", "pool-h", "pool-i", "pool-j", "pool-k", "pool-l",
    ];

    const surfaced = await testHarness
      .run({
        candidate: pooledCandidate(exits),
        attempt: async (_attemptNumber, control) => {
          attempts += 1;
          // Every exit is spent. The second attempt is where the budget runs
          // out, so the loop must stop there rather than walking to the bound.
          if (attempts === 2) control.expireDeadline();
          throw networkRateLimit();
        },
      })
      .catch((error: unknown) => error);

    // The budget ended this request: two entries, not the nine the bound allows.
    expect(surfaced).toBeInstanceOf(GatewayError);
    expect(attempts).toBe(2);
    expect(testHarness.dialedPools).toHaveLength(2);
    // The hard ceiling still holds: one entry plus MAX_EGRESS_FAILOVERS.
    expect(testHarness.dialedPools.length).toBeLessThanOrEqual(10);
  });

  test("an account-scoped 429 never fails over", async () => {
    const testHarness = harness();
    let attempts = 0;

    const surfaced = await testHarness
      .run({
        candidate: pooledCandidate(["pool-a", "pool-b"]),
        attempt: async () => {
          attempts += 1;
          throw accountRateLimit();
        },
      })
      .catch((error: unknown) => error);

    expect((surfaced as GatewayError).code).toBe("quota_exceeded");
    // Another exit fails identically on a credential limit, so a retry would
    // only burn attempts.
    expect(attempts).toBe(1);
    expect(testHarness.dialedPools).toEqual(["pool-a"]);
  });
});

describe("refund on rejection", () => {
  test("a request the provider rejected before generation is not committed as usage", async () => {
    const testHarness = harness();

    const surfaced = await testHarness
      .run({
        candidate: pooledCandidate(["pool-a"]),
        attempt: async () => {
          throw accountRateLimit();
        },
      })
      .catch((error: unknown) => error);

    expect((surfaced as GatewayError).details.providerStatus).toBe(429);
    // The reservation is refunded by the lease release in `finally`; committing
    // the estimate here would turn a refundable reservation into a debit.
    expect(testHarness.commits).toHaveLength(0);
  });

  test("a failure after the provider accepted the request still commits its estimate", async () => {
    const testHarness = harness();

    const surfaced = await testHarness
      .run({
        candidate: pooledCandidate(["pool-a"]),
        attempt: async () => {
          // No `providerStatus`: the request reached the model and the stream
          // broke afterwards, so prompt tokens were consumed.
          throw new GatewayError("transport_unavailable", 502, "upstream produced no terminal event", {}, "upstream");
        },
      })
      .catch((error: unknown) => error);

    expect((surfaced as GatewayError).code).toBe("transport_unavailable");
    expect(testHarness.commits).toHaveLength(1);
    expect(testHarness.commits[0]?.input_tokens).toBe(10);
  });
});
