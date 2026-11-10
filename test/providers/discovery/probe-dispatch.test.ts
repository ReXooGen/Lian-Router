import { describe, expect, test } from "bun:test";
import {
  createProbeDispatcher,
  type ProbeDispatcherDeps,
  type ProbeRoutePlanner,
} from "../../../src/providers/discovery/probe-dispatch";
import { MAX_EGRESS_FAILOVERS } from "../../../src/transport/dispatch/attempt-loop";
import type { PreparedProxyRequest } from "../../../src/transport/request/preparer";
import { createAuthorizationSnapshot } from "../../../src/security/api-key-auth";
import type { NetworkPoolSelector } from "../../../src/network/pool/selector";
import type { ValidatedNetworkBindingFactory } from "../../../src/network/pool/resolver";
import type { RouteCandidate, RoutePlan } from "../../../src/transport/routing/route-model";
import type { ApiKeyAdmissionService } from "../../../src/security/admission";
import type { RoutingEngine } from "../../../src/transport/routing/router";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ResolvedCredential,
} from "../../../src/providers/provider-registry";
import { GatewayError } from "../../../src/transport/gateway-error";
import type { CanonicalRequest } from "../../../src/transport/canonical-model";

/**
 * The paid probe path must reproduce live dispatch's *routing* decision, not
 * just its request shape.
 *
 * These run `createProbeDispatcher` against the real `acquireAttemptLeases`, so
 * a refusal raised by the pool guard arrives with its production classification
 * and the operator reads the same fault their own traffic hits. A bespoke fetch
 * would have reported a transport failure here instead.
 */

const PROVIDER = "opencodeft";
const MODEL = "mimo-v2.6-flash-free";

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    provider_id: PROVIDER,
    model_id: MODEL,
    wire_family: "chat",
    endpoint: "/zen/v1/chat/completions",
    capability_profile: {},
    requires_account: false,
    tenant_id: "tenant-1",
    ...overrides,
  };
}

function request(): CanonicalRequest {
  return {
    model: MODEL,
    messages: [{ role: "user", content: [{ kind: "text", text: "ping" }] }],
    generation_controls: { max_tokens: 16, max_output_tokens: 16 },
    stream: false,
    source_surface: "chat",
  };
}

/** A plan carrying the pool-owning tenant's pooled candidate beside the caller's unpooled one. */
function preparedPlan(callerCandidate: RouteCandidate): RoutePlan {
  return {
    revision: 1,
    candidates: [
      callerCandidate,
      candidate({ tenant_id: "pool-owning-tenant", network_pool_ids: ["pool-a"], network_pool_required: true }),
    ],
    requested_model: `${PROVIDER}/${MODEL}`,
    resolved_model: `${PROVIDER}/${MODEL}`,
    provider_id: PROVIDER,
  };
}

function planner(plan: RoutePlan, callerCandidate: RouteCandidate): ProbeRoutePlanner {
  const prepared: PreparedProxyRequest = {
    canonicalRequest: request(),
    authorization: {
      id: "console-probe:tenant-1",
      tenantId: "tenant-1",
      scopes: [],
      snapshot: createAuthorizationSnapshot({
        api_key_id: "console-probe:tenant-1",
        tenant_id: "tenant-1",
      }),
    },
    candidate: callerCandidate,
    eligibleRouteCandidates: [callerCandidate],
    plan,
    estimatedInputTokens: 16,
    estimatedOutputTokens: 16,
    deadlineMs: Date.now() + 60_000,
    routingEngine: {
      reserve: async (value: RoutePlan) => ({
        candidate: value.candidates[0] ?? callerCandidate,
        lease_id: "reservation-1",
        expires_at: Date.now() + 60_000,
        acquired_at: Date.now(),
      }),
      release: async () => {},
    } as unknown as RoutingEngine,
    admissionService: {
      admit: async () => ({
        reservationId: "lease-1",
        apiKeyId: "console-probe:tenant-1",
        released: false,
        commitUsage: async () => {},
        release: async () => {},
      }),
    } as unknown as ApiKeyAdmissionService,
  };
  return { prepare: async () => prepared };
}

/** Hands back the first eligible pool the caller has not cooled. */
function selector(): NetworkPoolSelector {
  return {
    tryAcquireAvailablePool: async (eligiblePoolIds: readonly string[]) => {
      const first = eligiblePoolIds[0];
      return first === undefined ? undefined : { poolId: first, release: () => {} };
    },
  } as unknown as NetworkPoolSelector;
}

/**
 * A selector with the production selector's own cooldown view.
 *
 * It grants the first eligible pool it has not been told to cool, so a failover
 * that re-acquires *before* flagging the spent exit lands back on that same
 * exit — the exact ordering regression these tests exist to catch.
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

function adapter(dialed: string[]): ProviderAdapter {
  return {
    provider_id: PROVIDER,
    dispatch: async function* () {
      dialed.push("dispatched");
      yield {
        type: "content_delta" as const,
        sequence_number: 1,
        content: { kind: "text" as const, text: "pong" },
      };
      yield {
        type: "terminal" as const,
        sequence_number: 2,
        state: "complete" as const,
        stop_reason: "stop" as const,
      };
    },
  } as unknown as ProviderAdapter;
}

/**
 * An adapter that records the exit it dialed and fails with whatever the case
 * supplies. `outcomes` is consumed one entry per attempt; the last entry repeats
 * so a bound test can keep refusing.
 */
function failingAdapter(
  outcomes: readonly unknown[],
  dialed: Array<string | undefined>,
): ProviderAdapter {
  return {
    provider_id: PROVIDER,
    dispatch: async function* (
      _request: CanonicalRequest,
      _target: ProviderDispatchTarget,
      context: ProviderDispatchContext,
    ) {
      dialed.push(context.network_pool_id);
      const index = Math.min(dialed.length - 1, outcomes.length - 1);
      const outcome = outcomes[index];
      if (outcome !== undefined) throw outcome;
      yield {
        type: "terminal" as const,
        sequence_number: 1,
        state: "complete" as const,
        stop_reason: "stop" as const,
      };
    },
  } as unknown as ProviderAdapter;
}

/** A 429 whose evidence names the source address, so another exit may answer. */
function networkRateLimit(): GatewayError {
  return new GatewayError(
    "quota_exceeded",
    429,
    "Free usage limit reached. Subscribe to OpenCode Go to keep going.",
    { providerStatus: 429, rateLimitScope: "network", retryAfterMs: 60_000 },
    "upstream",
  );
}

/** A 429 that belongs to the account, so another exit fails identically. */
function accountRateLimit(): GatewayError {
  return new GatewayError(
    "quota_exceeded",
    429,
    "Rate limit reached for requests",
    { providerStatus: 429, rateLimitScope: "account" },
    "upstream",
  );
}

/** Only the durable half of `flagPoolCooldown` touches the database. */
const DB = {
  insert: () => ({ values: async () => [] }),
} as unknown as ProbeDispatcherDeps["db"];

const CREDENTIAL: ResolvedCredential = {
  provider_id: PROVIDER,
  credential_kind: "none",
} as ResolvedCredential;

const BINDING = {
  fetch: (() => new Response("{}")) as never,
} as unknown as ValidatedNetworkBindingFactory;

function dispatchWith(
  deps: Pick<ProbeDispatcherDeps, "planner" | "poolSelector">,
  adapterValue: ProviderAdapter,
  budget: { readonly attemptBudgetMs?: number; readonly deadlineMs?: number } = {},
) {
  return createProbeDispatcher({
    planner: deps.planner,
    networkBindingFactory: BINDING,
    poolSelector: deps.poolSelector,
    db: DB,
  })({
    providerId: PROVIDER,
    modelId: MODEL,
    tenantId: "tenant-1",
    canonicalRequest: request(),
    credential: CREDENTIAL,
    adapter: adapterValue,
    deadlineMs: budget.deadlineMs ?? Date.now() + 5_000,
    attemptBudgetMs: budget.attemptBudgetMs ?? 4_000,
    signal: AbortSignal.timeout(5_000),
  });
}

describe("createProbeDispatcher — the shared lease layer decides egress", () => {
  test("refuses locally when the candidate carries no pool and a pooled sibling exists", async () => {
    // The measured production shape: the requesting tenant owns no pool, so its
    // candidate is unpooled, while the pool-owning tenant's candidate is in the
    // plan. `acquirePoolSlot` fails closed rather than dialing direct from the
    // host address the pools exist to hide.
    const caller = candidate();
    const dialed: string[] = [];

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: selector() },
      adapter(dialed),
    );

    expect(dialed).toHaveLength(0);
    expect(outcome.reachedUpstream).toBe(false);
    expect(outcome.exitsTried).toBe(0);
    expect(outcome.error).toBeInstanceOf(GatewayError);
    const error = outcome.error as GatewayError;
    expect(error.code).toBe("proxy_pool_unhealthy");
    expect(error.status).toBe(503);
    expect(error.origin).toBe("network");
    expect(error.details.reason).toBe("candidate_pool_missing");
    expect(error.message).toBe(
      "This route has proxy pools configured, but the selected candidate carries none.",
    );
  });

  test("dispatches exactly once when the candidate carries its own pool", async () => {
    const caller = candidate({ network_pool_ids: ["pool-a"], network_pool_required: true });
    const dialed: string[] = [];

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: selector() },
      adapter(dialed),
    );

    // One completion, never a loop: the lease layer is entered once and the
    // adapter is called once.
    expect(dialed).toEqual(["dispatched"]);
    expect(outcome.reachedUpstream).toBe(true);
    expect(outcome.exitsTried).toBe(1);
    expect(outcome.error).toBeUndefined();
    expect(outcome.networkPoolId).toBe("pool-a");
    expect(outcome.events).toHaveLength(2);
  });

  test("plans the qualified id so a bare model id cannot resolve ambiguously", async () => {
    const caller = candidate({ network_pool_ids: ["pool-a"], network_pool_required: true });
    const seen: string[] = [];
    const base = planner(preparedPlan(caller), caller);
    const dispatch = createProbeDispatcher({
      planner: {
        prepare: async (input) => {
          seen.push(input.canonicalRequest.model);
          return base.prepare(input);
        },
      },
      networkBindingFactory: BINDING,
      poolSelector: selector(),
      db: DB,
    });

    await dispatch({
      providerId: PROVIDER,
      modelId: MODEL,
      tenantId: "tenant-1",
      canonicalRequest: request(),
      credential: CREDENTIAL,
      adapter: adapter([]),
      deadlineMs: Date.now() + 5_000,
      attemptBudgetMs: 4_000,
      signal: AbortSignal.timeout(5_000),
    });

    expect(seen).toEqual([`${PROVIDER}/${MODEL}`]);
  });

  test("a plan with no candidate for the pair is a gateway verdict, not a fake refusal", async () => {
    // Neither list carries the requested id: the plan resolved something else.
    // Dispatching the nearest provider candidate would answer for a different
    // model, so this must throw instead of producing a verdict.
    const other = candidate({ model_id: "another-model", network_pool_ids: ["pool-a"], network_pool_required: true });
    const dispatch = createProbeDispatcher({
      planner: {
        prepare: async () => {
          const prepared = await planner(
            {
              revision: 1,
              candidates: [other],
              requested_model: `${PROVIDER}/${MODEL}`,
              resolved_model: `${PROVIDER}/${MODEL}`,
              provider_id: PROVIDER,
            },
            other,
          ).prepare({
            canonicalRequest: request(),
            authorization: {
              id: "console-probe:tenant-1",
              tenantId: "tenant-1",
              scopes: [],
              snapshot: createAuthorizationSnapshot({
                api_key_id: "console-probe:tenant-1",
                tenant_id: "tenant-1",
              }),
            },
            deadlineMs: Date.now() + 5_000,
          });
          return { ...prepared, eligibleRouteCandidates: [other] };
        },
      },
      networkBindingFactory: BINDING,
      poolSelector: selector(),
      db: DB,
    });

    const failure = await dispatch({
      providerId: PROVIDER,
      modelId: MODEL,
      tenantId: "tenant-1",
      canonicalRequest: request(),
      credential: CREDENTIAL,
      adapter: adapter([]),
      deadlineMs: Date.now() + 5_000,
      attemptBudgetMs: 4_000,
      signal: AbortSignal.timeout(5_000),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Thrown, because the request never reached the lease layer: the caller
    // reports it as a gateway-side refusal with no allowance charged.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("no route candidate");
  });
});

describe("createProbeDispatcher — same-candidate egress failover", () => {
  test("a network-scoped 429 with more than one exit re-leases onto a different exit", async () => {
    const caller = candidate({ network_pool_ids: ["pool-a", "pool-b", "pool-c"], network_pool_required: true });
    const pools = cooldownAwareSelector();
    const dialed: Array<string | undefined> = [];

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: pools.value },
      failingAdapter([networkRateLimit(), networkRateLimit(), undefined], dialed),
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.reachedUpstream).toBe(true);
    expect(outcome.exitsTried).toBe(3);
    // Three attempts, three distinct exits: the spent exit was cooled before
    // the next acquisition, so the selector could not hand it back.
    expect(dialed).toEqual(["pool-a", "pool-b", "pool-c"]);
    expect(pools.acquired).toEqual(["pool-a", "pool-b", "pool-c"]);
  });

  test("the cooldown is flagged before re-acquisition, not after", async () => {
    // A selector that would keep returning pool-a until it is told to cool it.
    // If the dispatcher re-acquired first, the second attempt would land back
    // on pool-a and this assertion would see it twice.
    const caller = candidate({ network_pool_ids: ["pool-a", "pool-b"], network_pool_required: true });
    const pools = cooldownAwareSelector();
    const dialed: Array<string | undefined> = [];
    const coolingAtAcquire: number[] = [];
    const selectorWithTrace = {
      ...pools.value,
      tryAcquireAvailablePool: async (eligiblePoolIds: readonly string[]) => {
        coolingAtAcquire.push(pools.cooling.size);
        return pools.value.tryAcquireAvailablePool(eligiblePoolIds, PROVIDER);
      },
    } as unknown as NetworkPoolSelector;

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: selectorWithTrace },
      failingAdapter([networkRateLimit(), undefined], dialed),
    );

    expect(outcome.error).toBeUndefined();
    expect(dialed).toEqual(["pool-a", "pool-b"]);
    // Second acquisition happened with pool-a already flagged: the flag write
    // precedes the re-acquire, which is what makes the re-acquired slot a
    // different exit.
    expect(coolingAtAcquire).toEqual([0, 1]);
  });

  test("a network-scoped 429 with a single exit still dispatches exactly once", async () => {
    const caller = candidate({ network_pool_ids: ["pool-a"], network_pool_required: true });
    const dialed: Array<string | undefined> = [];

    // Deliberately cooldown-blind: this selector would happily hand back
    // `pool-a` again, so a probe that re-leased without checking the exit count
    // would dial the spent address a second time. The one-shot rule has to hold
    // on its own, not because the selector happens to refuse.
    const blindSelector = {
      tryAcquireAvailablePool: async (eligiblePoolIds: readonly string[]) => {
        const first = eligiblePoolIds[0];
        return first === undefined ? undefined : { poolId: first, release: () => {} };
      },
      getInflight: () => 0,
      flagProviderCooldown: async () => {},
    } as unknown as NetworkPoolSelector;

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: blindSelector },
      failingAdapter([networkRateLimit()], dialed),
    );

    expect(dialed).toEqual(["pool-a"]);
    expect(outcome.exitsTried).toBe(1);
    expect((outcome.error as GatewayError).code).toBe("quota_exceeded");
  });

  test("each attempt gets its own signal, not the probe's single shared one", async () => {
    // The failure this guards: a retry inheriting the first attempt's signal
    // dies as `transport_closed` the moment that signal expires, so the fresh
    // exit never gets to answer. Identity is the deterministic evidence — a
    // shared signal would be the same object on both attempts.
    const caller = candidate({ network_pool_ids: ["pool-a", "pool-b"], network_pool_required: true });
    const pools = cooldownAwareSelector();
    const observed: Array<{ signal: AbortSignal; aborted: boolean; deadlineAheadMs: number }> = [];
    const recordingAdapter = {
      provider_id: PROVIDER,
      dispatch: async function* (
        _request: CanonicalRequest,
        _target: ProviderDispatchTarget,
        context: ProviderDispatchContext,
      ) {
        observed.push({
          signal: context.abort_signal,
          aborted: context.abort_signal.aborted,
          deadlineAheadMs: context.deadline - Date.now(),
        });
        if (observed.length === 1) throw networkRateLimit();
        yield {
          type: "terminal" as const,
          sequence_number: 1,
          state: "complete" as const,
          stop_reason: "stop" as const,
        };
      },
    } as unknown as ProviderAdapter;

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: pools.value },
      recordingAdapter,
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.exitsTried).toBe(2);
    expect(observed).toHaveLength(2);
    const first = observed[0];
    const second = observed[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.signal).not.toBe(first?.signal);
    // Both were live when their attempt started: neither inherited an abort.
    expect(first?.aborted).toBe(false);
    expect(second?.aborted).toBe(false);
    // And each carried a real forward deadline rather than a consumed one.
    expect(second?.deadlineAheadMs).toBeGreaterThan(0);
  });

  test("an account-scoped 429 dispatches exactly once", async () => {
    const caller = candidate({ network_pool_ids: ["pool-a", "pool-b", "pool-c"], network_pool_required: true });
    const pools = cooldownAwareSelector();
    const dialed: Array<string | undefined> = [];

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: pools.value },
      failingAdapter([accountRateLimit()], dialed),
    );

    // Another exit fails identically on an account limit, so a second attempt
    // would spend a unit for an answer the first one already gave.
    expect(dialed).toEqual(["pool-a"]);
    expect(outcome.exitsTried).toBe(1);
    expect(outcome.error).toBeInstanceOf(GatewayError);
    expect((outcome.error as GatewayError).details.rateLimitScope).toBe("account");
  });

  test("a 5xx dispatches exactly once even with many exits", async () => {
    const caller = candidate({ network_pool_ids: ["pool-a", "pool-b", "pool-c"], network_pool_required: true });
    const pools = cooldownAwareSelector();
    const dialed: Array<string | undefined> = [];
    const upstreamError = new GatewayError(
      "platform_unavailable",
      502,
      "upstream exploded",
      { upstreamStatus: 502 },
      "upstream",
    );

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: pools.value },
      failingAdapter([upstreamError], dialed),
    );

    expect(dialed).toEqual(["pool-a"]);
    expect(outcome.exitsTried).toBe(1);
  });

  test("the failover is bounded at MAX_EGRESS_FAILOVERS", async () => {
    // Nine exits, every one refusing: the bound is the attempt loop's own
    // constant, so the probe burns one initial attempt plus the bound and then
    // reports the refusal instead of walking the whole pool.
    const poolIds = Array.from({ length: MAX_EGRESS_FAILOVERS + 4 }, (_, index) => `pool-${index}`);
    const caller = candidate({ network_pool_ids: poolIds, network_pool_required: true });
    const pools = cooldownAwareSelector();
    const dialed: Array<string | undefined> = [];

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: pools.value },
      failingAdapter([networkRateLimit()], dialed),
    );

    expect(dialed).toHaveLength(MAX_EGRESS_FAILOVERS + 1);
    expect(outcome.exitsTried).toBe(MAX_EGRESS_FAILOVERS + 1);
    expect((outcome.error as GatewayError).details.rateLimitScope).toBe("network");
  });

  test("exitsTried counts the exits actually dialed, not the lease attempts", async () => {
    const caller = candidate({ network_pool_ids: ["pool-a", "pool-b"], network_pool_required: true });
    const pools = cooldownAwareSelector();
    const dialed: Array<string | undefined> = [];

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: pools.value },
      failingAdapter([networkRateLimit(), networkRateLimit()], dialed),
    );

    // Two exits refused, and no third slot to try: the count must equal the
    // number of completions sent, which is what the console reports.
    expect(dialed).toHaveLength(2);
    expect(outcome.exitsTried).toBe(2);
    expect(outcome.networkPoolId).toBe("pool-b");
    expect((outcome.error as GatewayError).code).toBe("quota_exceeded");
  });

  test("a refused re-lease keeps the upstream refusal and reports the exits burned", async () => {
    // Every exit is cooling after the first refusal, so the second acquisition
    // fails. The operator's answer is still the upstream 429 — the re-lease
    // complaint is about exits we could not reach, not about the provider.
    const caller = candidate({ network_pool_ids: ["pool-a", "pool-b"], network_pool_required: true });
    const dialed: Array<string | undefined> = [];
    const refusingSelector = {
      tryAcquireAvailablePool: async (eligiblePoolIds: readonly string[]) => {
        const first = eligiblePoolIds[0];
        if (first === undefined) return undefined;
        return dialed.length === 0 ? { poolId: first, release: () => {} } : undefined;
      },
      getInflight: () => 0,
      flagProviderCooldown: async () => {},
      getSelectionFailure: async () => ({ reason: "cooldown" as const, pools: [] }),
    } as unknown as NetworkPoolSelector;

    const outcome = await dispatchWith(
      { planner: planner(preparedPlan(caller), caller), poolSelector: refusingSelector },
      failingAdapter([networkRateLimit()], dialed),
    );

    expect(outcome.exitsTried).toBe(1);
    expect(outcome.networkPoolId).toBe("pool-a");
    expect(outcome.error).toBeInstanceOf(GatewayError);
    expect((outcome.error as GatewayError).status).toBe(429);
    expect((outcome.error as GatewayError).origin).toBe("upstream");
  });
});
