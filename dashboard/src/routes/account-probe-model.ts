import { getErrorMessage } from "../lib/helpers";
import type { ProbeModelRequest, ProbeModelResult } from "../lib/contracts";

/**
 * How many single-account probes the page keeps in flight.
 *
 * The per-account endpoint pins one credential, so the batch route's ~9 minute
 * blocking call is avoidable — but 2,216 parallel requests would just move the
 * flood to the provider. Four keeps the run observable without stalling.
 */
export const PROBE_CONCURRENCY = 4;

/** Rendered result rows; the rest are summarised as hidden. */
export const MAX_PROBE_ROWS = 100;

export type ProbeStatus = "pending" | "running" | "ok" | "failed";

/** One account's live state in the probe run. */
export interface ProbeRowState {
  readonly status: ProbeStatus;
  readonly latencyMs?: number;
  readonly ttfbMs?: number;
  readonly statusCode?: number;
  readonly error?: string;
}

/** A settled probe, keyed back to the account it pinned. */
export interface ProbeRecord extends ProbeRowState {
  readonly accountId: string;
  readonly status: "ok" | "failed";
}

export type ProbeFilter = "all" | "failed" | "ok";

export const PROBE_FILTER_OPTIONS: ReadonlyArray<{ value: ProbeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "ok", label: "OK" },
];

/**
 * The models the probe picker offers: enabled entries only, once per model id.
 * A provider can register the same id under several routes, and offering the
 * duplicate would imply the probe picks a route it does not send.
 */
export function enabledModelOptions(
  models: readonly { readonly modelId: string; readonly enabled: boolean }[],
): ReadonlyArray<{ value: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  for (const model of models) {
    if (!model.enabled || seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    options.push({ value: model.modelId, label: model.modelId });
  }
  return options;
}

/**
 * Builds the probe body for one account. `accountId` is what pins the route to
 * this single account: without it the same endpoint falls back to its
 * 12-account fan-out.
 */
export function accountProbeRequest(
  modelId: string,
  accountId: string,
): ProbeModelRequest {
  return { modelId, accountId };
}

export function probeRecordFromResult(
  accountId: string,
  result: ProbeModelResult,
): ProbeRecord {
  if (result.ok) {
    return {
      accountId,
      status: "ok",
      latencyMs: result.latencyMs,
      ...(result.ttfbMs === undefined ? {} : { ttfbMs: result.ttfbMs }),
      ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
    };
  }
  return {
    accountId,
    status: "failed",
    latencyMs: result.latencyMs,
    ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
    error: result.error ?? "Probe failed",
  };
}

export function probeRecordFromError(accountId: string, error: unknown): ProbeRecord {
  return {
    accountId,
    status: "failed",
    latencyMs: 0,
    error: getErrorMessage(error, "Probe request failed"),
  };
}

/**
 * Failures first, then the accounts that passed, then everything the run has
 * not reached. Ties keep the caller's order so a refresh does not reshuffle
 * rows the operator is reading.
 */
const STATUS_RANK: Record<ProbeStatus, number> = {
  failed: 0,
  ok: 1,
  running: 2,
  pending: 3,
};

export function orderProbeRows<T extends { readonly status: ProbeStatus }>(
  rows: readonly T[],
): readonly T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        STATUS_RANK[a.row.status] - STATUS_RANK[b.row.status] || a.index - b.index,
    )
    .map((entry) => entry.row);
}

export interface ProbePoolOptions {
  readonly accountIds: readonly string[];
  readonly probe: (accountId: string) => Promise<ProbeModelResult>;
  readonly concurrency?: number;
  readonly onStart?: (accountId: string) => void;
  readonly onResult?: (record: ProbeRecord) => void;
}

export interface ProbePoolRun {
  /**
   * Resolves when every started probe settled, or as soon as `stop()` is
   * called. Callers that stop must not wait for a probe that never answers.
   */
  readonly completion: Promise<void>;
  /** Queued accounts never start; probes already started keep running and may still report. */
  stop(): void;
}

/**
 * Starts at most `concurrency` single-account probes at a time.
 *
 * The pool is deliberately transport-free: it takes a probe function and
 * reports state transitions, so the queue, the cap, and the stop flag are
 * exercised without React or a network stub.
 */
export function runAccountProbePool({
  accountIds,
  probe,
  concurrency = PROBE_CONCURRENCY,
  onStart,
  onResult,
}: ProbePoolOptions): ProbePoolRun {
  const limit = Math.max(1, Math.trunc(concurrency));
  const tasks = new Set<Promise<void>>();
  let cursor = 0;
  let stopped = false;

  const pump = (): void => {
    while (!stopped && tasks.size < limit && cursor < accountIds.length) {
      const accountId = accountIds[cursor]!;
      cursor += 1;
      onStart?.(accountId);
      let pending: Promise<ProbeModelResult>;
      try {
        pending = Promise.resolve(probe(accountId));
      } catch (error) {
        pending = Promise.reject(error);
      }
      const task: Promise<void> = pending
        .then(
          (result) => {
            onResult?.(probeRecordFromResult(accountId, result));
          },
          (error: unknown) => {
            onResult?.(probeRecordFromError(accountId, error));
          },
        )
        // A consumer callback that throws must not surface as an unhandled
        // rejection once stop() has already resolved `completion`.
        .catch(() => undefined)
        .finally(() => {
          tasks.delete(task);
          pump();
        });
      tasks.add(task);
    }
  };

  let signalStop: () => void = () => {};
  const stopSignal = new Promise<void>((resolve) => {
    signalStop = resolve;
  });

  // Each settled task pumps the next one before its own promise settles, so a
  // snapshot of `tasks` re-read after `allSettled` is the next wave. The race
  // lets stop() release the caller immediately: a probe stuck on an upstream
  // that never answers must not keep the run marked as in flight.
  const completion = (async (): Promise<void> => {
    pump();
    while (tasks.size > 0) {
      await Promise.race([Promise.allSettled([...tasks]), stopSignal]);
      if (stopped) return;
    }
  })();

  return {
    completion,
    stop() {
      if (stopped) return;
      stopped = true;
      signalStop();
    },
  };
}
