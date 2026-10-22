/**
 * Fan-out for "telemetry landed" signals, so live console surfaces can refresh
 * on real activity instead of polling on a timer.
 *
 * Published only after a batch is committed (`TelemetryBatchBuffer.drain`), not
 * at enqueue: the dashboard's queries read the database, so a signal sent
 * before the write would trigger a refetch that returns the old rows and the
 * view would appear frozen until the next tick.
 *
 * Deliberately process-local and payload-free beyond the tenant id. A
 * multi-process deployment therefore notifies only the process that served the
 * request, which is correct for the common single-process setup and degrades to
 * the previous polling behavior elsewhere rather than dropping events into a
 * broker this codebase does not run.
 */
export interface UsageActivity {
  /** Tenant whose rows were written; `null` for a global/unattributed write. */
  readonly tenantId: string | null;
  /** How many events landed in this batch, for a listener that wants to gauge volume. */
  readonly count: number;
}

type UsageListener = (activity: UsageActivity) => void;

const listeners = new Set<UsageListener>();

/**
 * Registers one listener and returns its unsubscribe.
 *
 * A `Set` of callbacks rather than an `EventEmitter` because every subscriber is
 * a live SSE connection that must be removed deterministically when it closes;
 * a leaked listener here would keep a dead stream's closure alive for the
 * process lifetime.
 */
export function subscribeUsageActivity(listener: UsageListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announces a committed telemetry batch. Never throws: a listener that fails
 * must not fail the drain that published to it, because that drain is also the
 * path that persists request history.
 */
export function publishUsageActivity(
  events: readonly { readonly tenantId?: string | null }[],
): void {
  if (listeners.size === 0 || events.length === 0) return;
  // One event per tenant per batch: a batch routinely mixes tenants, and a
  // listener filtering by tenant only needs to know that its rows changed.
  const byTenant = new Map<string | null, number>();
  for (const event of events) {
    const tenantId = event.tenantId ?? null;
    byTenant.set(tenantId, (byTenant.get(tenantId) ?? 0) + 1);
  }
  for (const [tenantId, count] of byTenant) {
    for (const listener of listeners) {
      try {
        listener({ tenantId, count });
      } catch {
        // A broken stream must not break telemetry persistence.
      }
    }
  }
}
