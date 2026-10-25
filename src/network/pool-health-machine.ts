import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { LianRouterDatabase } from "../persistence/postgres";
import { healthEvents, networkPools } from "../persistence/schema";
import { resolvePoolCooldownMs } from "../config";
import { ProxyConnectError } from "./pool/agent";

export interface PoolHealthEvent {
  readonly id: string;
  readonly networkPoolId: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reason: string | null;
  readonly errorCategory: string | null;
  readonly createdAt: string;
}

export interface PoolHealthSnapshot {
  readonly poolId: string;
  readonly tenantId: string;
  readonly status: "active" | "degraded" | "cooldown" | "disabled";
  readonly consecutiveFailures: number;
  readonly lastError?: string;
  readonly lastErrorCategory?: string;
  readonly lastErrorAt?: string;
  readonly cooldownUntil?: string;
  readonly lastSuccessAt?: string;
}

const POOL_COOLDOWN_MS = resolvePoolCooldownMs;
const subscribers = new Set<(snapshot: PoolHealthSnapshot) => void>();

/** Subscribe to pool health transitions for console SSE delivery. */
export function subscribePoolHealth(listener: (snapshot: PoolHealthSnapshot) => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function publishPoolHealth(snapshot: PoolHealthSnapshot): void {
  for (const listener of subscribers) listener(snapshot);
}

function poolFaultCategory(error: unknown, origin: string | undefined): string | undefined {
  // An upstream error is the provider's answer, not evidence the proxy tunnel
  // is broken: an upstream 429 arrives *through* a working CONNECT, so blaming
  // the pool would park healthy exits whenever a provider rate-limits. This
  // function has no provider or route context to tell an egress-scoped quota
  // from a global one, and `sweepExpiredPoolCooldowns` resets counters on a
  // wall-clock timer regardless, so the row's status could not carry that
  // meaning reliably anyway. Egress-scoped quota exhaustion is surfaced instead
  // through the Redis cooldown and the console's `lastSuccessAt` display.
  if (origin === "upstream") return undefined;
  // The pool's own CONNECT failure carries no `code` field: the attempt loop
  // reports a non-GatewayError with `errorOrigin: "gateway"`, so the code-based
  // branches below never saw it and a pool that could not establish a single
  // tunnel stayed `active` forever. Its proxy status picks the category so the
  // console can tell "proxy refuses me" from "proxy is down".
  //
  // A refused CONNECT degrades rather than disables on purpose: `disabled` is
  // an operator decision or an upstream 402/407 verdict, and one credential
  // rotation across a fleet of exits would otherwise sideline every pool at
  // once with no path back except manual re-enable. Degrading is enough to
  // take the pool out of rotation, and a passing probe (or the cooldown sweep)
  // brings it back.
  if (error instanceof ProxyConnectError) {
    return error.proxyStatus === 402 || error.proxyStatus === 407
      ? "proxy_auth_required"
      : "proxy_unreachable";
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const code = error.code;
    if (["proxy_unreachable", "tunnel_setup_failed", "proxy_auth_required", "tls_rejected", "transport_unavailable", "deadline_exceeded"].includes(code)) return code;
  }
  if (origin === "network") return "proxy_unreachable";
  return undefined;
}

/** Record a pool-bound attempt. Only failures produced by the proxy/network boundary degrade the pool. */
export async function recordPoolDispatchOutcome(
  db: LianRouterDatabase,
  poolId: string,
  input: { readonly succeeded: boolean; readonly error?: unknown; readonly errorOrigin?: string; readonly snapshotInvalidator?: { invalidate(): unknown } },
): Promise<void> {
  const category = input.succeeded ? undefined : poolFaultCategory(input.error, input.errorOrigin);
  if (!input.succeeded && category === undefined) return;
  const rows = await db.select().from(networkPools).where(eq(networkPools.id, poolId)).limit(1);
  const pool = rows[0];
  if (!pool || pool.status === "disabled") return;
  const now = new Date();
  const fromStatus = pool.status;
  let status = pool.status;
  let failures = pool.consecutiveFailures;
  let cooldownUntil = pool.cooldownUntil;
  let lastError = pool.lastError;
  let lastErrorCategory = pool.lastErrorCategory;
  let lastErrorAt = pool.lastErrorAt;
  let lastSuccessAt = pool.lastSuccessAt;
  if (input.succeeded) {
    failures = 0;
    status = "active";
    cooldownUntil = null;
    lastError = null;
    lastErrorCategory = null;
    lastErrorAt = null;
    lastSuccessAt = now;
  } else {
    failures += 1;
    status = failures >= 3 ? "cooldown" : "degraded";
    cooldownUntil = new Date(now.getTime() + POOL_COOLDOWN_MS());
    lastErrorCategory = category ?? "proxy_unreachable";
    lastError = `Proxy transport failed (${lastErrorCategory})`;
    lastErrorAt = now;
  }
  const statusChanged = status !== fromStatus;
  const healthChanged =
    statusChanged ||
    pool.consecutiveFailures !== failures ||
    pool.lastErrorCategory !== lastErrorCategory ||
    pool.lastError !== lastError ||
    (input.succeeded && pool.consecutiveFailures > 0);
  await db.update(networkPools).set({
    status,
    consecutiveFailures: failures,
    cooldownUntil,
    lastError,
    lastErrorCategory,
    lastErrorAt,
    lastSuccessAt,
    ...(input.succeeded && fromStatus !== "active" ? { lastRecoveredAt: now } : {}),
  }).where(eq(networkPools.id, poolId));
  if (statusChanged || (input.succeeded && pool.consecutiveFailures > 0)) {
    await db.insert(healthEvents).values({
      entityKind: "pool",
      networkPoolId: poolId,
      fromStatus,
      toStatus: status,
      reason: input.succeeded ? "Proxy dispatch succeeded — pool recovered" : lastError,
      errorCategory: input.succeeded ? null : category,
      // The pool's own cooldown deadline is when the state releases, so the log
      // shows a countdown; a recovery releases immediately.
      createdAt: now,
    });
  }
  if (healthChanged) {
    publishPoolHealth({
      poolId,
      tenantId: pool.tenantId,
      status,
      consecutiveFailures: failures,
      ...(lastError ? { lastError } : {}),
      ...(lastErrorCategory ? { lastErrorCategory } : {}),
      ...(lastErrorAt ? { lastErrorAt: lastErrorAt.toISOString() } : {}),
      ...(cooldownUntil ? { cooldownUntil: cooldownUntil.toISOString() } : {}),
      ...(lastSuccessAt ? { lastSuccessAt: lastSuccessAt.toISOString() } : {}),
    });
  }
  if (statusChanged) await input.snapshotInvalidator?.invalidate();
}

/** Disables a proxy pool after an upstream payment or proxy-auth response. */
export async function disablePoolForProxyHttpStatus(
  db: LianRouterDatabase,
  poolId: string,
  statusCode: number,
  snapshotInvalidator?: { invalidate(): unknown },
): Promise<boolean> {
  const failure =
    statusCode === 402
      ? {
          category: "proxy_payment_required",
          reason: "HTTP 402 Payment Required — proxy reachable but unusable",
        }
      : statusCode === 407
        ? {
            category: "proxy_auth_required",
            reason: "HTTP 407 Proxy Authentication Required — proxy reachable but unusable",
          }
        : undefined;
  if (!failure) return false;

  const rows = await db.select().from(networkPools).where(eq(networkPools.id, poolId)).limit(1);
  const pool = rows[0];
  if (!pool || pool.status === "disabled") return false;

  const now = new Date();
  const updated = await db
    .update(networkPools)
    .set({
      status: "disabled",
      cooldownUntil: null,
      lastError: failure.reason,
      lastErrorCategory: failure.category,
      lastErrorAt: now,
    })
    .where(and(eq(networkPools.id, poolId), eq(networkPools.status, pool.status)))
    .returning({ id: networkPools.id });
  if (!updated[0]) return false;

  await db.insert(healthEvents).values({
    entityKind: "pool",
    networkPoolId: poolId,
    fromStatus: pool.status,
    toStatus: "disabled",
    reason: failure.reason,
    errorCategory: failure.category,
    createdAt: now,
  });
  publishPoolHealth({
    poolId,
    tenantId: pool.tenantId,
    status: "disabled",
    consecutiveFailures: pool.consecutiveFailures,
    lastError: failure.reason,
    lastErrorCategory: failure.category,
    lastErrorAt: now.toISOString(),
  });
  await snapshotInvalidator?.invalidate();
  return true;
}

/** What a manual probe observed, as the health machine needs it. */
export interface PoolProbeOutcome {
  readonly status: "healthy" | "reachable" | "unhealthy" | "timeout";
  readonly latencyMs?: number;
}

/**
 * Applies a manual probe to the pool row.
 *
 * The asymmetry between the two outcomes is the point of this function. A
 * probe that *fails* never demotes: a freshly added exit can answer 407 while
 * the provider is still provisioning it, and one diagnostic dial must not park
 * an otherwise working pool. A probe that *succeeds* is the opposite kind of
 * evidence — the operator just watched the tunnel carry a request — and it is
 * the only way a pool parked by dispatch evidence can be cleared without
 * waiting out its cooldown or clicking Recover. Without it a pool that had one
 * bad minute stays out of routing after it demonstrably works again.
 *
 * `disabled` is never touched. That state is either an operator decision or a
 * dispatch-time 402/407 verdict, and a canary dial is not authority over
 * either.
 *
 * Returns true when the row was promoted back to `active`.
 */
export async function recordPoolProbeOutcome(
  db: LianRouterDatabase,
  tenantId: string,
  poolId: string,
  outcome: PoolProbeOutcome,
): Promise<boolean> {
  const rows = await db
    .select({ status: networkPools.status })
    .from(networkPools)
    .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
    .limit(1);
  const pool = rows[0];
  if (!pool) return false;
  const now = new Date();
  const diagnostics = {
    lastHealthCheckAt: now,
    lastLatencyMs: outcome.latencyMs ?? null,
  };
  if (pool.status === "disabled") {
    await db
      .update(networkPools)
      .set(diagnostics)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)));
    return false;
  }
  // `reachable` lands here too: the proxy answered but refused the tunnel
  // (402/407), which is a dispatch failure and not a working pool. It is still
  // not grounds for demotion — dispatch evidence owns that call.
  if (outcome.status !== "healthy") {
    await db
      .update(networkPools)
      .set(diagnostics)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)));
    return false;
  }
  const parked = pool.status === "degraded" || pool.status === "cooldown";
  // The status guard is part of the WHERE clause, not a read-then-write
  // assumption: a concurrent dispatch or sweep that already moved the row must
  // not be journaled as if this probe made the transition.
  const updated = await db
    .update(networkPools)
    .set({
      ...diagnostics,
      lastSuccessAt: now,
      ...(parked
        ? {
            status: "active" as const,
            consecutiveFailures: 0,
            cooldownUntil: null,
            lastError: null,
            lastErrorCategory: null,
            lastErrorAt: null,
            lastRecoveredAt: now,
          }
        : {}),
    })
    .where(
      parked
        ? and(
            eq(networkPools.tenantId, tenantId),
            eq(networkPools.id, poolId),
            inArray(networkPools.status, ["degraded", "cooldown"]),
          )
        : and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)),
    )
    .returning({ id: networkPools.id });
  if (!parked || !updated[0]) return false;
  await db.insert(healthEvents).values({
    entityKind: "pool",
    networkPoolId: poolId,
    fromStatus: pool.status,
    toStatus: "active",
    reason: "Proxy probe succeeded — pool recovered",
    errorCategory: null,
    createdAt: now,
  });
  publishPoolHealth({
    poolId,
    tenantId,
    status: "active",
    consecutiveFailures: 0,
    lastSuccessAt: now.toISOString(),
  });
  return true;
}

/** Operator recovery mirrors account recovery and records the transition. */
export async function recoverNetworkPool(db: LianRouterDatabase, tenantId: string, poolId: string): Promise<boolean> {
  const rows = await db.select().from(networkPools).where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId))).limit(1);
  const pool = rows[0];
  if (!pool) return false;
  const now = new Date();
  // Clear the error fields with the state: a recovered pool that still reads
  // "Disabled · HTTP 407 …" in the overview looked unrecovered to the operator.
  await db.update(networkPools).set({ status: "active", consecutiveFailures: 0, cooldownUntil: null, lastRecoveredAt: now, lastError: null, lastErrorCategory: null, lastErrorAt: null }).where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)));
  await db.insert(healthEvents).values({ entityKind: "pool", networkPoolId: poolId, fromStatus: pool.status, toStatus: "active", reason: "Manual operator recovery", errorCategory: null, createdAt: now });
  publishPoolHealth({ poolId, tenantId: pool.tenantId, status: "active", consecutiveFailures: 0 });
  return true;
}

/** List recent health and recovery events for a tenant-owned pool. */
export async function listNetworkPoolHealthEvents(db: LianRouterDatabase, tenantId: string, poolId: string, limit = 50): Promise<readonly PoolHealthEvent[]> {
  const owned = await db.select({ id: networkPools.id }).from(networkPools).where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId))).limit(1);
  if (!owned[0]) return [];
  const rows = await db.select().from(healthEvents).where(and(eq(healthEvents.entityKind, "pool"), eq(healthEvents.networkPoolId, poolId))).orderBy(desc(healthEvents.createdAt)).limit(limit);
  return rows.map((row) => ({ id: row.id, networkPoolId: row.networkPoolId ?? poolId, fromStatus: row.fromStatus, toStatus: row.toStatus, reason: row.reason, errorCategory: row.errorCategory, createdAt: row.createdAt.toISOString() }));
}

/** Recover expired degraded/cooldown pools; operator-disabled pools are never swept. */
export async function sweepExpiredPoolCooldowns(db: LianRouterDatabase): Promise<number> {
  const now = new Date();
  const expired = await db.select({ id: networkPools.id, tenantId: networkPools.tenantId, status: networkPools.status }).from(networkPools).where(and(inArray(networkPools.status, ["degraded", "cooldown"]), isNotNull(networkPools.cooldownUntil), lte(networkPools.cooldownUntil, now)));
  if (expired.length === 0) return 0;
  await db.update(networkPools).set({ status: "active", consecutiveFailures: 0, cooldownUntil: null, lastRecoveredAt: now, lastError: null, lastErrorCategory: null, lastErrorAt: null }).where(inArray(networkPools.id, expired.map((row) => row.id)));
  await db.insert(healthEvents).values(expired.map((row) => ({ entityKind: "pool" as const, networkPoolId: row.id, fromStatus: row.status, toStatus: "active" as const, reason: "Cooldown elapsed — auto-recovered", errorCategory: null, createdAt: now })));
  for (const row of expired) publishPoolHealth({ poolId: row.id, tenantId: row.tenantId, status: "active", consecutiveFailures: 0 });
  return expired.length;
}
