import { describe, expect, test } from "bun:test";
import type { ProbeModelResult } from "../lib/contracts";
import {
  createProbeRunStore,
  probeRunStorageKey,
  type ProbeRunStorage,
} from "./account-probe-run";

function memoryStorage(): { storage: ProbeRunStorage; entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    storage: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => {
        entries.set(key, value);
      },
      removeItem: (key) => {
        entries.delete(key);
      },
    },
  };
}

const ok = (latencyMs = 3): ProbeModelResult => ({ ok: true, latencyMs, httpStatus: 200 });

describe("probe run store", () => {
  test("a run keeps progressing after every subscriber unsubscribes", async () => {
    const { storage } = memoryStorage();
    let markFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    const store = createProbeRunStore("cb", {
      storage,
      probe: async () => ok(),
    });

    const statuses: string[] = [];
    const unsubscribe = store.subscribe(() => statuses.push(store.getSnapshot().status));
    const started = store.start({
      providerId: "cb",
      modelId: "model-1",
      accountIds: ["a", "b", "c", "d", "e", "f"],
      onInvalidate: () => markFinished(),
    });
    expect(started).toBe(true);
    expect(store.getSnapshot().status).toBe("running");

    // The component "unmounts": no subscriber is left, but the pool is not tied
    // to it and must finish on its own.
    unsubscribe();
    await finished;

    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe("completed");
    expect(Object.keys(snapshot.rows).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    for (const row of Object.values(snapshot.rows)) expect(row.status).toBe("ok");
    expect(statuses).toContain("running");
  });

  test("stop marks the run stopped and starts no further accounts", async () => {
    const { storage } = memoryStorage();
    const startedAccounts: string[] = [];
    const release: Array<() => void> = [];
    let invalidated = false;
    const store = createProbeRunStore("cb", {
      storage,
      probe: (accountId) => {
        startedAccounts.push(accountId);
        return new Promise<ProbeModelResult>((resolve) => {
          release.push(() => resolve(ok()));
        });
      },
    });

    store.start({
      providerId: "cb",
      modelId: "model-1",
      accountIds: ["a", "b", "c", "d", "e", "f"],
      onInvalidate: () => {
        invalidated = true;
      },
    });
    expect(startedAccounts).toEqual(["a", "b", "c", "d"]);

    store.stop();
    expect(store.getSnapshot().status).toBe("stopped");
    expect(invalidated).toBe(true);

    for (const releaseOne of release) releaseOne();
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

    expect(startedAccounts).toEqual(["a", "b", "c", "d"]);
    expect(store.getSnapshot().status).toBe("stopped");
  });

  test("hydrating a stored running snapshot yields interrupted", () => {
    const { storage } = memoryStorage();
    storage.setItem(
      probeRunStorageKey("cb"),
      JSON.stringify({
        providerId: "cb",
        modelId: "model-1",
        status: "running",
        startedAt: 1_700_000_000_000,
        finishedAt: null,
        rows: [{ accountId: "a", status: "ok", latencyMs: 5 }],
      }),
    );

    const store = createProbeRunStore("cb", { storage });
    const snapshot = store.getSnapshot();

    expect(snapshot.status).toBe("interrupted");
    expect(snapshot.modelId).toBe("model-1");
    expect(snapshot.startedAt).toBe(1_700_000_000_000);
    expect(snapshot.rows.a).toEqual({ status: "ok", latencyMs: 5 });
  });

  test("clear empties the snapshot and removes the stored key", async () => {
    const { storage, entries } = memoryStorage();
    let markFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    const store = createProbeRunStore("cb", {
      storage,
      probe: async () => ok(),
    });
    store.start({
      providerId: "cb",
      modelId: "model-1",
      accountIds: ["a", "b"],
      onInvalidate: () => markFinished(),
    });
    await finished;
    expect(entries.has(probeRunStorageKey("cb"))).toBe(true);

    store.clear();

    expect(store.getSnapshot()).toMatchObject({
      status: "idle",
      modelId: "",
      startedAt: null,
      finishedAt: null,
      rows: {},
    });
    expect(entries.has(probeRunStorageKey("cb"))).toBe(false);
  });

  test("a second start while a run is in progress is refused", () => {
    const { storage } = memoryStorage();
    const store = createProbeRunStore("cb", {
      storage,
      probe: () => new Promise<ProbeModelResult>(() => {}),
    });

    const first = store.start({
      providerId: "cb",
      modelId: "model-1",
      accountIds: ["a", "b"],
    });
    const startedAt = store.getSnapshot().startedAt;

    const second = store.start({
      providerId: "cb",
      modelId: "model-2",
      accountIds: ["c"],
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(store.getSnapshot().modelId).toBe("model-1");
    expect(store.getSnapshot().startedAt).toBe(startedAt);
    expect(store.getSnapshot().rows.c).toBeUndefined();

    store.stop();
  });
});
