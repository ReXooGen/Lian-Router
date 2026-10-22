import { queryKeys } from "./query-keys";

/**
 * Refetch scheduling for the live usage signal (`GET /live/usage/stream`).
 *
 * Kept out of the hook so the coalescing rules are unit-testable without a DOM:
 * the backend announces *when* telemetry landed and the existing usage queries
 * stay the only source of the numbers, so the whole behaviour here is "which
 * query keys to invalidate, and how often".
 */

/** Coalescing window for usage refetches. A busy gateway flushes telemetry
 *  every 500 ms, and refetching the aggregates per flush would turn a steady
 *  request stream into a query storm that costs more than the freshness buys. */
export const USAGE_REFRESH_DEBOUNCE_MS = 1_500;

/** Delay before re-opening the stream after it drops. The console has no
 *  other live signal for usage, so a permanent close would freeze the pages. */
export const USAGE_STREAM_RETRY_MS = 5_000;

/**
 * Query-key prefixes a telemetry write can move.
 *
 * All three are needed because a single request updates all three views:
 * Overview renders its latency/error figures from the `system.health`
 * snapshot, its own `system.usage` read backs the Refresh button, and Usage
 * reads the `usageAnalytics.*` aggregates. Invalidating by prefix keeps each
 * page's own period/dimension/status filters intact, since those live in the
 * query key rather than here.
 */
export const USAGE_QUERY_PREFIXES = [
  ["console", "usage"],
  queryKeys.system.usage,
  queryKeys.system.health,
] as const;

/**
 * Coalesces a burst of stream events into a single invalidation.
 *
 * `onFlush` receives the key prefixes to invalidate. Events arriving while a
 * flush is pending are absorbed into that pending flush rather than queued, so
 * a sustained stream settles at one invalidation per window.
 */
export function createUsageRefreshScheduler(
  onFlush: (prefixes: readonly (readonly string[])[]) => void,
  windowMs: number = USAGE_REFRESH_DEBOUNCE_MS,
): { schedule: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        onFlush(USAGE_QUERY_PREFIXES);
      }, windowMs);
    },
    cancel() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
