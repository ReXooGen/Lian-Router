import { describe, expect, test } from "bun:test";
import { runAttemptLoop } from "../../../src/transport/dispatch/attempt-loop";
import { ProxyRequestStateStore } from "../../../src/transport/request/state";
import { GatewayError } from "../../../src/transport/gateway-error";
import { createAuthorizationSnapshot } from "../../../src/security/api-key-auth";
import type { RouteCandidate, RoutePlan } from "../../../src/transport/routing/route-model";
import type { NetworkPoolSelector } from "../../../src/network/pool/selector";

/**
 * The credential-less global snapshot emits a tenant's pooled candidate beside
 * an unpooled fallback for the same provider/model. `acquirePoolSlot` refuses
 * the fallback (`proxy_pool_unhealthy` / `candidate_pool_missing`) so it can
 * never dial direct — correct — but that refusal is a statement about *that
 * candidate*, not about the request.
 *
 * These run `runAttemptLoop` directly: the defect is the loop's decision to end
 * the request on that refusal and to report it in place of the failure that
 * actually decided the attempt. A handler-level test would drag in credential
 * resolution and adapter dispatch, neither of which can fail these assertions.
 */

const PROVIDER = "opencodeft";
const MODEL = "mimo-v2.6-flash-free";

/** The tenant's pooled candidate: real ids, pool required. */
function pooledCandidate(tenantId = "tenant-pooled"): RouteCandidate {
  return {
    provider_id: PROVIDER,
    model_id: MODEL,
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    tenant_id: tenantId,
    requires_account: false,
    network_pool_ids: ["pool-a"],
    network_pool_required: true,
    network_pool_limits: { "pool-a": 4 },
    network_pool_weights: { "pool-a": 100 },
  };
}

/** The global fallback: no tenant, no pool, no credential. */
function unpooledCandidate(): RouteCandidate {
  return {
    provider_id: PROVIDER,
    model_id: MODEL,
    wire_family: "chat",
    endpoint: "/v1/chat/completions",
    capability_profile: {},
    tenant_id: null,
    requires_account: false,
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

/** Selector that always grants the first eligible pool and records each dial. */
function healthySelector() {
  const requested: string[][] = [];
  const value = {
    tryAcquireAvailablePool: async (eligiblePoolIds: readonly string[]) => {
      requested.push([...eligiblePoolIds]);
      const first = eligiblePoolIds[0];
      return first === undefined ? undefined : { poolId: first, release: () => {} };
    },
    getInflight: () => 0,
    flagProviderCooldown: () => {},
  } as unknown as NetworkPoolSelector;
  return { value, requested };
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

interface Harness {
  readonly dialed: Array<string | null>;
  run(input: {
    candidates: readonly RouteCandidate[];
    /** Also what `acquirePoolSlot` reads for the pooled-sibling guard. */
    planCandidates?: readonly RouteCandidate[];
    selector?: NetworkPoolSelector;
    attempt: (candidate: RouteCandidate, attemptNumber: number) => Promise<string>;
  }): Promise<string>;
}

function harness(): Harness {
  const dialed: Array<string | null> = [];
  return {
    dialed,
    async run({ candidates, planCandidates, selector, attempt }) {
      const stateStore = new ProxyRequestStateStore();
      const state = stateStore.initialize(
        new Request("https://gateway.test/v1/chat/completions", { method: "POST" }),
        Date.now(),
        60_000,
      );
      return await runAttemptLoop<string, unknown>({
        state,
        deps: {
          db: stubDb(),
          ...(selector ? { poolSelector: selector } : {}),
        },
        leaseSource: {
          admissionService: {
            admit: async () => ({
              reservationId: "lease-1",
              apiKeyId: "key-1",
              released: false,
              commitUsage: async () => {},
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
          plan: planOf(planCandidates ?? candidates),
          estimatedInputTokens: 10,
          estimatedOutputTokens: 10,
          authorizationSnapshot: createAuthorizationSnapshot({
            api_key_id: "key-1",
            tenant_id: "tenant-requesting",
          }),
          networkPoolId: undefined,
        },
        candidates,
        tenantId: "tenant-requesting",
        strictPoolSelection: true,
        prepare: async () => ({
          credential: { provider_id: PROVIDER, credential_kind: "none" as const },
          adapter: {},
        }),
        attempt: async (context) => {
          dialed.push(context.candidate.tenant_id ?? null);
          return await attempt(context.candidate, context.attemptIndex);
        },
        exhaustedError: new GatewayError("admission_unavailable", 503, "no eligible route"),
      });
    },
  };
}

describe("unpooled fallback beside a pooled candidate", () => {
  test("the fallback is refused, but the pooled sibling still serves the request", async () => {
    // The unpooled candidate is attempted first. Its refusal must not end the
    // request: the pooled candidate that the refusal was *for* is right beside
    // it in the plan, and it can serve this request.
    const pools = healthySelector();
    const pooled = pooledCandidate();
    const unpooled = unpooledCandidate();
    const testHarness = harness();

    const result = await testHarness.run({
      candidates: [unpooled, pooled],
      selector: pools.value,
      attempt: async (candidate) => `served-by-${candidate.tenant_id ?? "global"}`,
    });

    expect(result).toBe("served-by-tenant-pooled");
    // Exactly one dial, and it carried a pool: the fallback never egressed.
    expect(testHarness.dialed).toEqual(["tenant-pooled"]);
    expect(pools.requested).toEqual([["pool-a"]]);
  });

  test("when the pooled candidate also fails, the surfaced error is the pooled candidate's", async () => {
    // The production shape: the pool set is saturated, the pooled candidate
    // answers `proxy_pool_capacity_exceeded`, and the loop falls through to the
    // unpooled fallback. Reporting the fallback's refusal would tell the
    // operator a candidate that was never meant to dial was misconfigured,
    // while the actual fault (an exhausted pool set) disappears.
    const pools = healthySelector();
    const pooled = pooledCandidate();
    const unpooled = unpooledCandidate();
    const testHarness = harness();

    const surfaced = await testHarness
      .run({
        candidates: [pooled, unpooled],
        selector: pools.value,
        attempt: async (candidate) => {
          if (candidate.network_pool_ids?.length) {
            throw new GatewayError(
              "proxy_pool_capacity_exceeded",
              429,
              "all pools at capacity",
              { pools: [] },
            );
          }
          return "served-by-global";
        },
      })
      .catch((error: unknown) => error);

    expect(surfaced).toBeInstanceOf(GatewayError);
    expect((surfaced as GatewayError).code).toBe("proxy_pool_capacity_exceeded");
    expect((surfaced as GatewayError).details.reason).toBeUndefined();
    // Only the pooled candidate dialed; the fallback was refused before egress.
    expect(testHarness.dialed).toEqual(["tenant-pooled"]);
  });

  test("the same masking rule applies when the refusal comes first and the pooled sibling fails", async () => {
    // Order-independent: whichever position the refusal occupies, it never
    // becomes the request's outcome while a real failure exists.
    const pools = healthySelector();
    const unpooled = unpooledCandidate();
    const pooled = pooledCandidate();
    const testHarness = harness();

    const surfaced = await testHarness
      .run({
        candidates: [unpooled, pooled],
        selector: pools.value,
        attempt: async (candidate) => {
          if (candidate.network_pool_ids?.length) {
            throw new GatewayError("proxy_pool_cooldown", 503, "pools cooling down");
          }
          return "served-by-global";
        },
      })
      .catch((error: unknown) => error);

    expect((surfaced as GatewayError).code).toBe("proxy_pool_cooldown");
    expect(testHarness.dialed).toEqual(["tenant-pooled"]);
  });

  test("a plan whose only candidate is the unpooled fallback still dials direct", async () => {
    // A tenant that owns no pool has no egress but direct. The guard keys on a
    // pooled sibling, so it cannot fire here and the refusal never appears.
    const pools = healthySelector();
    const unpooled = unpooledCandidate();
    const testHarness = harness();

    const result = await testHarness.run({
      candidates: [unpooled],
      selector: pools.value,
      attempt: async () => "served-direct",
    });

    expect(result).toBe("served-direct");
    expect(testHarness.dialed).toEqual([null]);
    expect(pools.requested).toEqual([]);
  });

  test("an unpooled candidate refused with no prior failure still surfaces the refusal", async () => {
    // The probe path narrows the attempt to one candidate but keeps the whole
    // plan on the lease source, so the guard still fires. Nothing was tried
    // before it, so the refusal *is* the request's outcome and must not be
    // replaced by an empty placeholder.
    const pools = healthySelector();
    const pooled = pooledCandidate("tenant-pooled");
    const unpooled = unpooledCandidate();
    const testHarness = harness();

    const surfaced = await testHarness
      .run({
        candidates: [unpooled],
        planCandidates: [pooled, unpooled],
        selector: pools.value,
        attempt: async () => "served-by-global",
      })
      .catch((error: unknown) => error);

    expect((surfaced as GatewayError).code).toBe("proxy_pool_unhealthy");
    expect((surfaced as GatewayError).details.reason).toBe("candidate_pool_missing");
    expect(testHarness.dialed).toEqual([]);
  });

  test("an all-pools-unhealthy refusal is not masked by the fallback's refusal", async () => {
    // With no selector, the pooled candidate fails `no_healthy_pool`. That is
    // the operator's real answer — every configured pool is unusable — and it
    // must not be reported as the fallback's `candidate_pool_missing`.
    const pooled = pooledCandidate();
    const unpooled = unpooledCandidate();
    const testHarness = harness();

    const surfaced = await testHarness
      .run({
        candidates: [pooled, unpooled],
        attempt: async () => "unreachable",
      })
      .catch((error: unknown) => error);

    expect((surfaced as GatewayError).code).toBe("proxy_pool_unhealthy");
    expect((surfaced as GatewayError).details.reason).toBe("no_healthy_pool");
    expect(testHarness.dialed).toEqual([]);
  });
});
