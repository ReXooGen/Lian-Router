/**
 * Watching an update run from outside the launcher.
 *
 * `POST /update/start` answers `202` and the work outlives the request, so the
 * response says nothing about whether the install succeeded. The launcher keeps
 * the outcome in `GET /update/state` — `{ snapshot, progress, running }`, with
 * the last frame retained precisely so a reconnecting observer can read it — so
 * the tray polls that until the run settles.
 *
 * The classification is a pure function of the frames observed, which is what
 * makes the interesting cases testable without a clock or a network: a run that
 * ends in `phase: "error"`, a run that ends in `done`, and a run that was never
 * observed to finish.
 */

import type { UpdateStateFrame } from "./control-client";

/** How an observed update run ended. */
export type UpdateOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "done"; readonly version: string | undefined }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unknown"; readonly message: string };

/**
 * Decides the outcome from every frame seen so far, newest last.
 *
 * `running: false` is the settle signal, but it is not enough on its own: the
 * launcher clears the progress frame on `done` (`publishProgress` drops `done`
 * as terminal), so a finished run can show `running: false` with `progress:
 * null`. That is why the snapshot's `current` is what names a successful
 * version, and why a null progress with a non-null snapshot is read as success
 * rather than as an absence of information.
 *
 * An `error` frame is sticky: the launcher clears `running` after publishing it,
 * and a later poll may race the clearing, so any frame carrying `error` wins
 * over a later empty one.
 */
export function classifyUpdateOutcome(frames: readonly UpdateStateFrame[]): UpdateOutcome {
  let last: UpdateStateFrame | undefined;
  let failure: string | undefined;

  for (const frame of frames) {
    last = frame;
    const progress = frame.progress;
    if (progress === undefined || progress === null) continue;
    if (progress.phase === "error") {
      const detail = progress.error ?? progress.message;
      failure = detail.length > 0 ? detail : "the update reported an error without a message";
    }
  }

  if (failure !== undefined) return { kind: "failed", message: failure };
  if (last === undefined) return { kind: "none" };
  if (last.running) return { kind: "unknown", message: "the update had not finished when the tray stopped watching" };

  const version = last.snapshot?.latest ?? last.snapshot?.current;
  return { kind: "done", version };
}

/** Polling policy for {@link watchUpdate}. */
export interface WatchUpdateOptions {
  /** Reads the current state; expected to reconnect on its own. */
  readonly readState: () => Promise<UpdateStateFrame | undefined>;
  /** Called once when the run settles. Never called twice. */
  readonly onSettled: (outcome: UpdateOutcome) => void;
  /** Total time to watch before declaring the outcome unknown. */
  readonly timeoutMs: number;
  /** Delay between polls. */
  readonly intervalMs: number;
  /** Injected for tests; production uses `Bun.sleep`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; production uses `Date.now`. */
  readonly now?: () => number;
}

/**
 * How long the tray watches an update.
 *
 * Generous on purpose: the engine's own phases include a full download, a
 * sha256 verify, extraction and an atomic install, and a slow link makes the
 * download the dominant term. Ten minutes is long enough for a large release on
 * a poor connection and short enough that a wedged run is reported rather than
 * watched forever.
 */
export const UPDATE_WATCH_TIMEOUT_MS = 10 * 60 * 1000;
export const UPDATE_POLL_INTERVAL_MS = 1000;

/**
 * Polls until the run settles or the window expires.
 *
 * A read failure is not a verdict: the launcher may be restarting the gateway
 * mid-install, and the update is still running in the launcher process. So a
 * failed poll is skipped and the loop keeps trying until the bound, which is
 * why the failure mode at the end is `unknown` and not `failed`.
 */
export async function watchUpdate(options: WatchUpdateOptions): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? (() => Date.now());
  const frames: UpdateStateFrame[] = [];
  const deadline = now() + options.timeoutMs;

  while (now() < deadline) {
    const frame = await options.readState().catch(() => undefined);
    if (frame !== undefined) {
      frames.push(frame);
      if (!frame.running) {
        options.onSettled(classifyUpdateOutcome(frames));
        return;
      }
    }
    await sleep(options.intervalMs);
  }

  options.onSettled(classifyUpdateOutcome(frames));
}
