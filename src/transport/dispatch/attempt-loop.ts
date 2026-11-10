/**
 * Shared per-candidate attempt lifecycle for every dispatch route.
 *
 * Admission lease → pool slot → routing reservation, the route-specific
 * upstream operation, then one `completeAttempt` for the attempt's accounting.
 * Retry, backoff, pool-cooldown flagging, and reactive OAuth refresh are one
 * policy here, so the canonical proxy routes and the native Responses-compact
 * route cannot drift. Route-specific behavior arrives as the `prepare` and
 * `attempt` closures; this module never forks retry policy.
 */
import { GatewayError } from "../gateway-error";
import type { ResolvedCredential } from "../../providers/provider-registry";
import { classifyTerminalCategory, fallbackRetryDelayMs, isCandidateScopedPoolRefusal, isRetryableFailure, sleep } from "../failure-policy";
import type { OAuthTokenRefresher } from "../../providers/authentication/oauth-refresh-service";
import type { OAuthRefreshService } from "../../providers/authentication/oauth-refresh-service";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import type { ByokUpstreamHost } from "../../providers/operations/provider-catalog-service";
import type { AdmissionLease } from "../../security/admission";
import type { RouteCandidate, Reservation, RouteSnapshotService } from "../routing/route-model";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { acquireAttemptLeases, releaseAttemptLeases } from "./leases";
import type { AttemptLeaseSource, AttemptLeases } from "./leases";
import { metrics } from "../../observability/metrics";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { ProxyRequestState } from "../request/state";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { flagPoolCooldown } from "../../network/pool-health";
import { completeAttempt, estimatedUsage, type ProviderExchangeCapture } from "./attempt-finalize";
import { repriceUsage } from "../../providers/usage";
import {
  shouldCooldownPool,
  isNetworkScopedRateLimit,
  isOAuthCredentialInvalidated,
  isPoolConnectFailure,
} from "./retry-policy";

/**
 * Extra exits a single request may burn when the upstream reports an
 * egress-keyed limit.
 *
 * The bound exists to stop a pathological all-spent candidate from spending the
 * request's whole deadline, not to limit how many healthy exits may be tried.
 * Two properties make a generous bound safe. Draws within one request are
 * without replacement — a cooled exit leaves the candidate's eligible set, so
 * each extra attempt samples from a strictly smaller spent-or-healthy pool.
 * And a spent free-tier exit is a *refusal*, not a generation: one proxy
 * CONNECT plus a fast upstream 429, with no tokens produced and no billed
 * usage, so an extra attempt is cheap in a way an extra generation is not.
 *
 * The number this deployment cares about: with 100 exits and a currently-spent
 * fraction `f`, the chance a request dies is roughly `f ** (bound + 1)`. At
 * `f = 0.28` — 28 of 100 distinct pools have been cooled at least once — a
 * bound of 2 fails about 2% of requests, while a bound of 8 fails about 4 in
 * 100,000. That gap is the reason for the value. The request deadline still
 * bounds the total, so a genuinely all-spent candidate ends on the budget
 * rather than on this constant.
 */
export const MAX_EGRESS_FAILOVERS = 8;

/** Route-specific preconditions resolved for one candidate before its leases are taken. */
interface PreparedAttempt<TAdapter> {
  readonly credential: ResolvedCredential;
  readonly adapter: TAdapter;
}

/** One candidate attempt with its admission lease, pool slot, and reservation held. */
interface AttemptContext<TAdapter> {
  readonly candidate: RouteCandidate;
  readonly credential: ResolvedCredential;
  readonly adapter: TAdapter;
  readonly leases: AttemptLeases;
  /** Zero-based candidate index; also this attempt's failover count. */
  readonly attemptIndex: number;
  readonly providerCapture: ProviderExchangeCapture;
  /**
   * Hands lease ownership to the value this attempt returns (a streaming
   * response releases its own lease on stream completion/cancel). Without it
   * the loop releases the leases in `finally`.
   */
  retainLeases(): void;
}

/** Collaborators shared by every dispatch route. */
interface AttemptLoopDeps {
  readonly db: LianRouterDatabase;
  readonly poolSelector?: NetworkPoolSelector;
  readonly networkBindingFactory?: ValidatedNetworkBindingFactory;
  readonly snapshotService?: RouteSnapshotService;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly resolveOAuthRefresher?: (providerId: string) => Promise<OAuthTokenRefresher | undefined>;
  readonly oauthRefreshService?: OAuthRefreshService;
}

interface AttemptLoopInput<TResult, TAdapter> {
  readonly state: ProxyRequestState;
  readonly deps: AttemptLoopDeps;
  readonly leaseSource: AttemptLeaseSource;
  readonly candidates: readonly RouteCandidate[];
  readonly tenantId: string | null;
  /** Strict pool selection rejects direct egress when every pool is at capacity. */
  readonly strictPoolSelection: boolean;
  /** BYOK host for a candidate, when this route validates network bindings. */
  readonly resolveHost?: (candidate: RouteCandidate) => ByokUpstreamHost | undefined;
  readonly prepare: (candidate: RouteCandidate) => Promise<PreparedAttempt<TAdapter>>;
  readonly attempt: (context: AttemptContext<TAdapter>) => Promise<TResult>;
  /** Raised when the candidate list is empty and no attempt ever ran. */
  readonly exhaustedError: GatewayError;
}

/**
 * Shared per-candidate attempt lifecycle for the canonical proxy routes and
 * the native Responses-compact route: admission lease → pool slot → routing
 * reservation, the route-specific upstream operation, then one
 * `completeAttempt` for the attempt's accounting. Retry, backoff,
 * pool-cooldown flagging, and reactive OAuth refresh are one policy here, so
 * the two routes cannot drift.
 */
export async function runAttemptLoop<TResult, TAdapter>(
  input: AttemptLoopInput<TResult, TAdapter>,
): Promise<TResult> {
  const { state, deps, candidates, leaseSource } = input;
  let lastError: unknown = input.exhaustedError;
  const refreshedCandidates = new Set<string>();
  // Same-candidate egress failover: a public provider candidate can carry many
  // pools while the candidate list holds exactly one entry, so the outer loop
  // has no second candidate to try. An egress-keyed 429 is the one case where
  // another attempt on the same candidate can succeed, because re-acquiring a
  // slot after the cooldown flag picks a different exit. Keyed by candidate
  // index so the bound does not leak between candidates.
  const egressFailovers = new Map<number, number>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    let lease: AdmissionLease | undefined;
    let reservation: Reservation | undefined;
    let proxySlot: { poolId: string; release: () => void } | undefined;
    let networkPoolId: string | undefined;
    let bindingEstablished = false;
    let leasesRetained = false;
    let retryDelayMs = 0;
    const providerCapture: ProviderExchangeCapture = {
      request: null,
      response: Promise.resolve(null),
    };
    try {
      if (state.abortController.signal.aborted)
        throw new GatewayError("transport_closed", 499, "request was cancelled");
      const { credential, adapter } = await input.prepare(candidate);
      const host = input.resolveHost?.(candidate);
      // Single attempt-lease manager owns acquisition order (admission →
      // pool slot → reservation) with reverse-order unwind. Assigned only on
      // success, so a mid-acquire throw leaves these undefined for `finally`.
      const attemptLeases = await acquireAttemptLeases(leaseSource, candidate, {
        signal: state.abortController.signal,
        ...(deps.poolSelector ? { poolSelector: deps.poolSelector } : {}),
        ...(deps.networkBindingFactory ? { networkBindingFactory: deps.networkBindingFactory } : {}),
        ...(host ? { host } : {}),
        strictPoolSelection: input.strictPoolSelection,
      });
      lease = attemptLeases.lease;
      reservation = attemptLeases.reservation;
      proxySlot = attemptLeases.proxySlot;
      networkPoolId = attemptLeases.networkPoolId;
      // Downstream error paths gate `commitUsage(estimated)` on this flag so
      // the estimate is only charged once the request truly consumed
      // upstream resources; the lease and reservation are held from here on.
      bindingEstablished = true;
      return await input.attempt({
        candidate,
        credential,
        adapter,
        leases: attemptLeases,
        attemptIndex: index,
        providerCapture,
        retainLeases: () => {
          leasesRetained = true;
        },
      });
    } catch (error) {
      const cancelled =
        state.abortController.signal.aborted ||
        (error instanceof GatewayError && error.code === "transport_closed");
      // `acquirePoolSlot` refusing an unpooled candidate beside a pooled
      // sibling is a statement about *this candidate*, not about the request:
      // the sibling it was refused for is the candidate that can serve it.
      // Without this, a plan whose pooled candidate failed first ended on the
      // fallback's refusal — the operator saw `candidate_pool_missing` (a
      // config complaint about a candidate that was never meant to dial) in
      // place of the real fault (`proxy_pool_capacity_exceeded`,
      // `proxy_pool_cooldown`, an upstream 429), and the sibling that could
      // still have answered was never reached when it came second.
      const candidateScopedRefusal = !cancelled && isCandidateScopedPoolRefusal(error);
      // The refusal inherits the prior attempt's failure when there is one: it
      // is the last candidate and it never dialed, so the request's outcome is
      // whatever actually went wrong before it. With no prior failure (a
      // refusal as the first candidate) it *is* the outcome and surfaces
      // unchanged. Either way the guard above never fires for a plan with no
      // pooled sibling, so a tenant that owns no pool keeps its direct dial.
      const inheritsPriorFailure =
        candidateScopedRefusal && lastError !== input.exhaustedError;
      // The row that ends the request reports the failure that decided it, so
      // telemetry and the thrown error agree. Provider attribution stays right:
      // the guard only fires for a sibling of the same `provider_id`. This
      // attempt holds no upstream usage and no pool slot, so nothing is charged
      // twice.
      const surfacedError = inheritsPriorFailure ? lastError : error;
      if (!inheritsPriorFailure) lastError = error;
      // Another exit on the *same* candidate may still have allowance. Bounded
      // per candidate index and only for an egress-keyed 429 or a refused
      // CONNECT (which never reached an upstream), because every other failure
      // either fails identically on the next exit or is not about the egress.
      const egressFailover =
        !cancelled &&
        deps.poolSelector !== undefined &&
        (isNetworkScopedRateLimit(error) || isPoolConnectFailure(error)) &&
        (candidate.network_pool_ids?.length ?? 0) > 1 &&
        (egressFailovers.get(index) ?? 0) < MAX_EGRESS_FAILOVERS;
      const terminalAttempt =
        cancelled ||
        (!isRetryableFailure(error) && !candidateScopedRefusal) ||
        (index === candidates.length - 1 && !egressFailover);
      // Token consumption starts when the provider accepts the request. A
      // rejected request (an HTTP error status, recorded as `providerStatus` by
      // the upstream status mappers) or a transport failure that never
      // delivered it consumed nothing, so the reserved estimate must be
      // refunded by the `finally` release instead of being committed as usage.
      // A 2xx that fails later is not this case: the provider accepted the
      // request and may have billed prompt tokens, so its estimate stays.
      const rejectedBeforeGeneration =
        !(error instanceof GatewayError) ||
        error.origin === "network" ||
        typeof error.details.providerStatus === "number";
      await completeAttempt(state, {
        status: cancelled ? "cancelled" : "failed",
        providerId: candidate.provider_id,
        ...(candidate.provider_account_id ? { accountId: candidate.provider_account_id } : {}),
        ...(candidate.provider_account_label ? { accountLabel: candidate.provider_account_label } : {}),
        errorCategory: classifyTerminalCategory(surfacedError, state.abortController.signal),
        // Same split as the streaming path: a non-GatewayError outcome is ours.
        errorOrigin: surfacedError instanceof GatewayError ? surfacedError.origin : "gateway",
        modelId: candidate.model_id,
        ...(networkPoolId ? { networkPoolId } : {}),
        error: surfacedError,
        ...(lease ? { lease } : {}),
        ...(!cancelled && bindingEstablished && !egressFailover && !rejectedBeforeGeneration
          ? {
              // Repriced against the candidate that actually ran: committing
              // the raw estimate left `estimated_cost` null for every failover.
              commitUsage: repriceUsage(
                estimatedUsage(
                  leaseSource.estimatedInputTokens,
                  leaseSource.estimatedOutputTokens,
                ),
                candidate.provider_id,
                candidate.model_id,
              ),
            }
          : {}),
        terminal: terminalAttempt,
        tenantId: input.tenantId,
        ingressBody: state.ingressBody,
        responseBody: null,
        providerCapture,
        db: deps.db,
        ...(deps.telemetryBuffer ? { telemetryBuffer: deps.telemetryBuffer } : {}),
        ...(deps.snapshotService ? { snapshotService: deps.snapshotService } : {}),
      });
      if (
        networkPoolId &&
        !cancelled &&
        deps.poolSelector &&
        (shouldCooldownPool(error) || isPoolConnectFailure(error))
      ) {
        flagPoolCooldown(deps.poolSelector, deps.db, networkPoolId, candidate.provider_id, error);
      }
      // A 403 can be a deterministic provider policy rejection, not an
      // invalid OAuth credential. Only the evidence-based classifier above
      // may trigger a refresh.
      const candidateKey = `${candidate.provider_id}:${candidate.provider_account_id ?? "global"}:${candidate.model_id}:${candidate.endpoint}`;
      const authInvalidated = isOAuthCredentialInvalidated(error);
      if (
        !cancelled &&
        !refreshedCandidates.has(candidateKey) &&
        authInvalidated &&
        candidate.provider_account_id &&
        deps.oauthRefreshService &&
        deps.resolveOAuthRefresher
      ) {
        const refresher = await deps.resolveOAuthRefresher(candidate.provider_id);
        if (refresher) {
          const fresh = await deps.oauthRefreshService.ensureFreshAccessToken(
            candidate.provider_account_id,
            refresher,
            { force: true },
          );
          if (fresh) {
            refreshedCandidates.add(candidateKey);
            index -= 1;
            continue;
          }
        }
      }
      if (egressFailover) {
        // The cooldown above is already visible to the selector's local map,
        // so the re-acquired slot cannot be the exit that just refused us.
        egressFailovers.set(index, (egressFailovers.get(index) ?? 0) + 1);
        index -= 1;
        continue;
      }
      if (terminalAttempt) {
        metrics.proxy_requests_total.inc(1, { status: cancelled ? "cancelled" : "failed" });
        throw surfacedError;
      }
      // A local refusal never touched an upstream, so there is nothing to back
      // off from: advancing immediately is the point of reaching the sibling.
      if (!candidateScopedRefusal) retryDelayMs = fallbackRetryDelayMs(index);
    } finally {
      if (!leasesRetained)
        await releaseAttemptLeases({ lease, reservation, proxySlot }, leaseSource.routingEngine);
    }
    if (retryDelayMs > 0) await sleep(retryDelayMs, state.abortController.signal);
  }
  metrics.proxy_requests_total.inc(1, { status: "failed" });
  throw lastError;
}
