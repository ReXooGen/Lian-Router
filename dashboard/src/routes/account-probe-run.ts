import { consoleRequest } from "../lib/api";
import type { ProbeModelResult } from "../lib/contracts";
import {
  PROBE_CONCURRENCY,
  runAccountProbePool,
  type ProbePoolRun,
  type ProbeRecord,
  type ProbeRowState,
} from "./account-probe-model";

export type ProbeRunStatus =
  | "idle"
  | "running"
  | "stopped"
  | "completed"
  | "interrupted";

/** Immutable view of one provider's last run. Replaced, never mutated. */
export interface ProbeRunSnapshot {
  readonly providerId: string;
  readonly modelId: string;
  readonly status: ProbeRunStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly rows: Readonly<Record<string, ProbeRowState>>;
}

export interface ProbeRunStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ProbeAccountFn = (
  accountId: string,
  modelId: string,
) => Promise<ProbeModelResult>;

export interface StartProbeRunOptions {
  readonly providerId: string;
  readonly modelId: string;
  readonly accountIds: readonly string[];
  /** Called once when the run stops or finishes, whether or not a page is mounted. */
  readonly onInvalidate?: (providerId: string) => void;
}

export interface ProbeRunStoreDeps {
  /** Injected in tests; omitted in the browser means `window.localStorage`. */
  readonly storage?: ProbeRunStorage | null;
  /** Injected in tests; omitted means the real probe endpoint. */
  readonly probe?: ProbeAccountFn;
}

export interface ProbeRunStore {
  readonly providerId: string;
  getSnapshot(): ProbeRunSnapshot;
  subscribe(listener: () => void): () => void;
  start(options: StartProbeRunOptions): boolean;
  stop(): void;
  clear(): void;
}

interface StoredRow extends ProbeRowState {
  readonly accountId: string;
}

interface StoredRun {
  readonly providerId: string;
  readonly modelId: string;
  readonly status: ProbeRunStatus;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly rows: readonly StoredRow[];
}

const PENDING_ROW: ProbeRowState = { status: "pending" };
const PERSIST_INTERVAL_MS = 1_000;

export function probeRunStorageKey(providerId: string): string {
  return `lianrouter:probe-run:${providerId}`;
}

function idleSnapshot(providerId: string): ProbeRunSnapshot {
  return {
    providerId,
    modelId: "",
    status: "idle",
    startedAt: null,
    finishedAt: null,
    rows: {},
  };
}

function browserStorage(): ProbeRunStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isProbeStatus(value: unknown): value is ProbeRowState["status"] {
  return value === "pending" || value === "running" || value === "ok" || value === "failed";
}

function rowsFromStored(value: unknown): Record<string, ProbeRowState> | null {
  if (!Array.isArray(value)) return null;
  const rows: Record<string, ProbeRowState> = {};
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.accountId !== "string" || !isProbeStatus(row.status)) continue;
    rows[row.accountId] = {
      status: row.status,
      ...(typeof row.latencyMs === "number" ? { latencyMs: row.latencyMs } : {}),
      ...(typeof row.ttfbMs === "number" ? { ttfbMs: row.ttfbMs } : {}),
      ...(typeof row.statusCode === "number" ? { statusCode: row.statusCode } : {}),
      ...(typeof row.error === "string" ? { error: row.error } : {}),
    };
  }
  return rows;
}

/**
 * Reads the last persisted run. A snapshot stored as `running` died with the
 * page that owned its pool, so it is reported as `interrupted` rather than
 * pretending progress is still happening.
 */
function hydrateSnapshot(
  providerId: string,
  storage: ProbeRunStorage | null,
): ProbeRunSnapshot {
  if (!storage) return idleSnapshot(providerId);
  let raw: string | null;
  try {
    raw = storage.getItem(probeRunStorageKey(providerId));
  } catch {
    return idleSnapshot(providerId);
  }
  if (!raw) return idleSnapshot(providerId);
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRun>;
    if (parsed.providerId !== providerId) return idleSnapshot(providerId);
    const rows = rowsFromStored(parsed.rows);
    if (!rows) return idleSnapshot(providerId);
    const status: ProbeRunStatus =
      parsed.status === "running" ? "interrupted" : (parsed.status ?? "idle");
    if (
      status !== "idle" &&
      status !== "stopped" &&
      status !== "completed" &&
      status !== "interrupted"
    ) {
      return idleSnapshot(providerId);
    }
    return {
      providerId,
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : "",
      status,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null,
      finishedAt: typeof parsed.finishedAt === "number" ? parsed.finishedAt : null,
      rows,
    };
  } catch {
    return idleSnapshot(providerId);
  }
}

function rowFromRecord(record: ProbeRecord): ProbeRowState {
  return {
    status: record.status,
    ...(record.latencyMs === 0 ? {} : { latencyMs: record.latencyMs }),
    ...(record.ttfbMs === undefined ? {} : { ttfbMs: record.ttfbMs }),
    ...(record.statusCode === undefined ? {} : { statusCode: record.statusCode }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

/**
 * Owns one provider's probe run outside React so navigating away does not stop
 * it, and persists a throttled snapshot so a reload still shows the last known
 * results. Deliberately React-free: only the module-level registry below is
 * shared, and only the page subscribes to it.
 */
export function createProbeRunStore(
  providerId: string,
  deps: ProbeRunStoreDeps = {},
): ProbeRunStore {
  const storage = deps.storage === undefined ? browserStorage() : deps.storage;
  const probe: ProbeAccountFn =
    deps.probe ??
    ((accountId, modelId) =>
      consoleRequest<ProbeModelResult>(
        `/providers/${encodeURIComponent(providerId)}/models/probe`,
        {
          method: "POST",
          body: JSON.stringify({ modelId, accountId }),
        },
      ));

  let snapshot = hydrateSnapshot(providerId, storage);
  const listeners = new Set<() => void>();
  let pool: ProbePoolRun | null = null;
  let running = false;
  let stopRequested = false;
  let runToken = 0;
  let onInvalidate: ((providerId: string) => void) | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPersistAt = 0;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const persistNow = (): void => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    lastPersistAt = Date.now();
    if (!storage) return;
    const stored: StoredRun = {
      providerId,
      modelId: snapshot.modelId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      rows: Object.entries(snapshot.rows).map(([accountId, row]) => ({
        accountId,
        ...row,
      })),
    };
    try {
      storage.setItem(probeRunStorageKey(providerId), JSON.stringify(stored));
    } catch {
      // Storage can be unavailable (quota, private mode); the in-memory run
      // stays authoritative and navigation within the SPA still works.
    }
  };

  // Rows arrive a few at a time; stringifying 2,334 of them on every result
  // would dominate the run, so writes are at most one per second until the
  // final write.
  const schedulePersist = (): void => {
    if (persistTimer !== null) return;
    const wait = Math.max(0, PERSIST_INTERVAL_MS - (Date.now() - lastPersistAt));
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, wait);
  };

  const finish = (status: "stopped" | "completed", token: number): void => {
    if (runToken !== token || !running) return;
    running = false;
    pool = null;
    snapshot = { ...snapshot, status, finishedAt: Date.now() };
    persistNow();
    notify();
    const invalidate = onInvalidate;
    onInvalidate = undefined;
    if (invalidate) {
      try {
        invalidate(providerId);
      } catch {
        // The account list refresh is best-effort; the run's results are kept.
      }
    }
  };

  const start = (options: StartProbeRunOptions): boolean => {
    if (running || options.providerId !== providerId) return false;
    if (options.modelId === "" || options.accountIds.length === 0) return false;

    const token = runToken + 1;
    runToken = token;
    running = true;
    stopRequested = false;
    onInvalidate = options.onInvalidate;
    const rows: Record<string, ProbeRowState> = {};
    for (const accountId of options.accountIds) rows[accountId] = PENDING_ROW;
    snapshot = {
      providerId,
      modelId: options.modelId,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      rows,
    };
    persistNow();
    notify();

    pool = runAccountProbePool({
      accountIds: options.accountIds,
      concurrency: PROBE_CONCURRENCY,
      probe: (accountId) => probe(accountId, options.modelId),
      onStart: (accountId) => {
        if (runToken !== token || !running) return;
        snapshot = {
          ...snapshot,
          rows: { ...snapshot.rows, [accountId]: { status: "running" } },
        };
        notify();
      },
      onResult: (record) => {
        if (runToken !== token || !running) return;
        snapshot = {
          ...snapshot,
          rows: { ...snapshot.rows, [record.accountId]: rowFromRecord(record) },
        };
        schedulePersist();
        notify();
      },
    });

    void pool.completion.then(() => {
      finish(stopRequested ? "stopped" : "completed", token);
    });
    return true;
  };

  const stop = (): void => {
    if (!running) return;
    stopRequested = true;
    pool?.stop();
    finish("stopped", runToken);
  };

  const clear = (): void => {
    pool?.stop();
    pool = null;
    running = false;
    stopRequested = false;
    onInvalidate = undefined;
    runToken += 1;
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    snapshot = idleSnapshot(providerId);
    try {
      storage?.removeItem(probeRunStorageKey(providerId));
    } catch {
      // Removal is best-effort; the in-memory snapshot is already idle.
    }
    notify();
  };

  return {
    providerId,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    clear,
  };
}

const stores = new Map<string, ProbeRunStore>();

/** One store per provider, shared by every mount of the probe-all page. */
export function getProbeRunStore(providerId: string): ProbeRunStore {
  let store = stores.get(providerId);
  if (!store) {
    store = createProbeRunStore(providerId);
    stores.set(providerId, store);
  }
  return store;
}
