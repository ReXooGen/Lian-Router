/**
 * Raw ANSI terminal toolkit for the interactive console.
 *
 * No renderer dependency: the CLI ships as one compiled binary and a React
 * reconciler (or any layout engine) would be dead weight for a screen that is
 * a header, a scrolling tail, and a key bar. Everything here is a string the
 * caller writes; nothing paints on its own except `withTerminal`, which owns
 * the alternate screen for the duration of a run.
 */

const ESC = "\x1b";

/** Alternate screen buffer: the user's shell history survives the TUI. */
export function enterAltScreen(): void {
  write(`${ESC}[?1049h`);
}

export function exitAltScreen(): void {
  write(`${ESC}[?1049l`);
}

export function hideCursor(): void {
  write(`${ESC}[?25l`);
}

export function showCursor(): void {
  write(`${ESC}[?25h`);
}

/** 1-based cursor addressing; ANSI rows/columns start at 1, not 0. */
export function moveTo(row: number, col: number): string {
  return `${ESC}[${Math.max(1, Math.floor(row))};${Math.max(1, Math.floor(col))}H`;
}

/** Erase from the cursor to the end of the current line. */
export function clearLine(): string {
  return `${ESC}[K`;
}

export function clearScreen(): string {
  return `${ESC}[2J`;
}

function write(text: string): void {
  process.stdout.write(text);
}

export interface TerminalSize {
  readonly rows: number;
  readonly cols: number;
}

/**
 * The terminal's current geometry. `process.stdout.columns/rows` are absent
 * when stdout is a pipe or a file, so the 80x24 fallback keeps the renderer
 * from producing a zero-width frame and dividing by zero downstream.
 */
export function terminalSize(): TerminalSize {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  return {
    rows: typeof rows === "number" && rows > 0 ? rows : 24,
    cols: typeof cols === "number" && cols > 0 ? cols : 80,
  };
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-Z\\-_]/g;

/** Strips CSI/OSC/Fe sequences so they never count as printable cells. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x0e31 && cp <= 0x0e3a) ||
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x1160 && cp <= 0x11ff) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x2060 ||
    cp === 0xfeff
  );
}

/**
 * East Asian Wide/Fullwidth plus the emoji blocks. Ambiguous-width characters
 * (U+00A0..U+FF60 aside from the ranges below) are counted as one cell, which
 * matches every modern terminal's default `ambiguous-width: narrow` setting.
 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f004 && cp <= 0x1f004) ||
    (cp >= 0x1f0cf && cp <= 0x1f0cf) ||
    (cp >= 0x1f18e && cp <= 0x1f18e) ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f320) ||
    (cp >= 0x1f32d && cp <= 0x1f335) ||
    (cp >= 0x1f337 && cp <= 0x1f37c) ||
    (cp >= 0x1f37e && cp <= 0x1f393) ||
    (cp >= 0x1f3a0 && cp <= 0x1f3ca) ||
    (cp >= 0x1f3cf && cp <= 0x1f3d3) ||
    (cp >= 0x1f3e0 && cp <= 0x1f3f0) ||
    (cp >= 0x1f3f4 && cp <= 0x1f3f4) ||
    (cp >= 0x1f3f8 && cp <= 0x1f43e) ||
    (cp >= 0x1f440 && cp <= 0x1f440) ||
    (cp >= 0x1f442 && cp <= 0x1f4fc) ||
    (cp >= 0x1f4ff && cp <= 0x1f53d) ||
    (cp >= 0x1f54b && cp <= 0x1f54e) ||
    (cp >= 0x1f550 && cp <= 0x1f567) ||
    (cp >= 0x1f57a && cp <= 0x1f57a) ||
    (cp >= 0x1f595 && cp <= 0x1f596) ||
    (cp >= 0x1f5a4 && cp <= 0x1f5a4) ||
    (cp >= 0x1f5fb && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6c5) ||
    (cp >= 0x1f6cc && cp <= 0x1f6cc) ||
    (cp >= 0x1f6d0 && cp <= 0x1f6d2) ||
    (cp >= 0x1f6eb && cp <= 0x1f6ec) ||
    (cp >= 0x1f6f4 && cp <= 0x1f6fc) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f90c && cp <= 0x1f93a) ||
    (cp >= 0x1f93c && cp <= 0x1f945) ||
    (cp >= 0x1f947 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Display cells occupied by `text`, not its `String.length`.
 *
 * A CJK glyph or an emoji is two cells in every terminal that renders it, so
 * `length` under-counts and a "fits" line overflows into the next row. In a
 * fixed-height viewport that overflow wraps the frame and pushes the key bar
 * off-screen, which is why every clip and pad in the TUI goes through here.
 * ANSI sequences are stripped first: they occupy no cells.
 */
export function displayWidth(text: string): number {
  const plain = stripAnsi(text);
  let width = 0;
  let joined = false;
  for (const char of plain) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0x200d) {
      // Zero-width joiner: the next glyph belongs to the same emoji cluster,
      // and the cluster's width was already charged to its first glyph.
      joined = true;
      continue;
    }
    if (isCombining(cp)) continue;
    if (joined) {
      joined = false;
      continue;
    }
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Clips `text` to at most `width` display cells.
 *
 * The clip is applied per code point and never splits a wide glyph in half:
 * a CJK character that would straddle the edge is dropped and the leftover
 * cell is left for the caller to pad. No ellipsis is appended — the frame's
 * own padding already signals the cut, and an extra glyph would change the
 * width contract the caller depends on.
 */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const plain = stripAnsi(text);
  if (displayWidth(plain) <= width) return plain;
  let used = 0;
  let out = "";
  let joined = false;
  for (const char of plain) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0x200d) {
      joined = true;
      out += char;
      continue;
    }
    const cells = isCombining(cp) || joined ? 0 : isWide(cp) ? 2 : 1;
    if (used + cells > width) break;
    joined = false;
    used += cells;
    out += char;
  }
  return out;
}

/** Right-pads to exactly `width` cells, clipping first when needed. */
export function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

type ExitHandler = () => void;

/**
 * Runs `fn` inside the alternate screen with the cursor hidden and raw mode
 * on, and restores all three on *every* exit path.
 *
 * A terminal left in the alternate screen with raw mode enabled is unusable
 * after the process dies: the shell echoes nothing and the user has to run
 * `reset`. So restoration is registered on `exit`, on uncaught exceptions and
 * unhandled rejections, and on SIGINT/SIGTERM/SIGHUP — not only on the happy
 * path. The handlers are removed in `finally` so a long-lived host process
 * does not accumulate one set per TUI session.
 */
export async function withTerminal<T>(fn: () => Promise<T>): Promise<T> {
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // A stdin that vanished mid-run (closed pty) cannot be un-raw'd; the
        // escape sequences below are still worth writing.
      }
    }
    write(`${ESC}[?25h${ESC}[?1049l`);
  };

  const onExit: ExitHandler = restore;
  const onFatal = (error: unknown): void => {
    restore();
    // The error must land after the screen is restored or it is written into
    // a buffer that is about to be discarded.
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    restore();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");
  const onSighup = (): void => onSignal("SIGHUP");

  process.on("exit", onExit);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  enterAltScreen();
  hideCursor();
  write(clearScreen() + moveTo(1, 1));

  try {
    return await fn();
  } finally {
    process.off("exit", onExit);
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    restore();
  }
}
