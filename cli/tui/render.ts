/**
 * Frame renderer for the terminal console.
 *
 * `renderView` is pure: it returns the exact lines to paint and performs no
 * writes, so a frame can be asserted in tests and diffed by the redraw
 * throttle. The caller joins with `\r\n` and writes once — a partial write
 * leaves the terminal mid-line and tears the box.
 *
 * Width discipline is the whole game. Every emitted line is exactly `cols`
 * display cells once ANSI is stripped: one overflowing line wraps, shifts the
 * whole fixed-height viewport, and pushes the key bar off-screen. Height is the
 * same contract: the frame is exactly `rows` lines, so the log area is
 * `rows - 6` — the title, the status row, the two rules, the key bar, and the
 * bottom border.
 */

import type { TuiLogLine, TuiViewState } from "./state";
import { displayWidth, padToWidth, truncateToWidth } from "./terminal";

export interface RenderOptions {
  /** False emits no escape sequences at all, so tests assert on plain text. */
  readonly color?: boolean;
  /** Version shown right-aligned in the title bar. */
  readonly version?: string;
}

const SGR_RESET = "\x1b[0m";

/** Level → SGR open sequence. Unlisted levels render in the terminal default. */
const LEVEL_SGR: Record<string, string> = {
  debug: "\x1b[2m",
  trace: "\x1b[2m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[1;31m",
};

const MIN_LOG_ROWS = 3;
/** Title, status, log rule, footer rule, key bar, bottom border. */
const CHROME_ROWS = 6;
const MIN_COLS = 20;

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Full-width content row: `│ content … │`, padded to `cols` cells. */
function row(content: string, cols: number, color: boolean, sgr?: string): string {
  const inner = cols - 4;
  if (inner <= 0) return padToWidth(content, cols);
  const body = padToWidth(content, inner);
  const painted = color && sgr !== undefined ? `${sgr}${body}${SGR_RESET}` : body;
  return `│ ${painted} │`;
}

/**
 * Full-width rule with optional inline labels: `├ Logs ────── uptime … ┤`.
 *
 * The fill absorbs whatever the labels leave, so the closing corner always
 * lands on the last column. When the labels alone exceed the width the tail is
 * dropped rather than allowed to push the corner off the line.
 */
function rule(cols: number, left: string, right: string, head = "", tail = ""): string {
  const inner = Math.max(0, cols - 2);
  const headText = head.length > 0 ? ` ${head} ` : "";
  const tailText = tail.length > 0 ? ` ${tail} ` : "";
  const headWidth = displayWidth(headText);
  const tailWidth = displayWidth(tailText);
  if (headWidth + tailWidth > inner) {
    const kept = truncateToWidth(headText, inner);
    return left + kept + "─".repeat(Math.max(0, inner - displayWidth(kept))) + right;
  }
  return left + headText + "─".repeat(inner - headWidth - tailWidth) + tailText + right;
}

function levelTag(level: string): string {
  return level.slice(0, 5).toUpperCase().padEnd(5, " ");
}

function renderLogRow(line: TuiLogLine, cols: number, color: boolean): string {
  const inner = cols - 4;
  const prefix = `${formatClock(line.at)} ${levelTag(line.level)} `;
  const body = truncateToWidth(line.text, Math.max(0, inner - displayWidth(prefix)));
  return row(prefix + body, cols, color, LEVEL_SGR[line.level.toLowerCase()]);
}

/**
 * The visible log window, always exactly `height` rows.
 *
 * `scrollOffset` counts rows back from the tail: 0 follows the newest line and
 * the clamped maximum puts the oldest line on the first log row. Empty rows
 * below the tail keep the footer fixed, which is what makes the frame diffable
 * across redraws.
 */
function renderLogRows(state: TuiViewState, height: number, cols: number, color: boolean): string[] {
  const end = Math.max(0, state.logs.length - state.scrollOffset);
  const start = Math.max(0, end - height);
  const rows = state.logs.slice(start, end).map((line) => renderLogRow(line, cols, color));
  while (rows.length < height) rows.push(row("", cols, color));
  return rows;
}

export function renderView(state: TuiViewState, size: { rows: number; cols: number }, options: RenderOptions = {}): string[] {
  const color = options.color === true;
  const cols = Math.max(MIN_COLS, Math.floor(size.cols));
  const rows = Math.max(CHROME_ROWS + MIN_LOG_ROWS, Math.floor(size.rows));
  const logHeight = rows - CHROME_ROWS;
  const { server } = state;

  const titleHead = "┌ LianRouter ";
  const titleTail = ` ${`v${options.version ?? "2.0.0"}`} ┐`;
  const title = titleHead + "─".repeat(Math.max(0, cols - displayWidth(titleHead) - displayWidth(titleTail))) + titleTail;

  const status = [`${server.state === "running" ? "●" : "○"} ${server.state}`, server.url.length > 0 ? server.url : "control server offline"];
  if (server.pid !== undefined) status.push(`pid ${server.pid}`);
  if (state.statusLine.length > 0) status.push(state.statusLine);

  const counters = `uptime ${formatDuration(server.uptimeMs)}   requests ${state.metrics.requests.toLocaleString("en-US")}   errors ${state.metrics.errors.toLocaleString("en-US")}`;
  const updateTail = state.update.available && state.update.latest !== null ? `   ↑ ${state.update.latest}` : "";
  const hints = "r restart  s stop  o open web  u update  q quit";
  const scrollNote = state.scrollOffset > 0 ? `   [scrolled ${state.scrollOffset}]` : "";

  return [
    padToWidth(title, cols),
    row(status.join("   "), cols, color),
    rule(cols, "├", "┤", "Logs", `${counters}${updateTail}`),
    ...renderLogRows(state, logHeight, cols, color),
    rule(cols, "├", "┤"),
    row(`${hints}${scrollNote}`, cols, color),
    rule(cols, "└", "┘"),
  ];
}

/**
 * Cheap change detector for the redraw loop.
 *
 * Comparing rendered frames is the only signature that cannot drift from what
 * is on screen: a counter bump the renderer truncates away must not repaint,
 * and a status-line edit must. The frame is a few kilobytes, so hashing it
 * costs far less than a terminal write.
 */
export function frameSignature(frame: readonly string[]): string {
  let hash = 2166136261;
  for (const line of frame) {
    for (let index = 0; index < line.length; index += 1) {
      hash ^= line.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 10;
    hash = Math.imul(hash, 16777619);
  }
  return `${frame.length}:${(hash >>> 0).toString(36)}`;
}
