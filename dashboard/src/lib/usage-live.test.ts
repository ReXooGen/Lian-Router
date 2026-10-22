import { describe, expect, test, vi } from "bun:test";
import {
  createUsageRefreshScheduler,
  USAGE_QUERY_PREFIXES,
  USAGE_REFRESH_DEBOUNCE_MS,
} from "./usage-live";

describe("usage refresh scheduling", () => {
  test("covers the Usage aggregates, the Overview snapshot, and health", () => {
    // One telemetry write moves all three. Overview renders its latency and
    // error figures from `system.health` — not from `system.usage` — so
    // omitting health leaves the visible numbers on the 15 s poll and the
    // page looks frozen even though requests are landing.
    const flattened = USAGE_QUERY_PREFIXES.map((prefix) => prefix.join("/"));
    expect(flattened).toContain("console/usage");
    expect(flattened).toContain("console/system/usage");
    expect(flattened).toContain("console/system/health");
  });

  test("prefixes stay coarse enough to match every filtered variant", () => {
    // Usage queries carry period/dimension/status in the key; the signal knows
    // none of that, so the prefix must sit above those segments.
    const usagePrefix = USAGE_QUERY_PREFIXES[0]!;
    expect(["console", "usage", "summary", "24h"].slice(0, usagePrefix.length)).toEqual([
      ...usagePrefix,
    ]);
    expect(["console", "usage", "requests", "24h", 50, "all"].slice(0, usagePrefix.length)).toEqual([
      ...usagePrefix,
    ]);
  });

  test("collapses a burst of events into one invalidation", () => {
    vi.useFakeTimers();
    try {
      const flushes: unknown[][] = [];
      const scheduler = createUsageRefreshScheduler((prefixes) => flushes.push([...prefixes]));
      // A busy gateway flushes telemetry every 500 ms; without coalescing this
      // burst would be five refetches of every usage query.
      for (let i = 0; i < 5; i += 1) scheduler.schedule();
      expect(flushes).toHaveLength(0);
      vi.advanceTimersByTime(USAGE_REFRESH_DEBOUNCE_MS);
      expect(flushes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps refreshing across successive windows", () => {
    vi.useFakeTimers();
    try {
      const flushes: unknown[][] = [];
      const scheduler = createUsageRefreshScheduler((prefixes) => flushes.push([...prefixes]));
      scheduler.schedule();
      vi.advanceTimersByTime(USAGE_REFRESH_DEBOUNCE_MS);
      scheduler.schedule();
      vi.advanceTimersByTime(USAGE_REFRESH_DEBOUNCE_MS);
      // Live means live: a second batch must refetch again, not be treated as
      // part of the first burst.
      expect(flushes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancel drops a pending flush", () => {
    vi.useFakeTimers();
    try {
      let flushed = false;
      const scheduler = createUsageRefreshScheduler(() => {
        flushed = true;
      });
      scheduler.schedule();
      scheduler.cancel();
      vi.advanceTimersByTime(USAGE_REFRESH_DEBOUNCE_MS);
      // Unmounting the page must not fire a refetch against a dead component.
      expect(flushed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
