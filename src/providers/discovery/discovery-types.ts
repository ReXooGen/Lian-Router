import type { FetchLike } from "../quota/quota-contracts";
import type { ModelDefinition } from "../model-definition";

/**
 * Credential-scoped model-discovery input.
 *
 * Every adapter's `discover*Models` entry point takes the same three fields, so
 * the shape lives here instead of being redeclared per adapter. `fetcher` is the
 * transport seam tests inject; an adapter that always uses the global `fetch`
 * simply ignores it.
 */
export interface DiscoveryInput {
  readonly credential: string;
  readonly signal?: AbortSignal | undefined;
  readonly fetcher?: FetchLike | undefined;
}

/** Inputs supplied by model-discovery orchestration to a provider capability. */
interface ModelDiscoveryContext {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetcher?: typeof fetch;
}

/** Provider-owned model discovery boundary. */
export type ProviderModelDiscovery = (
  context: ModelDiscoveryContext,
) => Promise<readonly ModelDefinition[] | null>;

/**
 * One-shot model connectivity probe contracts, shared by the provider
 * discovery orchestrator and the console catalog route layer. Lived here
 * (not in `console/`) so the lower discovery layer never imports console
 * presentation types.
 */

/**
 * Reasoning efforts a probe accepts, as a runtime tuple.
 *
 * Deliberately narrower than the canonical `REASONING_EFFORTS`: `none` says
 * nothing to probe and `max` is a provider-side ceiling the probe cannot
 * request usefully. Declared here beside `ProbeModelRequest` so the request
 * type and the route's Elysia schema project the same list.
 */
export const PROBE_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** Request accepted for a one-shot model connectivity test. `route`
 * disambiguates when a model id is registered under multiple endpoint
 * paths; omit it to probe against the model's already-registered wire
 * shape, or provide `wireFamily` to test a not-yet-registered candidate. */
export interface ProbeModelRequest {
  modelId: string;
  route?: string;
  wireFamily?: string;
  accountId?: string;
  prompt?: string;
  reasoningEffort?: (typeof PROBE_REASONING_EFFORTS)[number];
  maxOutputTokens?: number;
  stream?: boolean;
}
/**
 * The verdict a probe produced.
 *
 * A probe dispatches. It has no free, non-generating variant: a listing is not
 * evidence about generation, so a state that reported one would only teach the
 * operator to ask twice.
 */
export type ProbeResultKind = "generated" | "refused";

export interface ProbeModelResult {
  accountId?: string;
  /**
   * Whether the probe proved what the operator asked about: that the model
   * generated a completion.
   */
  ok: boolean;
  /**
   * The verdict, as one discriminator every consumer can branch on.
   *
   * - `generated` — a real completion came back with output.
   * - `refused` — the attempt was made and the gateway classified the failure.
   *   `code`, `errorOrigin`, and `reason` say exactly what refused it, and
   *   `allowanceSpent` says whether the attempt reached the provider at all.
   *
   * Absent on the early failures that answer before either question is asked
   * (no usable account, no registered adapter).
   */
  kind?: ProbeResultKind;
  latencyMs: number;
  ttfbMs?: number;
  sample?: string;
  statusCode?: number;
  /**
   * HTTP status this probe outcome stands for: 200 on success, otherwise the
   * failing error's own status (an upstream 429 stays 429). The single-probe
   * route answers with it so the caller is never told "500" for a rate limit.
   */
  httpStatus: number;
  /** Failure category (`GatewayError` code); absent on success. */
  code?: string;
  /** Operator-facing failure text: the provider/wire/status context, or the
   * gateway's own message for a local refusal. */
  error?: string;
  /**
   * Which boundary produced the failure, mirroring the stored telemetry column.
   *
   * `network` is the honest label for a route the gateway refused locally: the
   * request never left the box, so nothing about the provider or its allowance
   * was learned. Reporting such a refusal as `upstream` would send the operator
   * to the provider's logs for a fault this router produced.
   */
  errorOrigin?: "gateway" | "upstream" | "network";
  /**
   * The classified sub-reason inside `code`, when the gateway recorded one
   * (`candidate_pool_missing`, `pool_not_in_candidate_set`, …).
   *
   * Carried because a bare `proxy_pool_unhealthy` does not say whether the
   * candidate carried no pool or every pool was unhealthy, and those are
   * different operator actions.
   */
  reason?: string;
  /**
   * Set to `true` only when this probe charged one unit of the provider's
   * allowance.
   *
   * In the payload rather than only in console copy so a scripted caller sees
   * the cost too. Absent (not `false`) when nothing was charged, which is what
   * keeps a default probe's response identical to the one this gateway served
   * before the opt-in existed — a new always-present field would have changed
   * every caller's payload to say "free" about a probe that already was.
   *
   * A local refusal is free: the request never left the box. A 429 is not —
   * the provider is confirming a unit was already gone, so the attempt counts
   * as having gone upstream.
   */
  allowanceSpent?: true;
  /**
   * Network pool that served the attempt; absent on a direct dial.
   *
   * A probe is the operator's only window into egress rotation, and a
   * free-tier 429 is keyed on the exit address rather than the credential.
   * Without this field a repeated failure is indistinguishable from a
   * gateway that never left through a pool at all. A catalog probe acquires
   * its pool the same way, so the field is populated in both modes.
   */
  networkPoolId?: string;
  /**
   * The pool's `host:port`, never its credentials.
   *
   * Rendered in the console so the operator can watch rotation happen; the
   * credential is deliberately unreachable from here.
   */
  poolHost?: string;
  /**
   * How many proxy exits the probe dialed before it answered or gave up.
   *
   * Absent when the probe dialed once, because "one exit refused" is already
   * what a single-attempt refusal means. Present with two or more, which is the
   * only case where the operator cannot infer it: an egress-keyed 429 moves the
   * probe to another exit, so nine burned addresses and one burned address
   * would otherwise read identically.
   */
  exitsTried?: number;
}

/**
 * Ad-hoc connectivity test for an operator-entered BYOK provider that has not
 * been persisted yet. Carries exactly the fields the create-provider modal
 * collects, so the console route never has to invent defaults the runtime
 * would not use.
 */
export interface ByokConnectionTestRequest {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly wireFamily: string;
  /** Whether to stamp the wire family's official CLI identity headers. */
  readonly cliIdentity?: boolean;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export interface ByokConnectionTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly statusCode?: number;
  /** Number of models the upstream advertised; absent when the body was not a list. */
  readonly modelCount?: number;
  readonly error?: string;
}

/** One entry of a batched provider-wide probe (`probeAllModels`). */
export interface ProbeAllModelsResult {
  providerId: string;
  results: ReadonlyArray<{
    modelId: string;
    ok: boolean;
    latencyMs: number;
    error?: string;
  }>;
}
export interface ProbeAllAccountsResult {
  providerId: string;
  modelId: string;
  results: ReadonlyArray<ProbeModelResult>;
}
