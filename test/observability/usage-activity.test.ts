import { describe, expect, test } from "bun:test";
import {
  publishUsageActivity,
  subscribeUsageActivity,
  type UsageActivity,
} from "../../src/observability/usage-activity";

describe("usage activity fan-out", () => {
  test("delivers one activity per tenant in a mixed batch", () => {
    const seen: UsageActivity[] = [];
    const unsubscribe = subscribeUsageActivity((activity) => seen.push(activity));
    try {
      publishUsageActivity([
        { tenantId: "tenant-a" },
        { tenantId: "tenant-a" },
        { tenantId: "tenant-b" },
        { tenantId: null },
      ]);
    } finally {
      unsubscribe();
    }
    // Coalesced per tenant: a listener only needs to know its rows changed, and
    // one event per row would make a large batch fan out N times.
    expect(seen).toHaveLength(3);
    expect(seen.find((a) => a.tenantId === "tenant-a")?.count).toBe(2);
    expect(seen.find((a) => a.tenantId === "tenant-b")?.count).toBe(1);
    expect(seen.find((a) => a.tenantId === null)?.count).toBe(1);
  });

  test("stops delivering after unsubscribe", () => {
    const seen: UsageActivity[] = [];
    const unsubscribe = subscribeUsageActivity((activity) => seen.push(activity));
    publishUsageActivity([{ tenantId: "tenant-a" }]);
    unsubscribe();
    publishUsageActivity([{ tenantId: "tenant-a" }]);
    // A closed SSE connection must not keep receiving; a leaked listener would
    // hold the dead stream's closure for the process lifetime.
    expect(seen).toHaveLength(1);
  });

  test("a throwing listener does not stop the others or the publisher", () => {
    const seen: UsageActivity[] = [];
    const bad = subscribeUsageActivity(() => {
      throw new Error("broken stream");
    });
    const good = subscribeUsageActivity((activity) => seen.push(activity));
    try {
      // The publisher runs inside the telemetry drain: a failing subscriber
      // must never fail the write that persists request history.
      expect(() => publishUsageActivity([{ tenantId: "tenant-a" }])).not.toThrow();
      expect(seen).toHaveLength(1);
    } finally {
      bad();
      good();
    }
  });

  test("an empty batch publishes nothing", () => {
    const seen: UsageActivity[] = [];
    const unsubscribe = subscribeUsageActivity((activity) => seen.push(activity));
    try {
      publishUsageActivity([]);
    } finally {
      unsubscribe();
    }
    expect(seen).toHaveLength(0);
  });
});
