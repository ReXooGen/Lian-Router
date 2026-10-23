import { describe, expect, test } from "bun:test";
import { acquireAttemptLeases, type AttemptLeaseSource } from "../../../src/transport/dispatch/leases";
import { createAuthorizationSnapshot } from "../../../src/security/api-key-auth";
import type { NetworkPoolSelector } from "../../../src/network/pool/selector";
import type { RouteCandidate, RoutePlan } from "../../../src/transport/routing/route-model";
import type { ApiKeyAdmissionService } from "../../../src/security/admission";
import type { RoutingEngine } from "../../../src/transport/routing/router";

/**
 * The key's `network_pool_id` is a narrowing constraint applied at lease time.
 *
 * These run `acquireAttemptLeases` directly rather than through the dispatch
 * handler: the rule under test lives in `acquirePoolSlot`, and a handler-level
 * test would also drag in credential resolution and adapter dispatch, which
 * cannot fail this assertion.
 */
function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    provider_id: "anthropic",
    model_id: "claude-sonnet-4-5",
    wire_family: "chat",
    endpoint: "/v1/messages",
    capability_profile: {},
    provider_account_id: "account-1",
    tenant_id: "tenant-1",
    ...overrides,
  };
}

function plan(candidates: readonly RouteCandidate[]): RoutePlan {
  return {
    revision: 1,
    candidates,
    requested_model: "claude-sonnet-4-5",
    resolved_model: "claude-sonnet-4-5",
    provider_id: "anthropic",
  };
}

function source(
  candidates: readonly RouteCandidate[],
  networkPoolId: string | undefined,
): AttemptLeaseSource {
  return {
    admissionService: {
      admit: async () => ({
        reservationId: "lease-1",
        apiKeyId: "key-1",
        released: false,
        commitUsage: async () => {},
        release: async () => {},
      }),
    } as unknown as ApiKeyAdmissionService,
    routingEngine: {
      reserve: async (value: RoutePlan) => ({
        candidate: value.candidates[0] ?? candidate(),
        lease_id: "reservation-1",
        expires_at: Date.now() + 60_000,
        acquired_at: Date.now(),
      }),
      release: async () => {},
    } as unknown as RoutingEngine,
    plan: plan(candidates),
    estimatedInputTokens: 10,
    estimatedOutputTokens: 10,
    authorizationSnapshot: createAuthorizationSnapshot({
      api_key_id: "key-1",
      tenant_id: "tenant-1",
      ...(networkPoolId === undefined ? {} : { network_pool_id: networkPoolId }),
    }),
    networkPoolId,
  };
}

/** Selector that records what it was asked for and always admits the first id. */
function selector() {
  const requested: string[][] = [];
  const value: NetworkPoolSelector = {
    tryAcquireAvailablePool: async (eligiblePoolIds: readonly string[]) => {
      requested.push([...eligiblePoolIds]);
      const first = eligiblePoolIds[0];
      return first === undefined ? undefined : { poolId: first, release: () => {} };
    },
  } as unknown as NetworkPoolSelector;
  return { value, requested };
}

const signal = new AbortController().signal;

describe("API-key pool binding at lease time", () => {
  test("intersects the candidate's pool set down to the key's pool", async () => {
    const pools = selector();
    const leases = await acquireAttemptLeases(
      source(
        [candidate({ network_pool_ids: ["pool-a", "pool-b"], network_pool_limits: { "pool-a": 8, "pool-b": 8 } })],
        "pool-b",
      ),
      candidate({ network_pool_ids: ["pool-a", "pool-b"], network_pool_limits: { "pool-a": 8, "pool-b": 8 } }),
      { signal, poolSelector: pools.value, strictPoolSelection: true },
    );

    // Exactly one pool was offered to the selector: the key narrowed the set,
    // it did not merely reorder it.
    expect(pools.requested).toEqual([["pool-b"]]);
    expect(leases.networkPoolId).toBe("pool-b");
  });

  test("a key pool outside the candidate's set is rejected, not widened", async () => {
    const pools = selector();
    const candidateValue = candidate({ network_pool_ids: ["pool-a"], network_pool_limits: { "pool-a": 8 } });

    await expect(
      acquireAttemptLeases(source([candidateValue], "pool-excluded"), candidateValue, {
        signal,
        poolSelector: pools.value,
        strictPoolSelection: true,
      }),
    ).rejects.toMatchObject({ code: "proxy_pool_not_allowed", status: 403 });

    // Nothing was dialed and nothing was acquired: falling back to `pool-a`
    // would dispatch from an address the key's owner excluded.
    expect(pools.requested).toEqual([]);
  });

  test("a direct-pinned account fails closed when the key names a pool", async () => {
    // The account's `bypass_proxy` is an operator statement that this
    // credential never leaves through a proxy. The key cannot override it, and
    // dialing direct would violate the key's own binding, so the request fails
    // instead of silently choosing either side.
    const pools = selector();
    const candidateValue = candidate({ network_pool_direct: true });

    await expect(
      acquireAttemptLeases(source([candidateValue], "pool-a"), candidateValue, {
        signal,
        poolSelector: pools.value,
        strictPoolSelection: true,
      }),
    ).rejects.toMatchObject({
      code: "proxy_pool_not_allowed",
      status: 403,
      details: { reason: "account_direct" },
    });
    expect(pools.requested).toEqual([]);
  });

  test("a bound key never falls through to direct egress without a selector", async () => {
    const candidateValue = candidate({ network_pool_ids: ["pool-a"] });

    await expect(
      acquireAttemptLeases(source([candidateValue], "pool-a"), candidateValue, {
        signal,
        strictPoolSelection: true,
      }),
    ).rejects.toMatchObject({ code: "proxy_pool_unavailable", status: 503 });
  });

  test("lenient pool semantics still fail closed for a key that named its pool", async () => {
    // The Responses-compact route tolerates a missing slot so it can dial
    // direct. A key binding is a narrower statement than that leniency.
    const pools = selector();
    const candidateValue = candidate({ network_pool_ids: ["pool-a"] });
    const emptySelector = {
      tryAcquireAvailablePool: async () => undefined,
    } as unknown as NetworkPoolSelector;

    await expect(
      acquireAttemptLeases(source([candidateValue], "pool-a"), candidateValue, {
        signal,
        poolSelector: emptySelector,
        strictPoolSelection: false,
      }),
    ).rejects.toMatchObject({ code: "proxy_pool_unavailable", status: 503 });
    expect(pools.requested).toEqual([]);
  });

  test("a key with no pool keeps today's behavior exactly", async () => {
    const pools = selector();
    const candidateValue = candidate({
      network_pool_ids: ["pool-a", "pool-b"],
      network_pool_limits: { "pool-a": 8, "pool-b": 8 },
    });

    const leases = await acquireAttemptLeases(
      source([candidateValue], undefined),
      candidateValue,
      { signal, poolSelector: pools.value, strictPoolSelection: true },
    );

    expect(pools.requested).toEqual([["pool-a", "pool-b"]]);
    expect(leases.networkPoolId).toBe("pool-a");
  });

  test("a direct-pinned account with an unbound key still dials direct", async () => {
    const pools = selector();
    const candidateValue = candidate({ network_pool_direct: true });

    const leases = await acquireAttemptLeases(
      source([candidateValue], undefined),
      candidateValue,
      { signal, poolSelector: pools.value, strictPoolSelection: true },
    );

    expect(pools.requested).toEqual([]);
    expect(leases.networkPoolId).toBeUndefined();
  });
});

describe("unpooled candidate beside a pooled sibling", () => {
  test("fails closed instead of dialing direct", async () => {
    // A plan that still carries an unpooled candidate next to a pooled one:
    // dialing it would leave from the host address the pool exists to hide.
    const pools = selector();
    const pooled = candidate({ network_pool_ids: ["pool-a"], network_pool_required: true });
    const unpooled = candidate({ requires_account: false, tenant_id: null });

    await expect(
      acquireAttemptLeases(source([pooled, unpooled], undefined), unpooled, {
        signal,
        poolSelector: pools.value,
        strictPoolSelection: true,
      }),
    ).rejects.toMatchObject({ code: "proxy_pool_unhealthy", status: 503 });
    expect(pools.requested).toEqual([]);
  });

  test("a pool-scoped sibling with an empty eligible set does not block the direct dial", async () => {
    // An empty `network_pool_ids` is the all-pools-disabled/cooldown
    // configuration: that tenant has no working egress, so the direct
    // candidate is its only route. Keying the guard on real ids is what keeps
    // this from becoming a 503 for a tenant that never had a pool to use.
    const pools = selector();
    const noWorkingPool = candidate({ network_pool_ids: [], network_pool_required: true });
    const unpooled = candidate({ requires_account: false, tenant_id: null });

    const leases = await acquireAttemptLeases(
      source([noWorkingPool, unpooled], undefined),
      unpooled,
      { signal, poolSelector: pools.value, strictPoolSelection: true },
    );

    expect(pools.requested).toEqual([]);
    expect(leases.networkPoolId).toBeUndefined();
  });

  test("a plan with no pooled sibling still dials direct", async () => {
    // A tenant that owns no pool has no egress but direct; the guard keys on
    // the presence of a pooled sibling precisely so it cannot fire here.
    const pools = selector();
    const unpooled = candidate({ requires_account: false, tenant_id: null });

    const leases = await acquireAttemptLeases(
      source([unpooled], undefined),
      unpooled,
      { signal, poolSelector: pools.value, strictPoolSelection: true },
    );

    expect(pools.requested).toEqual([]);
    expect(leases.networkPoolId).toBeUndefined();
  });

  test("a key-bound pool plus an unpooled-only candidate set still yields proxy_pool_not_allowed", async () => {
    const pools = selector();
    const unpooled = candidate({ requires_account: false, tenant_id: null });

    await expect(
      acquireAttemptLeases(source([unpooled], "pool-a"), unpooled, {
        signal,
        poolSelector: pools.value,
        strictPoolSelection: true,
      }),
    ).rejects.toMatchObject({
      code: "proxy_pool_not_allowed",
      status: 403,
      details: { reason: "pool_not_in_candidate_set" },
    });
    expect(pools.requested).toEqual([]);
  });

  test("the key-binding 403 outranks the unpooled-sibling 503", async () => {
    // Both refusals apply to this candidate. The key's binding is the narrower
    // statement and the caller must learn their pool is unusable, not that
    // some unrelated candidate carried none.
    const pools = selector();
    const pooled = candidate({ network_pool_ids: ["pool-a"], network_pool_required: true });
    const unpooled = candidate({ requires_account: false, tenant_id: null });

    await expect(
      acquireAttemptLeases(source([pooled, unpooled], "pool-a"), unpooled, {
        signal,
        poolSelector: pools.value,
        strictPoolSelection: true,
      }),
    ).rejects.toMatchObject({
      code: "proxy_pool_not_allowed",
      status: 403,
      details: { reason: "pool_not_in_candidate_set" },
    });
    expect(pools.requested).toEqual([]);
  });
});
