import { describe, expect, test } from "bun:test";
import {
  PROBE_CONCURRENCY,
  orderProbeRows,
  runAccountProbePool,
  type ProbeRecord,
  type ProbeStatus,
} from "./account-probe-model";
import type { ProbeModelResult } from "../lib/contracts";

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `acct-${index}`);

const ok = (latencyMs = 5): ProbeModelResult => ({ ok: true, latencyMs, httpStatus: 200 });

describe("account probe pool", () => {
  test("never runs more than the concurrency limit in flight", async () => {
    const accounts = ids(12);
    let inFlight = 0;
    let peak = 0;
    const records: ProbeRecord[] = [];

    const run = runAccountProbePool({
      accountIds: accounts,
      concurrency: PROBE_CONCURRENCY,
      async probe() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yield one microtask so the pool can fill its window before any
        // probe settles; no wall-clock delay is needed to observe the cap.
        await Promise.resolve();
        inFlight -= 1;
        return ok();
      },
      onResult: (record) => records.push(record),
    });

    await run.completion;

    expect(peak).toBe(PROBE_CONCURRENCY);
    expect(peak).toBeLessThanOrEqual(4);
    expect(records).toHaveLength(accounts.length);
    expect(records.map((record) => record.accountId).sort()).toEqual([...accounts].sort());
  });

  test("stop resolves completion even if an in-flight probe never settles", async () => {
    const started: string[] = [];
    const run = runAccountProbePool({
      accountIds: ids(6),
      concurrency: 3,
      probe: (accountId) => {
        started.push(accountId);
        // Never settles: a probe stuck on an upstream that never answers.
        return new Promise<ProbeModelResult>(() => {});
      },
    });

    expect(started).toEqual(["acct-0", "acct-1", "acct-2"]);

    run.stop();
    let settled = false;
    void run.completion.then(() => {
      settled = true;
    });
    // Completion must not be tied to the in-flight promises' lifetime.
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

    expect(settled).toBe(true);
    expect(started).toEqual(["acct-0", "acct-1", "acct-2"]);
  });

  test("stop prevents queued accounts from starting while started probes finish", async () => {
    const accounts = ids(10);
    const started: string[] = [];
    const release: Array<() => void> = [];
    const settled: string[] = [];

    const run = runAccountProbePool({
      accountIds: accounts,
      concurrency: 4,
      probe: (accountId) => {
        started.push(accountId);
        return new Promise<ProbeModelResult>((resolve) => {
          release.push(() => resolve(ok()));
        });
      },
      onResult: (record) => settled.push(record.accountId),
    });

    // The pool dequeues its first wave synchronously.
    expect(started).toEqual(accounts.slice(0, 4));

    run.stop();
    for (const resolve of release) resolve();
    await run.completion;

    expect(started).toEqual(accounts.slice(0, 4));
    expect(settled.sort()).toEqual(accounts.slice(0, 4).sort());
  });

  test("records each account and keeps the failure error", async () => {
    const records: ProbeRecord[] = [];

    const run = runAccountProbePool({
      accountIds: ["passes", "rejects", "throws"],
      concurrency: 2,
      probe: (accountId) => {
        if (accountId === "passes") return Promise.resolve(ok(42));
        if (accountId === "throws") throw new Error("sync boom");
        return Promise.reject(new Error("upstream rate limited"));
      },
      onResult: (record) => records.push(record),
    });

    await run.completion;

    const byAccount = new Map(records.map((record) => [record.accountId, record]));
    expect(byAccount.get("passes")).toMatchObject({ status: "ok", latencyMs: 42 });
    expect(byAccount.get("rejects")).toMatchObject({
      status: "failed",
      error: "upstream rate limited",
    });
    expect(byAccount.get("throws")).toMatchObject({ status: "failed", error: "sync boom" });
  });
});

describe("result ordering", () => {
  test("puts failures first, then ok, then pending", () => {
    const rows: Array<{ id: string; status: ProbeStatus }> = [
      { id: "pending-1", status: "pending" },
      { id: "ok-1", status: "ok" },
      { id: "running-1", status: "running" },
      { id: "failed-1", status: "failed" },
      { id: "ok-2", status: "ok" },
      { id: "failed-2", status: "failed" },
    ];

    expect(orderProbeRows(rows).map((row) => row.id)).toEqual([
      "failed-1",
      "failed-2",
      "ok-1",
      "ok-2",
      "running-1",
      "pending-1",
    ]);
  });
});
