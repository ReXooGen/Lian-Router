/**
 * Provider probing and model-discovery orchestration.
 *
 * Network probes and `/v1/models` discovery stay separate from the Drizzle
 * catalog repository while sharing the provider catalog contract.
 */
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { models, providerAccounts, providers } from "../../persistence/schema";
import type { CanonicalEvent, CanonicalRequest, WireFamily } from "../../transport/canonical-model";
import { WIRE_FAMILIES } from "../../transport/canonical-model";
import { isRecord } from "../../protocol/primitives";
import type { FetchLike } from "../quota/quota-contracts";
import type { CompatibilityProfile } from "../provider-metadata";
import {
  type ByokConnectionTestRequest,
  type ByokConnectionTestResult,
  type ProbeAllAccountsResult,
  type ProbeAllModelsResult,
  type ProbeModelRequest,
  type ProbeModelResult,
  type ProbeResultKind,
} from "./discovery-types";
import type { ProbeDispatchFn, ProbeDispatchOutcome } from "./probe-dispatch";
import { modelsDevCatalog } from "./models-dev-catalog";
import { fetchOpenAICompatibleModels } from "./openai-model-discovery";
import {
  applyDiscoveredWire,
  resolveDiscoveredWire,
  staticEndpointForWire,
  type DiscoveredModelWire,
} from "./probe-wire";
import {
  buildProbeCanonicalRequest,
  computeProbeVerdict,
  extractSample,
  hasMeaningfulOutput,
  loadProbePreferences,
  recordProbeHealth,
  resolveProbeAdapter,
  resolveProbeTarget,
  selectProbeAccount,
  wireContextFrom,
  type ProbeProviderRow,
} from "./probe-phases";
import { createDefaultProviderRegistry } from "../default-registry";
import { createProbeFetch } from "../operations/probe-fetch";
import { LIANROUTER_PROBE_MARKER } from "../provider-registry";
import { authHeaders } from "../compatible-adapter";
import {
  byokAuthHeaderShape,
  modelDiscoveryBaseUrl,
  modelListUrl,
  resolveByokWireProfile,
} from "../operations/byok-wire-profile";
import { resolveCustomCliHeaders } from "../operations/custom-cli-headers";
import { resolveCredentialForAccount } from "../operations/provider-credential-service";
import { decryptCredentialToString } from "../../security/crypto";
import { GatewayError } from "../../transport/gateway-error";
import { classifyUpstreamFailure, isEgressScopedProvider } from "../../transport/failure-policy";
import { shouldCooldownPool, isPoolConnectFailure } from "../../transport/dispatch/retry-policy";
import { flagPoolCooldown } from "../../network/pool-health";
import { loadPoolEgressHost } from "../../network/pool/loader";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { ProxyConnectError } from "../../network/pool/agent";
import type { TelemetryBatchBuffer } from "../../observability/telemetry-buffer";
import { computeTokensPerSec } from "../../observability/token-speed";
import { resolveUpstreamTimeoutMs } from "../../config";
import { TelemetryPayloadCapture } from "../../observability/payload-capture";
import {
  providerBaseUrl,
  parseProviderId,
  type ProviderDispatchTarget as AdapterDispatchTarget,
  type ModelDefinition,
  type ValidatedOutboundFetch,
  type ProviderRegistry,
} from "../provider-registry";

/** Max models probed concurrently per batch (outside the sequential warm-up). */
const PROBE_CONCURRENCY = 5;

/**
 * Max accounts probed concurrently per batch.
 *
 * Deliberately separate from `PROBE_CONCURRENCY`: a model probe is a cheap
 * catalog warm-up on one provider, while an account probe is a full upstream
 * turn. A provider can hold thousands of accounts (`cb` has ~2.3k), and an
 * unbounded fan-out opened one socket and one upstream session per account —
 * enough to exhaust the process fd budget (soft limit 1024) and to look like a
 * burst to the provider being probed.
 */
const PROBE_ACCOUNT_CONCURRENCY = 8;

/**
 * Extra exits one probe attempt may burn after a pool CONNECT handshake fails.
 * A refused tunnel is an egress fault: no upstream saw the request, so the
 * account is untouched and a different exit can still answer. Mirrors the
 * dispatch loop's `MAX_EGRESS_FAILOVERS` so probe and live traffic bound the
 * same retry spend.
 */
const MAX_PROBE_EGRESS_FAILOVERS = 2;

export interface ProbeOutboundBinding {
  readonly fetch: ValidatedOutboundFetch;
  readonly networkPoolId?: string;
  readonly release?: () => void;
}

export type ProbeOutboundResolver = (
  tenantId: string,
  providerId?: string,
) => Promise<ValidatedOutboundFetch | ProbeOutboundBinding> | ValidatedOutboundFetch | ProbeOutboundBinding;

interface ProviderProbingDeps {
  readonly db: LianRouterDatabase;
  readonly telemetryBuffer: TelemetryBatchBuffer | undefined;
  readonly defaultEndpoints: Record<WireFamily, string>;
  readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  readonly outboundFetchFor: ProbeOutboundResolver;
  readonly snapshotInvalidator: { invalidate(): unknown };
  readonly providerRegistry: ProviderRegistry;
  /**
  /**
   * The same selector live dispatch flags, so a probe that burns an egress
   * retires it instead of leaving it selectable (429-shaped failures).
   */
  readonly poolSelector?: NetworkPoolSelector | undefined;
  /**
   * Cools one (pool, provider) pair after its CONNECT handshake failed, so the
   * selector stops handing that exit to this provider. Injected rather than
   * imported: the selector and its durable audit row belong to the network
   * layer, and discovery must keep working without a pool selector (tests,
   * direct-only tenants).
   */
  readonly coolPool?: (poolId: string, providerId: string, error: ProxyConnectError) => void;
  /**
   * The one paid path: a real completion dispatched through the shared lease
   * layer (`createProbeDispatcher`). Required rather than optional so a service
   * can never silently fall back to a bespoke fetch — the probe's whole value
   * is that it reproduces what live traffic does, including the refusals that
   * happen before any upstream is contacted.
   */
  readonly dispatchProbe: ProbeDispatchFn;
}

interface ProviderProbingTestDeps {
  readonly db: LianRouterDatabase;
  readonly telemetryBuffer?: TelemetryBatchBuffer;
  readonly defaultEndpoints?: Record<WireFamily, string>;
  readonly bundledModelCatalog?: ReadonlyMap<string, readonly ModelDefinition[]>;
  readonly outboundFetchFor?: ProbeOutboundResolver;
  readonly snapshotInvalidator?: { invalidate(): unknown };
  readonly providerRegistry?: ProviderRegistry;
  readonly poolSelector?: NetworkPoolSelector;
  readonly coolPool?: (poolId: string, providerId: string, error: ProxyConnectError) => void;
  /**
   * The dispatch double. Required: a test that cannot observe the paid path
   * would let the flag silently stop working. The default is a refusal so a
   * suite that does not care about generation never fabricates one.
   */
  readonly dispatchProbe?: ProbeDispatchFn;
}

export function createProviderProbingServiceForTests(deps: ProviderProbingTestDeps): ProviderProbingService {
  return new ProviderProbingService({
    db: deps.db,
    telemetryBuffer: deps.telemetryBuffer,
    defaultEndpoints: deps.defaultEndpoints ?? {
      chat: "/v1/chat/completions",
      responses: "/v1/responses",
      messages: "/v1/messages",
      embeddings: "/v1/embeddings",
      native: "/v1/chat/completions",
    },
    bundledModelCatalog: deps.bundledModelCatalog ?? new Map(),
    outboundFetchFor:
      deps.outboundFetchFor ??
      (() => ({ fetch: (async () => new Response("{}", { status: 500 })) as ValidatedOutboundFetch })),
    snapshotInvalidator: deps.snapshotInvalidator ?? { invalidate: () => 0 },
    providerRegistry: deps.providerRegistry ?? createDefaultProviderRegistry(),
    ...(deps.poolSelector ? { poolSelector: deps.poolSelector } : {}),
    ...(deps.coolPool ? { coolPool: deps.coolPool } : {}),
    // A suite that never wires a dispatcher must not silently observe a
    // fabricated generation: the default reports "nothing was dispatched" so a
    // paid probe under an unwired double fails loudly instead of passing.
    dispatchProbe:
      deps.dispatchProbe ??
      (async () => {
        throw new Error("test probe dispatcher not wired");
      }),
  });
}

/**
 * Adapts a validated outbound fetch to the `FetchLike` shape discovery
 * helpers expect. Only the call signature is consumed downstream.
 */
function asFetchLike(fetchFn: ValidatedOutboundFetch): FetchLike {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetchFn(input, init);
  return Object.assign(wrapped, { preconnect: () => undefined });
}

function asOutboundBinding(
  resolved: ValidatedOutboundFetch | ProbeOutboundBinding,
): ProbeOutboundBinding {
  return typeof resolved === "function" ? { fetch: resolved } : resolved;
}

export class ProviderProbingService {
  private readonly db: LianRouterDatabase;
  private readonly telemetryBuffer: TelemetryBatchBuffer | undefined;
  private readonly payloadCapture: TelemetryPayloadCapture;
  private readonly defaultEndpoints: Record<WireFamily, string>;
  private readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  private readonly outboundFetchFor: ProbeOutboundResolver;
  private readonly snapshotInvalidator: { invalidate(): unknown };
  private readonly providerRegistry: ProviderRegistry;
  private readonly poolSelector: NetworkPoolSelector | undefined;
  private readonly coolPool: ((poolId: string, providerId: string, error: ProxyConnectError) => void) | undefined;
  private readonly dispatchProbe: ProbeDispatchFn;

  constructor(deps: ProviderProbingDeps) {
    this.db = deps.db;
    this.telemetryBuffer = deps.telemetryBuffer;
    this.payloadCapture = new TelemetryPayloadCapture(this.db);
    this.defaultEndpoints = deps.defaultEndpoints;
    this.bundledModelCatalog = deps.bundledModelCatalog;
    this.outboundFetchFor = deps.outboundFetchFor;
    this.snapshotInvalidator = deps.snapshotInvalidator;
    this.providerRegistry = deps.providerRegistry;
    this.poolSelector = deps.poolSelector;
    this.coolPool = deps.coolPool;
    this.dispatchProbe = deps.dispatchProbe;
  }

  /**
   * The provider row columns that decide wire-family/endpoint resolution.
   * `probeModel` loads this once and reuses it for the contract gate, the
   * custom-adapter fallback, and the wire context.
   */
  private async loadProviderWireRow(providerId: string): Promise<ProbeProviderRow | undefined> {
    const rows = await this.db
      .select({
        baseUrl: providers.baseUrl,
        wireFamilyDefault: providers.wireFamilyDefault,
        compatibilityProfile: providers.compatibilityProfile,
        requiresAccount: providers.requiresAccount,
      })
      .from(providers)
      .where(eq(providers.id, providerId))
      .limit(1);
    return rows[0];
  }

  /**
   * Static endpoint for one provider + wire family, if the bundled catalog
   * ships a static definition for it. Used by manual registration (via the
   * console store) so it resolves the same provider-truth endpoints as probes.
   */
  async resolveStaticEndpoint(
    providerId: string,
    wireFamily: WireFamily,
  ): Promise<string | undefined> {
    return staticEndpointForWire(this.bundledModelCatalog, providerId, wireFamily);
  }


  /**
   * The opted-in path: one real completion, and the honest verdict it yields.
   *
   * Everything here exists so the operator's answer is the same one live
   * traffic would get. The request is built by the same `buildProbeCanonicalRequest`
   * the catalog-free path uses (a trivial prompt, a small budget, non-streaming
   * client request — the adapter's own `ensureFreeAgentRequest` forces
   * `stream: true` upstream, which is the wire's requirement, not ours to
   * fight), and it is dispatched through `createProbeDispatcher`, which acquires
   * the same admission lease, pool slot, and routing reservation live traffic
   * does. That is why a local refusal arrives here as
   * `proxy_pool_unhealthy` / `candidate_pool_missing` instead of as a bespoke
   * transport error: the refusal happened in the shared layer, so it is
   * classified by the shared classifier.
   *
   * One candidate, one question. Candidate failover and retry-after-backoff
   * stay out: a second candidate would answer for a route the operator did not
   * ask about. The dispatcher does re-lease the *same* candidate after an
   * egress-keyed 429, because that attempt produced no answer and the next exit
   * has its own untouched allowance — the rationale for one shot covers
   * account-scoped failures, never an exit that was already spent.
   */
  private async probeByGeneration(
    tenantId: string,
    providerId: string,
    modelId: string,
    request: ProbeModelRequest,
    providerWireRow: ProbeProviderRow | undefined,
    requiresAccount: boolean,
    startedAt: number,
  ): Promise<ProbeModelResult> {
    const { wireFamily, endpointPath, sourceSurface } = await resolveProbeTarget({
      db: this.db,
      bundledModelCatalog: this.bundledModelCatalog,
      defaultEndpoints: this.defaultEndpoints,
      providerId,
      modelId,
      request,
      providerWireRow,
    });
    const account = await selectProbeAccount({
      db: this.db,
      tenantId,
      providerId,
      requestedAccountId: request.accountId,
      requiresAccount,
    });
    if (!account.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        httpStatus: 503,
        code: "accounts_unavailable",
        error: account.error,
      };
    }
    const adapter = await resolveProbeAdapter({
      providerRegistry: this.providerRegistry,
      providerId,
      providerWireRow,
    });
    if (!adapter) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        httpStatus: 500,
        code: "internal_error",
        error: `No adapter registered for provider ${providerId}`,
      };
    }
    const { probeReasoning } = await loadProbePreferences({
      db: this.db,
      tenantId,
      wireFamily,
      request,
    });
    const canonicalRequest = buildProbeCanonicalRequest({
      modelId,
      request,
      probeReasoning,
      sourceSurface,
      wireFamily,
    });
    const credential = account.accountId
      ? await resolveCredentialForAccount(this.db, providerId, account.accountId)
      : { provider_id: parseProviderId(providerId), credential_kind: "none" as const };
    const probeBudgetMs = resolveUpstreamTimeoutMs();
    let outcome: ProbeDispatchOutcome;
    try {
      outcome = await this.dispatchProbe({
        providerId,
        modelId,
        tenantId,
        canonicalRequest,
        credential,
        adapter,
        deadlineMs: Date.now() + probeBudgetMs,
        // Each exit attempt gets its own budget, re-armed by the dispatcher;
        // the overall signal below stays the outer bound so a failover cannot
        // outlive the probe. One shared signal for every attempt would abort a
        // retry before it could answer.
        attemptBudgetMs: probeBudgetMs,
        signal: AbortSignal.timeout(probeBudgetMs),
      });
    } catch (error) {
      // A planner or candidate-resolution failure is a gateway-side verdict: the
      // request never reached the lease layer, so nothing was dispatched and no
      // allowance was charged.
      return {
        ok: false,
        kind: "refused",
        latencyMs: Date.now() - startedAt,
        httpStatus: 502,
        code: error instanceof GatewayError ? error.code : "internal_error",
        errorOrigin: error instanceof GatewayError ? error.origin : "gateway",
        error: error instanceof Error ? error.message : "Model probe dispatch failed",
      };
    }
    const { ok, errorMessage, httpStatus, code, origin } = computeProbeVerdict({
      events: outcome.events,
      dispatchError: outcome.error,
      providerId,
      modelId,
      wireFamily,
      endpointPath,
    });
    const poolHost =
      outcome.networkPoolId === undefined
        ? undefined
        : await loadPoolEgressHost(this.db, outcome.networkPoolId).catch(() => undefined);
    const gateway = outcome.error instanceof GatewayError ? outcome.error : undefined;
    // The classified sub-reason, when the gateway recorded one. A bare
    // `proxy_pool_unhealthy` cannot distinguish "the candidate carried no pool"
    // from "every pool was unhealthy", and those are different operator actions.
    const reason =
      typeof gateway?.details.reason === "string" ? gateway.details.reason : undefined;
    const kind: ProbeResultKind = ok ? "generated" : "refused";
    // A probe that burned this egress must retire it exactly as live dispatch
    // does, or the (pool, provider) pair stays marked healthy and keeps being
    // handed out — which is how probe traffic once spent a set of addresses
    // while client traffic never saw a 429. This path takes its leases from
    // `acquireAttemptLeases` but does not run the attempt loop, so the loop's
    // cooldown does not apply to it and the same predicate set is applied here.
    // A bad model id, empty content, deadline, or 400 says nothing about the
    // pool and must not sideline it.
    if (
      this.poolSelector &&
      outcome.networkPoolId &&
      outcome.error !== undefined &&
      (shouldCooldownPool(outcome.error) || isPoolConnectFailure(outcome.error))
    ) {
      flagPoolCooldown(
        this.poolSelector,
        this.db,
        outcome.networkPoolId,
        providerId,
        outcome.error,
      );
    }
    await recordProbeHealth({
      db: this.db,
      invalidator: this.snapshotInvalidator,
      accountId: account.accountId,
      dispatchError: outcome.error,
      modelId,
      upstreamStatusCode:
        gateway !== undefined && typeof gateway.details.upstreamStatus === "number"
          ? gateway.details.upstreamStatus
          : undefined,
    });
    const sample = extractSample(outcome.events);
    // The probe rides the same batch buffer as live traffic so the operator can
    // open the refusal in Console Log and see the request that produced it. A
    // local refusal is recorded as `failed` with origin `network` and its real
    // status — that is the row that explains why nothing left the box.
    this.telemetryBuffer?.enqueue({
      tenantId,
      requestId: crypto.randomUUID(),
      sourceSurface,
      requestedModel: modelId,
      endpoint: endpointPath,
      userAgent: LIANROUTER_PROBE_MARKER,
      providerId,
      ...(account.accountId ? { accountId: account.accountId } : {}),
      ...(outcome.networkPoolId ? { networkPoolId: outcome.networkPoolId } : {}),
      latencyMs: Date.now() - startedAt,
      ...(outcome.ttfbMs !== undefined ? { ttfbMs: outcome.ttfbMs } : {}),
      stream: canonicalRequest.stream,
      httpStatus,
      status: ok ? "completed" : "failed",
      ...(ok ? {} : { errorCategory: code ?? "unknown_error", errorOrigin: origin ?? "gateway" }),
    });
    // Cost accounting is derived, not asserted: reaching the adapter is the only
    // way a unit can be spent, and a refusal raised during lease acquisition is
    // free. A 429 is the provider confirming an earlier unit was already gone,
    // so it still counts as having gone upstream.
    const allowanceSpent = outcome.reachedUpstream;
    const upstreamStatusCode =
      gateway !== undefined && typeof gateway.details.upstreamStatus === "number"
        ? gateway.details.upstreamStatus
        : undefined;
    return {
      ...(account.accountId ? { accountId: account.accountId } : {}),
      ok,
      kind,
      latencyMs: Date.now() - startedAt,
      httpStatus,
      ...(allowanceSpent ? { allowanceSpent: true as const } : {}),
      ...(sample ? { sample } : {}),
      ...(code === undefined ? {} : { code }),
      ...(origin === undefined ? {} : { errorOrigin: origin }),
      ...(reason === undefined ? {} : { reason }),
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(outcome.ttfbMs !== undefined ? { ttfbMs: outcome.ttfbMs } : {}),
      ...(upstreamStatusCode === undefined ? {} : { statusCode: upstreamStatusCode }),
      ...(outcome.networkPoolId === undefined ? {} : { networkPoolId: outcome.networkPoolId }),
      ...(poolHost === undefined ? {} : { poolHost }),
      // Only meaningful once more than one exit was burned: the console row
      // already reads "one exit refused" from a single attempt, and an
      // always-present `1` would change every existing caller's payload to say
      // what it already implied.
      ...(outcome.exitsTried > 1 ? { exitsTried: outcome.exitsTried } : {}),
    };
  }

  /** One-shot connectivity test: resolves a usable account + the real per-provider
   * adapter, dispatches a minimal canonical request through the model's own wire
   * family/endpoint (never a hardcoded `/v1/chat/completions`), and records the
   * outcome into `telemetry_events` via the same writer live traffic uses. */
  async probeModel(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeModelResult> {
    const startedAt = Date.now();
    const modelId = request.modelId;
    // One provider snapshot per probe: the contract gate, the account gate, the
    // custom-adapter fallback, and the wire context all read this same row, so a
    // concurrent edit cannot make two reads disagree.
    const providerWireRow = await this.loadProviderWireRow(providerId);
    const requiresAccount = providerWireRow?.requiresAccount ?? true;

    // A probe answers one question — does this model generate — and only a real
    // completion answers it. A catalog lookup was offered here as a free
    // substitute for an egress-scoped provider, but a listing is not evidence
    // about generation: it produced an intermediate state the console had to
    // explain, and the operator had to click a second button to get the answer
    // they asked for. The probe now always dispatches.
    //
    // Egress-scoped providers get the leaner single-candidate dispatch: their
    // allowance is keyed on the source address, so one attempt is one honest
    // answer. Credential-keyed providers keep the account failover path below,
    // which is the behaviour their probes have always had.
    if (isEgressScopedProvider(providerId)) {
      return await this.probeByGeneration(
        tenantId,
        providerId,
        modelId,
        request,
        providerWireRow,
        requiresAccount,
        startedAt,
      );
    }

    const { wireFamily, endpointPath, sourceSurface } = await resolveProbeTarget({
      db: this.db,
      bundledModelCatalog: this.bundledModelCatalog,
      defaultEndpoints: this.defaultEndpoints,
      providerId,
      modelId,
      request,
      providerWireRow,
    });

    const account = await selectProbeAccount({
      db: this.db,
      tenantId,
      providerId,
      requestedAccountId: request.accountId,
      requiresAccount,
    });
    if (!account.ok) {
      // No usable credential is the catalog's `accounts_unavailable` (503), not
      // a gateway fault: nothing was dispatched and the caller can fix it by
      // adding or recovering an account.
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        httpStatus: 503,
        code: "accounts_unavailable",
        error: account.error,
      };
    }

    const adapter = await resolveProbeAdapter({
      providerRegistry: this.providerRegistry,
      providerId,
      providerWireRow,
    });
    if (!adapter) {
      // A provider with no registered adapter is our own wiring gap, so this
      // stays a 500 — the one class of probe failure that should.
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        httpStatus: 500,
        code: "internal_error",
        error: `No adapter registered for provider ${providerId}`,
      };
    }

    const { probeReasoning, payloadCaptureEnabled } = await loadProbePreferences({
      db: this.db,
      tenantId,
      wireFamily,
      request,
    });
    const canonicalRequest = buildProbeCanonicalRequest({
      modelId,
      request,
      probeReasoning,
      sourceSurface,
      wireFamily,
    });
    let capturedRequest = canonicalRequest;
    const parsedProviderId = parseProviderId(providerId);
    const candidate: AdapterDispatchTarget = {
      provider_id: parsedProviderId,
      model_id: modelId,
      wire_family: wireFamily,
      endpoint_path: endpointPath,
      capabilities: {},
    };

    const events: CanonicalEvent[] = [];
    let ttfbMs: number | undefined;
    let dispatchError: unknown;
    let networkPoolId: string | undefined;
    let accountId = account.accountId;

    // A probe against a pooled provider must fail over like live traffic. A
    // single restricted account (CodeBuddy 403 `11140` "account has been
    // restricted") otherwise reports a provider-wide fault while the rest of
    // the pool is healthy, and every repeated probe re-selects the same row.
    const attemptAccounts = account.accountIds.length > 0 ? account.accountIds : [undefined];
    for (const attemptAccountId of attemptAccounts) {
      accountId = attemptAccountId;
      dispatchError = undefined;
      // A probe must answer the same question live traffic asks: "does this
      // model return a response inside the upstream contract?" A reasoning
      // model can spend longer than any small fixed budget before its first
      // token, and a budget tighter than `LIANROUTER_UPSTREAM_TIMEOUT_MS`
      // reports a healthy model as `transport_closed` — the operator sees
      // "request was cancelled" for a provider that is merely thinking. The
      // pre-stream phase is bounded by the same value dispatch uses.
      const probeBudgetMs = resolveUpstreamTimeoutMs();
      let attemptPoolId: string | undefined;
      // A refused CONNECT says nothing about the account: the tunnel never
      // opened, so no upstream saw the request. Retry the same account on a
      // fresh exit, bounded like the dispatch loop, and cool the failed pair
      // so the selector stops handing it to this provider. Burning one
      // account attempt per bad exit misreports a proxy fault as an account
      // fault and exhausts the probe's account budget before reaching a
      // working exit.
      for (let egressTry = 0; ; egressTry += 1) {
        events.length = 0;
        ttfbMs = undefined;
        dispatchError = undefined;
        capturedRequest = canonicalRequest;
        // Each attempt gets its own signal: the streamed retry below used to
        // inherit a signal and deadline already consumed by the first attempt,
        // so a slow-but-working model failed the retry before it could answer.
        let probeSignal = AbortSignal.timeout(probeBudgetMs);
        attemptPoolId = undefined;
        try {
          // Public providers (`requires_account: false`) probe credential-free;
          // anything else resolves the health-filtered account selected above.
          const credential = attemptAccountId
            ? await resolveCredentialForAccount(this.db, providerId, attemptAccountId)
            : { provider_id: parsedProviderId, credential_kind: "none" as const };
          const outbound = asOutboundBinding(await this.outboundFetchFor(tenantId, providerId));
          attemptPoolId = outbound.networkPoolId;
          const probeFetch = createProbeFetch(outbound.fetch);
          const dispatchProbe = async (request: CanonicalRequest): Promise<void> => {
            capturedRequest = request;
            for await (const event of adapter.dispatch(request, candidate, {
              credential,
              deadline: Date.now() + probeBudgetMs,
              abort_signal: probeSignal,
              outbound_fetch: probeFetch,
              probe_marker: LIANROUTER_PROBE_MARKER,
              ...(attemptPoolId ? { network_pool_id: attemptPoolId } : {}),
            })) {
              if (ttfbMs === undefined) ttfbMs = Date.now() - startedAt;
              events.push(event);
            }
          };
          try {
            await dispatchProbe(canonicalRequest);
            if (!hasMeaningfulOutput(events)) throw new Error("probe response content empty");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/empty\s+(?:response\s+)?content|response\s+content\s+empty/i.test(message)) {
              throw error;
            }
            // Some reasoning models spend the short non-stream probe budget before
            // producing visible text. Retry generically as a streamed probe with a
            // larger output allowance; no provider/model id special case is needed.
            events.length = 0;
            ttfbMs = undefined;
            probeSignal = AbortSignal.timeout(probeBudgetMs);
            await dispatchProbe({
              ...canonicalRequest,
              stream: true,
              generation_controls: {
                ...canonicalRequest.generation_controls,
                max_tokens: 1024,
                max_output_tokens: 1024,
              },
            });
          } finally {
            outbound.release?.();
          }
        } catch (error) {
          dispatchError = error;
        }
        networkPoolId = attemptPoolId;

        if (!isPoolConnectFailure(dispatchError) || attemptPoolId === undefined) break;
        this.coolPool?.(attemptPoolId, providerId, dispatchError);
        if (egressTry >= MAX_PROBE_EGRESS_FAILOVERS) break;
      }

      // A probe that burned this egress must retire it exactly as live dispatch
      // does, or the (pool, provider) pair stays marked healthy and keeps being
      // handed out — which is how probe traffic spent a set of addresses while
      // client traffic never saw a 429. Same predicate set as the attempt loop:
      // an egress-scoped or provider-capacity 429, or a failed CONNECT tunnel.
      // A bad model id, empty content, deadline, or 400 says nothing about the
      // pool and must not sideline it.
      if (
        this.poolSelector &&
        attemptPoolId &&
        dispatchError !== undefined &&
        (shouldCooldownPool(dispatchError) || isPoolConnectFailure(dispatchError))
      ) {
        flagPoolCooldown(
          this.poolSelector,
          this.db,
          attemptPoolId,
          providerId,
          dispatchError,
        );
      }

      const attemptStatus =
        dispatchError instanceof GatewayError && typeof dispatchError.details.upstreamStatus === "number"
          ? dispatchError.details.upstreamStatus
          : undefined;
      await recordProbeHealth({
        db: this.db,
        invalidator: this.snapshotInvalidator,
        accountId: attemptAccountId,
        dispatchError,
        modelId,
        upstreamStatusCode: attemptStatus,
      });
      if (dispatchError === undefined) break;
      // Another account can only change an account-scoped outcome. A rejected
      // request shape (400) is identical for every credential in the pool, so
      // the probe reports it instead of burning the remaining attempts.
      if (!classifyUpstreamFailure(dispatchError).retryable) break;
    }

    const upstreamStatusCode =
      dispatchError instanceof GatewayError && typeof dispatchError.details.upstreamStatus === "number"
        ? dispatchError.details.upstreamStatus
        : undefined;

    const latencyMs = Date.now() - startedAt;
    const { ok, errorMessage, usage, httpStatus, code, origin } = computeProbeVerdict({
      events,
      dispatchError,
      providerId,
      modelId,
      wireFamily,
      endpointPath,
    });

    const requestId = crypto.randomUUID();

    // Token speed shared with live traffic (`computeTokensPerSec`): probes
    // record TTFT+latency only, so they report end-to-end effective speed.
    const tokensPerSec = computeTokensPerSec({
      outputTokens: usage?.output_tokens,
      latencyMs,
    });

    // Probe telemetry rides the same batch buffer as live traffic. Keep the
    // probe bodies linked by request_id so the console can inspect the exact
    // canonical request and provider event stream that produced the result.
    this.telemetryBuffer?.enqueue({
      tenantId,
      requestId,
      sourceSurface,
      requestedModel: modelId,
      endpoint: endpointPath,
      userAgent: LIANROUTER_PROBE_MARKER,
      providerId,
      ...(accountId ? { accountId } : {}),
      ...(networkPoolId ? { networkPoolId } : {}),
      latencyMs,
      ...(ttfbMs !== undefined ? { ttfbMs } : {}),
      stream: capturedRequest.stream,
      // The probe's outcome IS the response: a 429 from upstream stays a 429 in
      // the console instead of the `failed`→500 default. Without this column a
      // rate limit read as "the gateway broke" and invited blind retries.
      httpStatus,
      status: ok ? "completed" : "failed",
      ...(ok ? {} : { errorCategory: code ?? "unknown_error", errorOrigin: origin ?? "gateway" }),
      ...(usage ? { usage } : {}),
      ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
    });
    if (this.telemetryBuffer && payloadCaptureEnabled) {
      await this.payloadCapture
        .capture({
          tenantId,
          requestId,
          requestBody: capturedRequest,
          responseBody: events,
          scope: "tenant",
          tenantOptIn: true,
        })
        .catch(() => undefined);
    }

    const sample = extractSample(events);
    // The exit is part of the answer: a free-tier 429 is keyed on the egress
    // address, so an operator comparing two probes needs to see whether the
    // pool actually rotated. A failed lookup must not discard a verdict that
    // was already measured — the attempt still happened, only its label is
    // missing.
    const poolHost =
      networkPoolId === undefined
        ? undefined
        : await loadPoolEgressHost(this.db, networkPoolId).catch(() => undefined);
    return {
      ...(accountId ? { accountId } : {}),
      ok,
      // Reaching here means a completion was dispatched, so `ok` is the
      // generation verdict. No `kind` on this path: its payload is what
      // credential-keyed providers have always returned, and this route's
      // callers read `ok` directly.
      latencyMs,
      httpStatus,
      ...(code === undefined ? {} : { code }),
      ...(ttfbMs !== undefined ? { ttfbMs } : {}),
      ...(upstreamStatusCode === undefined ? {} : { statusCode: upstreamStatusCode }),
      ...(sample ? { sample } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(networkPoolId === undefined ? {} : { networkPoolId }),
      ...(poolHost === undefined ? {} : { poolHost }),
    };
  }

  /**
   * Ad-hoc connectivity test for a not-yet-persisted BYOK provider.
   *
   * Dispatches a real `GET <base>/models` through the same SSRF-validated
   * outbound fetch live traffic uses, stamping the credential with the auth
   * header the chosen wire family actually reads (`x-api-key` for Messages,
   * `Authorization: Bearer` otherwise) plus that wire's CLI identity headers.
   * Reachability is the contract: any HTTP response proves the operator's base
   * URL, credential, and egress path work — a 4xx is reported with its status
   * rather than disguised as a transport failure.
   */
  async testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult> {
    const startedAt = Date.now();
    const requestedWire = request.wireFamily;
    const wireFamily: WireFamily = (WIRE_FAMILIES as readonly string[]).includes(requestedWire)
      ? (requestedWire as WireFamily)
      : "chat";
    const url = modelListUrl(request.baseUrl);
    const outbound = asOutboundBinding(await this.outboundFetchFor(tenantId));
    const probeFetch = createProbeFetch(outbound.fetch);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...authHeaders(
          byokAuthHeaderShape([wireFamily]),
          new TextEncoder().encode(request.apiKey),
          request.apiKey.trim().length > 0 ? "api_key" : "none",
        ),
        ...(request.cliIdentity === false ? {} : resolveCustomCliHeaders(wireFamily)),
        ...(request.extraHeaders ?? {}),
      };
      const response = await probeFetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        return {
          ok: false,
          latencyMs,
          statusCode: response.status,
          error: `Upstream rejected the connection test with HTTP ${response.status}`,
        };
      }
      // A body is nice to have but not required: some gateways answer `/models`
      // with an empty envelope. Read it defensively so a non-JSON body cannot
      // turn a successful reachability check into a failure.
      let modelCount: number | undefined;
      try {
        const payload = (await response.json()) as unknown;
        const entries = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload["data"])
            ? payload["data"]
            : isRecord(payload) && Array.isArray(payload["models"])
              ? payload["models"]
              : undefined;
        if (entries) modelCount = entries.length;
      } catch {
        // Non-JSON success body: reachability already proven by the 2xx.
      }
      return {
        ok: true,
        latencyMs,
        statusCode: response.status,
        ...(modelCount === undefined ? {} : { modelCount }),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Connection test failed",
      };
    } finally {
      outbound.release?.();
    }
  }

  async syncModels(tenantId: string, providerId: string): Promise<{ synced: number }> {
    const outbound = asOutboundBinding(await this.outboundFetchFor(tenantId, providerId));
    try {
      const discoveryFetch = asFetchLike(outbound.fetch);
      const resolver = await this.providerRegistry.resolveModelDiscovery(providerId);
      if (resolver) {
        const requiresCredential = this.providerRegistry.modelDiscoveryRequiresCredential(providerId);
        const secret = requiresCredential
          ? await this.usableAccountSecret(tenantId, providerId)
          : "";
        if (requiresCredential && secret === undefined) {
          throw new GatewayError(
            "invalid_request",
            409,
            `Model sync needs a usable (active, non-cooldown) ${providerId} account first`,
          );
        }
        const providerRow = await this.loadProviderWireRow(providerId);
        const effectiveBaseUrl = providerRow?.baseUrl ?? providerBaseUrl(providerId) ?? "";
        let discovered: readonly ModelDefinition[] | null;
        try {
          discovered = await resolver({
            baseUrl: effectiveBaseUrl,
            credential: secret ?? "",
            ...(discoveryFetch ? { fetcher: discoveryFetch } : {}),
          });
        } catch (error) {
          throw new GatewayError(
            "transport_unavailable",
            502,
            `Model discovery failed for ${providerId}: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
        if (!discovered) {
          throw new GatewayError(
            "transport_unavailable",
            502,
            `Model discovery failed for ${providerId}: endpoint returned no usable models`,
          );
        }
        const ctx = wireContextFrom(providerRow);
        return this.persistDiscoveredModels(
          providerId,
          discovered,
          (modelId) => resolveDiscoveredWire(modelId, ctx, undefined, this.defaultEndpoints),
          ctx.endpointPathsByWireFamily,
          effectiveBaseUrl,
        );
      }

      const providerRow = await this.loadProviderWireRow(providerId);
      if (providerRow?.baseUrl) {
        const secret = await this.usableAccountSecret(tenantId, providerId);
        if (secret) {
          // An Anthropic-compatible root reads `x-api-key`, not bearer auth,
          // and a bare host needs its `/v1` segment before `/models` joins on.
          // Both are derived from the same wire profile dispatch uses, so
          // auto-fetch behaves identically for either flavor of custom provider.
          const wireProfile = resolveByokWireProfile(
            providerRow.wireFamilyDefault,
            providerRow.compatibilityProfile as CompatibilityProfile | null,
          );
          const modelsBaseUrl = modelDiscoveryBaseUrl(providerRow.baseUrl);
          let discovered: readonly ModelDefinition[] | null;
          try {
            discovered = await fetchOpenAICompatibleModels({
              baseUrl: modelsBaseUrl,
              providerId,
              headers: {
                ...authHeaders(
                  wireProfile.authHeaderShape,
                  new TextEncoder().encode(secret),
                  "api_key",
                ),
              },
              ...(discoveryFetch ? { fetcher: discoveryFetch as typeof fetch } : {}),
            });
          } catch (error) {
            throw new GatewayError(
              "transport_unavailable",
              502,
              `Model discovery failed for ${providerId}: ${error instanceof Error ? error.message : "unknown error"}`,
            );
          }
          if (discovered && discovered.length > 0) {
            const ctx = wireContextFrom(providerRow);
            return this.persistDiscoveredModels(
              providerId,
              discovered,
              (modelId) => resolveDiscoveredWire(modelId, ctx, undefined, this.defaultEndpoints),
              ctx.endpointPathsByWireFamily,
              providerRow.baseUrl ?? undefined,
              // The generic `/models` fetch guesses a wire from the model id;
              // the row's own profile is what the adapter will enforce, so it
              // decides which guess is admissible.
              wireProfile.supportedWireFamilies,
            );
          }
        }
      }

      return { synced: 0 };
    } finally {
      outbound.release?.();
    }
  }

  private async persistDiscoveredModels(
    providerId: string,
    discoveredModels: readonly (string | ModelDefinition)[],
    resolve: (modelId: string) => DiscoveredModelWire,
    endpointOverrides?: Partial<Record<WireFamily, string>>,
    baseUrl?: string,
    supportedWireFamilies?: readonly WireFamily[],
  ): Promise<{ synced: number }> {
    // Static definitions are the injected bundled catalog; the probing service
    // and the console store are both handed the same startup-built map.
    const staticDefinitions: readonly ModelDefinition[] =
      this.bundledModelCatalog.get(providerId) ?? [];
    const staticEndpoints: Partial<Record<WireFamily, string>> = {};
    for (const definition of staticDefinitions) {
      staticEndpoints[definition.wireFamily] ??= definition.endpointPath;
    }
    // Fetch only adds genuinely new models: an id the builtin catalog
    // already owns stays exactly one (builtin) row instead of gaining a
    // discovered shadow that confuses pickers and deletes.
    const builtinIds = new Set(staticDefinitions.map((definition) => definition.modelId));
    // `(modelId, endpointPath)` is the row identity, so a corrected wire family
    // lands on a *new* row and would leave the old one behind as a dead route.
    // Collect this run's pairs and drop the provider's superseded discovered
    // rows for the same ids afterwards.
    const resolvedPairs: Array<{ modelId: string; endpointPath: string }> = [];
    const rows: Array<typeof models.$inferInsert> = [];
    // `(modelId, endpointPath)` is the row identity and the upsert's conflict
    // target, so a listing that repeats a pair (the bespoke discoveries return
    // raw upstream ids) would make a multi-row `ON CONFLICT DO UPDATE` fail with
    // "cannot affect row a second time". Keep the first row per pair, as the
    // builtin seeder does, so one statement can carry a whole chunk.
    const seenPairs = new Set<string>();
    for (const item of discoveredModels) {
      const modelId = typeof item === "string" ? item : item.modelId;
      if (builtinIds.has(modelId)) continue;
      const resolved = resolve(modelId);
      const discDef = typeof item === "string" ? undefined : item;
      const { wireFamily, endpointPath } = applyDiscoveredWire({
        resolvedWireFamily: resolved.wireFamily,
        resolvedEndpointPath: resolved.endpointPath,
        ...(discDef !== undefined
          ? { discoveredWireFamily: discDef.wireFamily, discoveredEndpointPath: discDef.endpointPath }
          : {}),
        staticEndpoints,
        ...(endpointOverrides !== undefined ? { endpointOverrides } : {}),
        ...(supportedWireFamilies !== undefined ? { supportedWireFamilies } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      resolvedPairs.push({ modelId, endpointPath });
      const pairKey = `${modelId}\u0000${endpointPath}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const knownDefinition = staticDefinitions.find((definition) => definition.modelId === modelId);
      const sourceUpdatedAt = new Date();
      const metadata = {
        contextLimit: knownDefinition?.contextLimit ?? discDef?.contextLimit ?? null,
        outputLimit: knownDefinition?.outputLimit ?? discDef?.outputLimit ?? null,
        modalities: knownDefinition?.modalities ?? discDef?.modalities ?? null,
        reasoning: knownDefinition?.reasoning ?? discDef?.reasoning ?? false,
        toolCall: knownDefinition?.toolCall ?? discDef?.toolCall ?? false,
        webSearch: knownDefinition?.webSearch ?? discDef?.webSearch ?? false,
        cost: modelsDevCatalog.costFor(providerId, modelId),
      };
      rows.push({
        providerId,
        modelId,
        wireFamily,
        endpointPath,
        ...metadata,
        source: "discovered",
        sourceUpdatedAt,
        enabled: true,
      });
    }
    // One statement per chunk (500, the account-health batch step) instead of
    // one round-trip per row. `excluded.*` reads the proposed row, so the update
    // set is the same columns the per-row upsert wrote.
    for (let offset = 0; offset < rows.length; offset += 500) {
      await this.db
        .insert(models)
        .values(rows.slice(offset, offset + 500))
        .onConflictDoUpdate({
          target: [models.providerId, models.modelId, models.endpointPath],
          set: {
            contextLimit: sql`excluded.context_limit`,
            outputLimit: sql`excluded.output_limit`,
            modalities: sql`excluded.modalities`,
            reasoning: sql`excluded.reasoning`,
            toolCall: sql`excluded.tool_call`,
            webSearch: sql`excluded.web_search`,
            cost: sql`excluded.cost`,
            source: sql`'discovered'`,
            sourceUpdatedAt: sql`excluded.source_updated_at`,
          },
        });
    }
    const synced = rows.length;
    // Drop this provider's discovered rows for the synced ids that are no
    // longer part of the resolved set — the stale `(model, endpoint)` pair left
    // behind when a corrected wire family moved a model to a new path. Rows the
    // operator added by hand (`manual`) and ids outside this run are untouched.
    if (resolvedPairs.length > 0) {
      const pairs = resolvedPairs.map(
        (pair) => sql`(${pair.modelId}, ${pair.endpointPath})`,
      );
      const ids = resolvedPairs.map((pair) => pair.modelId);
      await this.db
        .delete(models)
        .where(
          and(
            eq(models.providerId, providerId),
            eq(models.source, "discovered"),
            sql`${models.modelId} IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            sql`(${models.modelId}, ${models.endpointPath}) NOT IN (${sql.join(pairs, sql`, `)})`,
          ),
        );
    }
    return { synced };
  }

  private async usableAccountSecret(
    tenantId: string,
    providerId: string,
  ): Promise<string | undefined> {
    const rows = await this.db
      .select()
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, tenantId)),
        ),
      );
    const now = Date.now();
    const usable = rows
      .filter(
        (row) =>
          row.status !== "disabled" &&
          (row.cooldownUntil === null || row.cooldownUntil.getTime() <= now),
      )
      .sort((left, right) => Number(right.tenantId !== null) - Number(left.tenantId !== null))[0];
    if (!usable?.credentialCiphertext) return undefined;
    return decryptCredentialToString(usable.credentialCiphertext);
  }

  /**
   * Batched provider-wide probe: `modelIds[0]` runs sequentially (it warms
   * OAuth token caches and connection pools for the provider), the rest run
   * with `Promise.allSettled` bounded to `PROBE_CONCURRENCY`. Any per-model
   * failure is captured in its own result entry; the batch never rejects.
   */
  async probeAllModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
  ): Promise<ProbeAllModelsResult> {
    const results: Array<ProbeAllModelsResult["results"][number]> = [];
    const [firstModelId, ...restModelIds] = modelIds;
    if (firstModelId === undefined) return { providerId, results };

    // Every model is dialed for real, including on an egress-scoped provider.
    // The old shortcut read the published catalog once and reported a listing
    // for the whole batch, which answered a different question than the button
    // asks and left the console rendering a state that was not "generated" or
    // "refused". One model, one completion, one verdict.
    const runOne = async (modelId: string): Promise<void> => {
      const outcome = await this.probeModel(tenantId, providerId, { modelId });
      results.push({
        modelId,
        ok: outcome.ok,
        latencyMs: outcome.latencyMs,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    };

    await runOne(firstModelId);
    for (let offset = 0; offset < restModelIds.length; offset += PROBE_CONCURRENCY) {
      const batch = restModelIds.slice(offset, offset + PROBE_CONCURRENCY);
      await Promise.allSettled(batch.map((modelId) => runOne(modelId)));
    }
    return { providerId, results };
  }
  /**
   * Probes every probeable account of a provider in bounded batches.
   *
   * `disabled` accounts are skipped: a probe cannot say anything useful about
   * an account an operator (or the health machine) already turned off, and
   * they add real upstream traffic for a verdict nobody acts on. `cooldown`
   * accounts stay in the set — probing is how an operator finds out whether
   * the cooldown is still deserved.
   *
   * Batches run sequentially and each batch settles before the next starts, so
   * at most `PROBE_ACCOUNT_CONCURRENCY` upstream turns exist at once. Results
   * keep one entry per probed account, in the order the accounts were read.
   */
  async probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeAllAccountsResult> {
    const accounts = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, tenantId)),
          ne(providerAccounts.status, "disabled"),
        ),
      );
    const results: ProbeModelResult[] = [];
    for (let offset = 0; offset < accounts.length; offset += PROBE_ACCOUNT_CONCURRENCY) {
      const batch = accounts.slice(offset, offset + PROBE_ACCOUNT_CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (account) => {
          const result = await this.probeModel(tenantId, providerId, {
            ...request,
            accountId: account.id,
          });
          // No health write here: this used to regex the model's own answer text
          // for "202" and degrade the account on a match. A probe that genuinely
          // fails already reports through `recordAccountFailure`, which classifies
          // the real status; matching answer text is not a health signal.
          return { ...result, accountId: account.id };
        }),
      );
      results.push(...settled);
    }
    return { providerId, modelId: request.modelId, results };
  }
}
