import type { LianRouterDatabase } from "../persistence/postgres";
import { healthEvents } from "../persistence/schema";
import type { NetworkPoolSelector } from "./pool/selector";
import { ProxyConnectError } from "./pool/agent";
import type { GatewayError } from "../transport/gateway-error";
import { metrics } from "../observability/metrics";
import { log } from "../observability/logger";

/**
 * Durable pool rate-limit history.
 *
 * Per-(pool, provider) 429 cooldowns live in `NetworkPoolSelector` (fast,
 * volatile, consulted on every dispatch). This recorder mirrors each flag
 * into the append-only `health_events` table (`entity_kind: "pool"`) — the
 * same merged log the account recorder writes to for accounts — so
 * operators can audit which pool throttled which provider and when. It
 * never touches `network_pools.status`: a single provider's 429 must not
 * flip the whole pool to `cooldown` (that would head-of-line-block every
 * other provider on the pool).
 */

/**
 * Coalescing window for repeated per-(pool, provider) 429 events. Dispatch
 * flags the same pair on every throttled request, but the durable audit log
 * needs one row per cooldown episode — not one per throttled request.
 */
const POOL_COOLDOWN_EVENT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_PAIRS = 5_000;

const lastRecordedByPoolProvider = new Map<string, number>();

/** Durable half of `flagPoolCooldown`; not a second public entry point. */
async function recordPoolCooldownEvent(
  db: LianRouterDatabase,
  poolId: string,
  providerId: string,
  reason: string,
  errorCategory: string,
): Promise<void> {
  const key = `${poolId}::${providerId.toLowerCase()}`;
  const now = Date.now();
  const last = lastRecordedByPoolProvider.get(key);
  if (last !== undefined && now - last < POOL_COOLDOWN_EVENT_WINDOW_MS) return;
  try {
    await db.insert(healthEvents).values({
      entityKind: "pool",
      networkPoolId: poolId,
      fromStatus: null,
      toStatus: "cooldown",
      reason: `provider ${providerId}: ${reason}`,
      errorCategory,
    });
  } catch {
    // Non-fatal: observability writes must never fail dispatch. The
    // coalescing stamp is only written below, so a failed insert does not
    // suppress the next attempt for the whole window.
    return;
  }
  lastRecordedByPoolProvider.set(key, now);
  if (lastRecordedByPoolProvider.size > MAX_TRACKED_PAIRS) {
    for (const [trackedKey, recordedAt] of lastRecordedByPoolProvider) {
      if (now - recordedAt >= POOL_COOLDOWN_EVENT_WINDOW_MS) {
        lastRecordedByPoolProvider.delete(trackedKey);
      }
    }
  }
}

/** Cooldown applied when an upstream 429 carries no `retryAfterMs`. */
const DEFAULT_PROVIDER_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Cooldown applied when a pool's egress cannot establish the CONNECT tunnel
 * to one provider's host. Short by design: the fault is at the proxy (DNS or
 * target filtering) and may clear on its own, but without any flag the
 * selector keeps handing the same broken (pool, provider) pair to every
 * request until an operator notices.
 */
const POOL_CONNECT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Records a provider-scoped 429 cooldown: the volatile per-(pool, provider)
 * flag consulted on every dispatch, plus its durable audit row.
 *
 * Both paths that reach this decision — the non-streaming attempt loop and
 * the streaming failure path — call this one function, because each write
 * reports its own failure through the same metric and warn log. Two copies
 * would have to be edited together, and a divergence would surface only as
 * telemetry that silently differs by response mode.
 *
 * Callers gate on `shouldCooldownPool`, which narrows the error to the
 * upstream/provider-scoped 429 this function is written for.
 */
export function flagPoolCooldown(
  poolSelector: NetworkPoolSelector,
  db: LianRouterDatabase,
  poolId: string,
  providerId: string,
  error: GatewayError | ProxyConnectError,
): void {
  const connect = error instanceof ProxyConnectError;
  const reason = connect
    ? `Provider ${providerId}: proxy CONNECT failed with HTTP ${error.proxyStatus}`
    : `Provider ${providerId} rate limit`;
  const retryAfterMs = connect
    ? POOL_CONNECT_FAILURE_COOLDOWN_MS
    : typeof error.details.retryAfterMs === "number"
      ? error.details.retryAfterMs
      : DEFAULT_PROVIDER_COOLDOWN_MS;
  void poolSelector
    .flagProviderCooldown(poolId, providerId, retryAfterMs, reason)
    .catch((cause: unknown) => {
      metrics.pool_cooldown_record_failed.inc(1);
      log.warn("pool cooldown flag failed", {
        networkPoolId: poolId,
        providerId,
        error: String(cause),
      });
    });
  void recordPoolCooldownEvent(db, poolId, providerId, reason, connect ? "proxy_connect_failed" : "rate_limit_transient").catch((cause: unknown) => {
    metrics.pool_cooldown_record_failed.inc(1);
    log.warn("pool cooldown event failed", {
      networkPoolId: poolId,
      providerId,
      error: String(cause),
    });
  });
}
