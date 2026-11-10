/**
 * The one paid path a probe may take: a real completion dispatched through the
 * shared lease layer live traffic uses.
 *
 * Why this module exists. A probe used to call `adapter.dispatch` with an
 * outbound binding resolved per tenant, which meant it never entered
 * `acquireAttemptLeases`. Everything that decides *whether a request may leave
 * the box* lives in that function — the pool slot, the sibling guard, the
 * routing reservation — so a probe could report a provider fault for a request
 * live traffic refuses locally with `proxy_pool_unhealthy` /
 * `candidate_pool_missing`, and could dial direct from the host address while
 * the pooled route would not. A probe that answers a different question than
 * the operator's own traffic is worse than no probe.
 *
 * What is deliberately *not* here: candidate failover and retry-after-backoff.
 * One probe is one completion against one candidate — the console path owns its
 * own telemetry and account health, and a second candidate would answer a
 * question about a different route. The attempt loop's retry policy therefore
 * is not reused; the lease layer it delegates to is.
 *
 * The one exception is same-candidate egress failover, and it is the same
 * exception the attempt loop makes. A 429 whose evidence names the source
 * address says the *exit* was spent, not the request: it produced no answer, so
 * the second exit's untouched allowance is not a second unit bought for an
 * answer the first attempt already gave. Re-lease after flagging the spent
 * pool, dispatch again, bounded by the loop's own `MAX_EGRESS_FAILOVERS`. Every
 * other failure — an account-scoped 429, a 5xx, a transport error, a candidate
 * with a single exit — still dispatches exactly once, because there the
 * original rationale holds: the next attempt would spend a unit for an answer
 * the first one already gave.
 */
import type { CanonicalEvent, CanonicalRequest } from "../../transport/canonical-model";
import type { PreparedProxyRequest } from "../../transport/request/preparer";
import type { ResolvedApiKey } from "../../security/api-key-auth";
import { acquireAttemptLeases, releaseAttemptLeases } from "../../transport/dispatch/leases";
import type { AttemptLeaseSource, AttemptLeases } from "../../transport/dispatch/leases";
import { MAX_EGRESS_FAILOVERS } from "../../transport/dispatch/attempt-loop";
import { isNetworkScopedRateLimit } from "../../transport/dispatch/retry-policy";
import type { RouteCandidate } from "../../transport/routing/route-model";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { flagPoolCooldown } from "../../network/pool-health";
import type { ProviderAdapter, ResolvedCredential } from "../provider-registry";
import { LIANROUTER_PROBE_MARKER, parseProviderId } from "../provider-registry";

/**
 * The planning seam. `ProxyRequestPreparer` satisfies it structurally, so the
 * production wiring passes the real instance and a test passes a double without
 * the class having to grow a second constructor.
 */
export interface ProbeRoutePlanner {
  prepare(input: {
    readonly canonicalRequest: CanonicalRequest;
    readonly authorization: ResolvedApiKey;
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
  }): Promise<PreparedProxyRequest>;
}

/** Everything the probing service supplies for one opted-in completion. */
export interface ProbeDispatchRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly tenantId: string;
  readonly canonicalRequest: CanonicalRequest;
  readonly credential: ResolvedCredential;
  readonly adapter: ProviderAdapter;
  /** Absolute instant the whole probe must be finished by, retries included. */
  readonly deadlineMs: number;
  /**
   * Budget for one exit attempt, re-armed for every attempt.
   *
   * The dispatcher owns the re-lease loop, so it — not the service — has to
   * mint the per-attempt deadline and signal. Without a per-attempt budget a
   * retry would inherit whatever the previous attempt left of the probe's
   * single signal: a slow-but-working second exit would be aborted as
   * `transport_closed` before it could answer, which is the failure this field
   * exists to prevent. `deadlineMs` stays the outer bound, so the sum of the
   * attempts still cannot exceed the probe's own budget.
   */
  readonly attemptBudgetMs: number;
  /** Overall probe signal; aborts the whole call, including any retry. */
  readonly signal: AbortSignal;
}

export interface ProbeDispatchOutcome {
  readonly events: readonly CanonicalEvent[];
  readonly ttfbMs: number | undefined;
  readonly networkPoolId: string | undefined;
  /**
   * Whether the attempt got past lease acquisition and actually called the
   * adapter.
   *
   * This is the allowance accounting: a route refused locally (no pool slot,
   * sibling guard) never left the box and charged nothing, while anything that
   * reached the adapter may have spent a unit — including a 429, which is the
   * provider saying the unit was already gone. Reporting the two as the same
   * cost would make the operator avoid a probe that is free.
   */
  readonly reachedUpstream: boolean;
  /**
   * How many exits this probe actually dialed.
   *
   * An egress-scoped 429 moves the probe to another exit, so "refused" alone
   * cannot distinguish one spent address from nine: the operator needs the
   * count to tell a single spent exit from a candidate with nothing left.
   * `0` means the probe never left the box (a lease refusal), which is also
   * what `reachedUpstream: false` says.
   */
  readonly exitsTried: number;
  /** The classified failure, or `undefined` when the attempt produced events. */
  readonly error: unknown;
}

/**
 * The probing service's dispatch seam.
 *
 * A seam rather than a direct call because a test has to assert *how many*
 * completions were sent and with what budget without standing up Postgres,
 * Redis, and a route snapshot. Production binds `createProbeDispatcher`; the
 * service never accepts any other implementation there.
 */
export type ProbeDispatchFn = (input: ProbeDispatchRequest) => Promise<ProbeDispatchOutcome>;

/**
 * Admission identity for a probe.
 *
 * A probe is not an API key, so it must not be charged to one: reusing a real
 * key's counters would let a diagnostic click consume that key's RPM and
 * concurrency budget. The identity is derived from the tenant instead, which is
 * the only party the console action actually acts for. No row is written — the
 * counters are the admission store's own.
 */
function probeAuthorization(tenantId: string): ResolvedApiKey {
  const apiKeyId = `console-probe:${tenantId}`;
  return {
    id: apiKeyId,
    tenantId,
    scopes: [],
    snapshot: {
      api_key_id: apiKeyId,
      tenant_id: tenantId,
      admission_identity: apiKeyId,
    },
  };
}

export interface ProbeDispatcherDeps {
  readonly planner: ProbeRoutePlanner;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
  readonly poolSelector: NetworkPoolSelector;
  /**
   * Only used to record the durable half of a pool cooldown, exactly as the
   * attempt loop does. The volatile flag lives in the selector; the audit row
   * is what lets an operator see which exit a probe burned.
   */
  readonly db: LianRouterDatabase;
}

/**
 * Binds the shared routing/egress collaborators once per process and returns
 * the per-probe dispatch entry point.
 *
 * The request is qualified with the provider id before planning so a bare model
 * id served by several providers resolves to the one the operator is looking at
 * instead of failing as `ambiguous_model`. The candidate handed to the attempt
 * is narrowed to that single provider+model pair, while the *plan* on the lease
 * source stays whole: `acquirePoolSlot` reads the plan to decide whether an
 * unpooled candidate has a pooled sibling, and truncating it there would hide
 * the very refusal this path exists to reproduce.
 */
export function createProbeDispatcher(deps: ProbeDispatcherDeps): ProbeDispatchFn {
  return async (input) => {
    const { providerId, modelId, tenantId, canonicalRequest, credential, adapter, deadlineMs, signal } =
      input;
    const prepared = await deps.planner.prepare({
      canonicalRequest: { ...canonicalRequest, model: `${providerId}/${modelId}` },
      authorization: probeAuthorization(tenantId),
      deadlineMs,
      signal,
    });
    // Exact pair only. A provider-wide fallback would dispatch a *different*
    // model than the operator asked about and report its answer as this id's —
    // which is the one substitution a probe must never make.
    const candidate: RouteCandidate | undefined =
      prepared.eligibleRouteCandidates.find(
        (entry) => entry.provider_id === providerId && entry.model_id === modelId,
      ) ?? prepared.plan.candidates.find(
        (entry) => entry.provider_id === providerId && entry.model_id === modelId,
      );
    if (candidate === undefined) {
      // The plan resolved but carries nothing for this pair. That is a routing
      // verdict, not a dispatch: reporting it as a refused generation would
      // suggest an upstream was contacted.
      throw new Error(`no route candidate for ${providerId}/${modelId}`);
    }
    const leaseSource: AttemptLeaseSource = {
      admissionService: prepared.admissionService,
      routingEngine: prepared.routingEngine,
      plan: prepared.plan,
      // A probe sends one trivial prompt. Estimating it as anything larger
      // would reserve token budget the request never spends.
      estimatedInputTokens: 16,
      estimatedOutputTokens: canonicalRequest.generation_controls.max_output_tokens ?? 16,
      authorizationSnapshot: prepared.authorization.snapshot,
      // A console probe is not a key, so it carries no key egress binding. Pool
      // choice comes from the candidate, exactly as it does for an unbound key.
      networkPoolId: undefined,
    };
    let events: CanonicalEvent[] = [];
    let ttfbMs: number | undefined;
    let error: unknown;
    let networkPoolId: string | undefined;
    let reachedUpstream = false;
    let exitsTried = 0;
    let egressFailovers = 0;
    for (;;) {
      let leases: AttemptLeases;
      try {
        leases = await acquireAttemptLeases(leaseSource, candidate, {
          signal,
          poolSelector: deps.poolSelector,
          networkBindingFactory: deps.networkBindingFactory,
          strictPoolSelection: true,
        });
      } catch (refused) {
        if (exitsTried === 0) {
          // A lease refusal is the gateway's own verdict and it happened before
          // any byte left the box: `proxy_pool_unhealthy` /
          // `candidate_pool_missing` is the common one, and it is a
          // routing/config fault, not a provider fault and not a spent
          // allowance. Returned rather than thrown so the probe reports a
          // classified refusal instead of an exception.
          return {
            events: [],
            ttfbMs: undefined,
            networkPoolId: undefined,
            reachedUpstream: false,
            exitsTried: 0,
            error: refused,
          };
        }
        // A re-lease refused after an exit already refused us means every
        // remaining exit is cooling or at capacity. The refusal that decided
        // the probe is still the upstream one: it names a limit the operator
        // can act on, while this complaint is only about the exits we could
        // not reach. Keep the upstream answer and report how many were burned.
        break;
      }
      reachedUpstream = true;
      exitsTried += 1;
      events = [];
      ttfbMs = undefined;
      error = undefined;
      const attemptStartedAt = Date.now();
      // Re-armed per exit, bounded by the probe's own deadline: a retry that
      // inherited a consumed budget would die as `transport_closed` before the
      // fresh exit could answer, and the overall budget still caps the sum.
      const remainingMs = Math.max(1, deadlineMs - Date.now());
      const attemptBudgetMs = Math.max(1, Math.min(input.attemptBudgetMs, remainingMs));
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptBudgetMs)]);
      try {
        for await (const event of adapter.dispatch(
          canonicalRequest,
          {
            provider_id: parseProviderId(providerId),
            model_id: modelId,
            wire_family: candidate.wire_family,
            endpoint_path: candidate.endpoint,
            capabilities: {},
          },
          {
            credential,
            deadline: Date.now() + attemptBudgetMs,
            abort_signal: attemptSignal,
            outbound_fetch: deps.networkBindingFactory.fetch(leases.networkPoolId, tenantId),
            probe_marker: LIANROUTER_PROBE_MARKER,
            ...(leases.networkPoolId ? { network_pool_id: leases.networkPoolId } : {}),
          },
        )) {
          if (ttfbMs === undefined) ttfbMs = Date.now() - attemptStartedAt;
          events.push(event);
        }
      } catch (caught) {
        error = caught;
      }
      const spentPoolId = leases.networkPoolId;
      await releaseAttemptLeases(leases, prepared.routingEngine);
      networkPoolId = spentPoolId;
      // Another exit on the same candidate may still have allowance. Same
      // predicate and same bound as the attempt loop: only an egress-keyed 429
      // is evidence that a different address can answer, and the candidate must
      // actually carry more than one exit to move to. A leased pool id is the
      // third requirement and not a formality: with no pool the "next" attempt
      // would dial the same host address again, which is the retry the one-shot
      // rule exists to forbid.
      //
      // Split into guards rather than one boolean so the type predicate narrows
      // the refusal for `flagPoolCooldown`, which takes the classified error
      // rather than `unknown`.
      const refusal = error;
      if (spentPoolId === undefined) break;
      if ((candidate.network_pool_ids?.length ?? 0) <= 1) break;
      if (egressFailovers >= MAX_EGRESS_FAILOVERS) break;
      if (!isNetworkScopedRateLimit(refusal)) break;
      // Flagged *before* re-acquiring: the selector reads its own local cooldown
      // map on the next acquisition, so the slot it hands back cannot be the
      // exit that just refused. Ordering this after the acquire put the probe
      // back on the spent address and burned the failover budget for nothing.
      flagPoolCooldown(deps.poolSelector, deps.db, spentPoolId, providerId, refusal);
      egressFailovers += 1;
    }
    return {
      events,
      ttfbMs,
      networkPoolId,
      reachedUpstream,
      exitsTried,
      error,
    };
  };
}
