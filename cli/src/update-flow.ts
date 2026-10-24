import type { UpdateProgressFrame, UpdateSnapshot } from "./control-server";

/**
 * The launcher's update sequence, extracted so it can be tested and reused.
 *
 * The ordering constraint is the whole point of this module. The gateway serves
 * the console that watches the update, and Windows holds an open handle on the
 * executable while the child runs — so the child must stay alive for
 * `checking → downloading → verifying → extracting` (otherwise the browser loses
 * the very page showing the progress bar) and must be stopped exactly once,
 * immediately before the install renames the binary it is executing.
 *
 * The engine's `onProgress` is synchronous, so the stop is started there and
 * awaited at the two points that need it: the `restart` hook before starting the
 * new binary, and the failure path before deciding whether a recovery start is
 * needed.
 */

/** The subset of `UpdateInfo` this sequence reads. */
export interface UpdateFlowInfo {
  readonly current: string;
  readonly latest: string;
  readonly available: boolean;
  readonly notesUrl?: string;
  readonly publishedAt?: string;
}

/** The subset of `UpdateProgress` this sequence reads. */
export interface UpdateFlowProgress {
  readonly phase: string;
  readonly percent: number;
  readonly message: string;
  readonly bytesReceived?: number;
  readonly bytesTotal?: number;
  readonly error?: string;
}

export interface UpdateFlowRunOptions {
  readonly installRoot: string;
  readonly currentVersion: string;
  readonly onProgress: (progress: UpdateFlowProgress) => void;
  readonly restart?: () => Promise<void>;
}

export interface UpdateFlowDeps {
  readonly currentVersion: string;
  readonly installRoot: string;
  readonly checkForUpdate: (options: { currentVersion: string }) => Promise<UpdateFlowInfo>;
  readonly runUpdate: (options: UpdateFlowRunOptions) => Promise<void>;
  /** Stops the gateway child. Called once, at the install boundary. */
  readonly stopGateway: () => Promise<void>;
  /** Starts the gateway again after the install (and after a failed install). */
  readonly startGateway: () => Promise<void>;
  readonly publish: (snapshot: UpdateSnapshot) => void;
  readonly publishProgress: (progress: UpdateProgressFrame) => void;
}

/**
 * Runs check → install, stopping the gateway only at the install boundary.
 *
 * Returns normally when the install is up to date; rethrows whatever the engine
 * threw. Callers own the "update is running" flag around this call.
 */
export async function runUpdateSequence(deps: UpdateFlowDeps): Promise<void> {
  const info = await deps.checkForUpdate({ currentVersion: deps.currentVersion });
  deps.publish({
    current: info.current,
    latest: info.latest,
    available: info.available,
    ...(info.notesUrl === undefined ? {} : { notesUrl: info.notesUrl }),
    ...(info.publishedAt === undefined ? {} : { publishedAt: info.publishedAt }),
  });
  if (!info.available) {
    return;
  }

  // `onProgress` fires many times and cannot await, so the stop is a single
  // promise created on the first `installing` frame and awaited by the two
  // places that must not proceed without it.
  let stopPromise: Promise<void> | undefined;
  const stopOnce = (): Promise<void> => {
    stopPromise ??= deps.stopGateway();
    return stopPromise;
  };

  try {
    await deps.runUpdate({
      installRoot: deps.installRoot,
      currentVersion: deps.currentVersion,
      onProgress: (progress) => {
        deps.publishProgress({
          phase: progress.phase,
          percent: progress.percent,
          message: progress.message,
          ...(progress.bytesReceived === undefined ? {} : { bytesReceived: progress.bytesReceived }),
          ...(progress.bytesTotal === undefined ? {} : { bytesTotal: progress.bytesTotal }),
          ...(progress.error === undefined ? {} : { error: progress.error }),
        });
        // The engine emits `installing` before it touches the filesystem. That
        // is the only moment where stopping is both safe (the download is done)
        // and necessary (the rename needs the handle released).
        if (progress.phase === "installing" && stopPromise === undefined) {
          void stopOnce().catch(() => undefined);
        }
      },
      restart: async () => {
        await stopPromise;
        await deps.startGateway();
      },
    });
  } catch (error) {
    await stopPromise?.catch(() => undefined);
    if (stopPromise !== undefined) {
      // The gateway was stopped and the install failed. Nothing else in this
      // process would start it again, and the console is served by it — so the
      // recovery start is what makes the browser's `/health` wait pollable at
      // all. The install's rollback has restored the previous tree, so this
      // brings back a working gateway either way.
      await deps.startGateway().catch(() => undefined);
    }
    throw error;
  }
}
