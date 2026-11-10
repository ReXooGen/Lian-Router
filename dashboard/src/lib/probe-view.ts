/**
 * Presentation decisions for one model's probe result, kept out of the
 * component so the row states can be asserted directly.
 *
 * The distinction this file exists to protect: a catalog probe says the id is
 * *listed upstream*, a dispatched probe says it *generated* or was *refused*.
 * Collapsing those into one "ok" tick is the failure the probe was built to
 * avoid, and it is also the failure that tells an operator nothing about why a
 * refusal happened. A refusal carries the gateway's own classification —
 * `proxy_pool_unhealthy` / `candidate_pool_missing` is a routing fault, not a
 * quota wall — so the row renders the code, the sub-reason, and the origin
 * rather than a generic failure sentence.
 */

/** The subset of `ProbeModelResult` the row renders. */
export interface ProbeRowResult {
  readonly ok: boolean;
  readonly kind?: "generated" | "refused";
  readonly mode?: "dispatch" | "catalog";
  readonly latencyMs: number;
  readonly poolHost?: string;
  readonly sample?: string;
  readonly code?: string;
  readonly reason?: string;
  readonly errorOrigin?: "gateway" | "upstream" | "network";
  readonly error?: string;
  readonly allowanceSpent?: true;
  /**
   * Exits dialed when the probe failed over, absent for a single attempt.
   *
   * The row is the only place the operator can tell "one address refused" from
   * "nine addresses refused", and those call for different actions.
   */
  readonly exitsTried?: number;
}

export type ProbeRowKind = "idle" | "pending" | "listed" | "generated" | "refused";

export interface ProbeRowView {
  readonly kind: ProbeRowKind;
  /** Accent the row renders with. `bad` is a refusal, never a listing. */
  readonly tone: "neutral" | "ok" | "bad";
  /** One line: what happened, plus the exit that answered. */
  readonly headline: string;
  /** The explanation: advice, sample text, or the classified refusal. */
  readonly detail?: string;
  /**
   * Whether the paid action belongs on this row.
   *
   * Only a listing earns it: that is the one state whose detail tells the
   * operator a real dispatch is the remaining question. Offering it beside a
   * refusal would invite a second paid attempt at a route the gateway already
   * refused, and offering it beside a generation would be meaningless.
   */
  readonly canProve: boolean;
  /** The button label. States the cost, because the click spends it. */
  readonly proveLabel: string;
  /** True while any probe on this card is in flight — one at a time. */
  readonly proveDisabled: boolean;
  /** Present only when a unit was actually charged. */
  readonly allowanceNote?: string;
}

/** Probe latency in the card's own units: sub-second as ms, otherwise seconds. */
export function formatProbeLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const PROVE_LABEL = "Prove it generates (spends 1)";

function exitLabel(result: ProbeRowResult): string {
  return result.poolHost ? `via ${result.poolHost}` : "direct";
}

/**
 * The classified refusal, as the operator needs to read it: code, sub-reason,
 * origin, and whether anything left the box. A refusal raised during lease
 * acquisition is free and says so; claiming a cost there would teach the
 * operator to avoid a probe that spends nothing.
 */
function refusalDetail(result: ProbeRowResult): string {
  const parts: string[] = [];
  const origin = result.errorOrigin === undefined ? undefined : `origin: ${result.errorOrigin}`;
  if (origin !== undefined) parts.push(origin);
  if (result.reason !== undefined) parts.push(result.reason);
  // Only when the probe actually rotated: one exit is the unremarkable case and
  // saying "1 exit tried" on every refusal would bury the refusals that rotated.
  if (result.exitsTried !== undefined) parts.push(`${result.exitsTried} exits tried`);
  if (result.allowanceSpent !== true) parts.push("nothing left the box, so no allowance was spent");
  const context = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  const message = result.error ?? "The probe was refused.";
  return `${message}${context}`;
}

export function probeRowView(
  result: ProbeRowResult | null,
  pending: boolean,
): ProbeRowView {
  if (pending) {
    return {
      kind: "pending",
      tone: "neutral",
      headline: "Probing…",
      detail: "One request is in flight for this model.",
      canProve: false,
      proveLabel: PROVE_LABEL,
      proveDisabled: true,
    };
  }
  if (result === null) {
    return {
      kind: "idle",
      tone: "neutral",
      headline: "",
      canProve: false,
      proveLabel: PROVE_LABEL,
      proveDisabled: false,
    };
  }
  const allowanceNote =
    result.allowanceSpent === true ? "1 allowance unit spent" : undefined;
  const withAllowance = allowanceNote === undefined ? {} : { allowanceNote };
  // A catalog answer is a listing, never a generation — even though `ok` is true.
  if (result.mode === "catalog") {
    if (!result.ok) {
      return {
        kind: "refused",
        tone: "bad",
        headline: `not in the published catalog · ${exitLabel(result)}`,
        detail: result.error ?? "The id is not listed upstream.",
        canProve: false,
        proveLabel: PROVE_LABEL,
        proveDisabled: false,
        ...withAllowance,
      };
    }
    return {
      kind: "listed",
      tone: "neutral",
      headline: `listed upstream · ${exitLabel(result)}`,
      detail: "No completion was sent, so no allowance was spent.",
      canProve: true,
      proveLabel: PROVE_LABEL,
      proveDisabled: false,
      ...withAllowance,
    };
  }
  if (result.kind === "generated" || (result.kind === undefined && result.ok)) {
    const sample = result.sample?.trim();
    return {
      kind: "generated",
      tone: "ok",
      headline: `generated in ${formatProbeLatency(result.latencyMs)} · ${exitLabel(result)}`,
      ...(sample ? { detail: sample } : {}),
      canProve: false,
      proveLabel: PROVE_LABEL,
      proveDisabled: false,
      ...withAllowance,
    };
  }
  const code = result.code ?? "unknown_error";
  return {
    kind: "refused",
    tone: "bad",
    headline: `refused · ${code}`,
    detail: refusalDetail(result),
    canProve: false,
    proveLabel: PROVE_LABEL,
    proveDisabled: false,
    ...withAllowance,
  };
}
