import type { HealthCheckResult } from "./contracts";

/**
 * Classifies probe responses without confusing an HTTP proxy response with a
 * failed tunnel. 402 and 407 prove the proxy answered, but make it unusable.
 *
 * The label says both halves because the distinction matters to the operator:
 * a proxy that is up and refusing is a different fault from a proxy that is
 * down, and the old wording ("Proxy reachable") read as success for a tunnel
 * that carried nothing.
 */
export function classifyPoolProbeResponse(
  poolId: string,
  response: Pick<Response, "ok" | "status">,
  latencyMs: number,
): HealthCheckResult {
  if (response.status === 402 || response.status === 407) {
    const reason =
      response.status === 402 ? "Payment Required" : "Proxy Authentication Required";
    return {
      poolId,
      status: "reachable",
      httpStatus: response.status,
      latencyMs,
      errorMessage: `Proxy answered but refused the tunnel — HTTP ${response.status} ${reason}`,
    };
  }

  return {
    poolId,
    status: "healthy",
    latencyMs,
    ...(response.ok ? {} : { errorMessage: `HTTP ${response.status} (reachable)` }),
  };
}

/** Reads the explicit status from a failed HTTP-proxy CONNECT handshake. */
export function classifyPoolConnectError(
  poolId: string,
  error: unknown,
  latencyMs: number,
): HealthCheckResult | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /^Proxy CONNECT failed: (402|407)\b/.exec(error.message);
  if (!match) return undefined;
  const status = match[1] === "402" ? 402 : 407;
  return classifyPoolProbeResponse(poolId, { ok: false, status }, latencyMs);
}
