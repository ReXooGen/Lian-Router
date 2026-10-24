/**
 * Pure view model for the terminal console.
 *
 * Nothing here touches the terminal, the filesystem, or the network: the app
 * collects observations, folds them through these reducers, and hands the
 * result to the renderer. Keeping the state this thin is what makes the frame
 * testable without a pty.
 */

export interface TuiServerState {
  readonly state: string;
  readonly port: number;
  readonly pid: number | undefined;
  readonly uptimeMs: number;
  readonly url: string;
}

export interface TuiLogLine {
  readonly at: number;
  readonly level: string;
  readonly text: string;
}

export interface TuiViewState {
  readonly server: TuiServerState;
  readonly logs: readonly TuiLogLine[];
  readonly metrics: Readonly<{ requests: number; errors: number; inflight: number }>;
  readonly update: Readonly<{ available: boolean; latest: string | null }>;
  readonly statusLine: string;
  readonly scrollOffset: number;
}

export function createInitialView(): TuiViewState {
  return {
    server: { state: "unknown", port: 0, pid: undefined, uptimeMs: 0, url: "" },
    logs: [],
    metrics: { requests: 0, errors: 0, inflight: 0 },
    update: { available: false, latest: null },
    statusLine: "connecting to control server…",
    scrollOffset: 0,
  };
}

/**
 * Appends one log line and evicts the oldest past `capacity`.
 *
 * A `slice` on overflow rather than an index-ring keeps the array dense, which
 * the renderer needs: it addresses lines by absolute position from the tail,
 * and a sparse or wrapped buffer would make `scrollOffset` mean two things.
 * The capacity is in the hundreds, so the copy is noise next to the terminal
 * write that follows.
 */
export function reduceLogLine(state: TuiViewState, line: TuiLogLine, capacity: number): TuiViewState {
  const limit = Math.max(1, capacity);
  const next = state.logs.length >= limit ? [...state.logs.slice(state.logs.length - limit + 1), line] : [...state.logs, line];
  return {
    ...state,
    logs: next,
    metrics: {
      ...state.metrics,
      requests: state.metrics.requests + (statusCodeOf(line) === undefined ? 0 : 1),
      errors: state.metrics.errors + (isErrorLine(line) ? 1 : 0),
    },
    // A reader parked at the top of the buffer stays on the same lines when new
    // ones arrive below; a reader following the tail keeps following it.
    scrollOffset: state.scrollOffset > 0 ? Math.min(state.scrollOffset, Math.max(0, next.length - 1)) : 0,
  };
}

const STATUS_CODE = /\b(?:status|statusCode|code)"?\s*[:=]\s*(\d{3})\b/i;
const TRAILING_STATUS = /\b([1-5]\d{2})\b\s*$/;
const ERROR_LEVELS: Record<string, true> = { error: true, fatal: true };

/**
 * Best-effort status extraction from a formatted log line.
 *
 * The TUI is not the gateway's metrics backend; it reads the same lines a
 * human reads. Counting only lines that *carry* a status keeps the request
 * counter from inflating on debug chatter, and a miss degrades to an
 * undercount rather than a wrong number presented as authoritative.
 */
export function statusCodeOf(line: TuiLogLine): number | undefined {
  const tagged = STATUS_CODE.exec(line.text);
  if (tagged) return Number(tagged[1]);
  const trailing = TRAILING_STATUS.exec(line.text);
  return trailing ? Number(trailing[1]) : undefined;
}

/**
 * A line counts as an error when the logger itself said so, or when the status
 * it carries is a server-side failure. A `warn` is deliberately excluded: it
 * is a soft signal (slow provider, retry), and folding it in would make the
 * counter disagree with the gateway's own error metric.
 */
function isErrorLine(line: TuiLogLine): boolean {
  if (ERROR_LEVELS[line.level.toLowerCase()] === true) return true;
  const code = statusCodeOf(line);
  return code !== undefined && code >= 500;
}

/**
 * Moves the viewport by `delta` rows, clamped to what actually exists.
 *
 * The upper bound is `logs.length - visibleRows`, so the topmost reachable
 * offset is the one that puts the oldest line on the first log row; scrolling
 * past it would show blank space above real output. `visibleRows <= 0`
 * collapses to the tail.
 */
export function reduceScroll(state: TuiViewState, delta: number, visibleRows: number): TuiViewState {
  const maxOffset = Math.max(0, state.logs.length - Math.max(0, visibleRows));
  const next = Math.min(maxOffset, Math.max(0, state.scrollOffset + delta));
  return next === state.scrollOffset ? state : { ...state, scrollOffset: next };
}

export function reduceServer(state: TuiViewState, server: TuiServerState): TuiViewState {
  return { ...state, server };
}

/** Fold for the update banner; kept next to the other reducers so the shape stays one object. */
export function reduceUpdate(state: TuiViewState, update: Readonly<{ available: boolean; latest: string | null }>): TuiViewState {
  if (state.update.available === update.available && state.update.latest === update.latest) return state;
  return { ...state, update };
}

export function reduceStatusLine(state: TuiViewState, statusLine: string): TuiViewState {
  return state.statusLine === statusLine ? state : { ...state, statusLine };
}
