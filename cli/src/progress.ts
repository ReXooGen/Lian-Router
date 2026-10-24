/**
 * First-run progress rendering.
 *
 * `ensureGatewayInstalled` can spend a minute streaming tens of megabytes, and
 * the only thing the operator saw was "fetching the latest release" followed by
 * silence. The engine already reports a weighted 0..100 stream; this module is
 * only the presentation of it.
 *
 * Two output shapes, chosen by whether stdout is a terminal:
 *
 * - **TTY:** one self-overwriting line. `\r` returns the cursor without emitting
 *   a newline, so the bar updates in place instead of filling the scrollback. A
 *   phase change ends the previous line first, which is what keeps the completed
 *   phases readable after the flow ends.
 * - **Not a TTY:** one line per phase, never per percent. A CI log with two
 *   hundred progress samples is noise, and a redirected log is read after the
 *   fact, where only the transitions carry meaning.
 *
 * `finish()` exists because a `\r`-terminated line leaves the cursor mid-row: the
 * next message would be appended to a stale percentage.
 */
import type { BootstrapProgress } from "./bootstrap";

export interface ProgressSink {
  readonly write: (chunk: string) => void;
  readonly isTTY: boolean;
}

export interface ProgressReporter {
  readonly update: (progress: BootstrapProgress) => void;
  readonly finish: () => void;
}

const PHASE_WIDTH = 11;

/**
 * Human-readable byte count. MB and GB only: a release archive is tens of
 * megabytes, and a sub-megabyte value only appears for a truncated download that
 * is about to fail anyway.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/**
 * One progress line without its terminator.
 *
 * The detail column prefers byte counters during the download, because
 * "19.2 / 44.7 MB" tells the operator how much is left while the file name does
 * not change. Every other phase keeps the engine's own message — the checksum
 * confirmation and the install steps carry information the byte count would
 * replace.
 */
export function formatProgressLine(progress: BootstrapProgress): string {
  const phase = progress.phase.padEnd(PHASE_WIDTH);
  const percent = `${String(Math.round(progress.percent)).padStart(3)}%`;
  const received = progress.bytesReceived;
  const total = progress.bytesTotal;
  let detail = progress.message;
  if (progress.phase === "downloading" && received !== undefined) {
    detail = total === undefined
      ? formatBytes(received)
      : `${formatBytes(received)} / ${formatBytes(total)}`;
  }
  return `  ${phase} ${percent}  ${detail}`;
}

/** Creates a reporter over `sink`. The returned functions are the whole API. */
export function createProgressReporter(sink: ProgressSink): ProgressReporter {
  let lastPhase: string | undefined;
  let lineOpen = false;

  const closeLine = (): void => {
    if (lineOpen) {
      sink.write("\n");
      lineOpen = false;
    }
  };

  return {
    update: (progress) => {
      if (!sink.isTTY) {
        // Transitions only. `done` is a transition like any other, and it is the
        // one that confirms the install finished rather than stalled.
        if (progress.phase === lastPhase) {
          return;
        }
        lastPhase = progress.phase;
        sink.write(`${formatProgressLine(progress)}\n`);
        return;
      }
      if (progress.phase !== lastPhase) {
        closeLine();
        lastPhase = progress.phase;
      }
      // Pad to erase the previous, possibly longer line: a shrinking message
      // would otherwise leave its tail on screen.
      sink.write(`\r${formatProgressLine(progress).padEnd(64)}`);
      lineOpen = true;
    },
    finish: closeLine,
  };
}
