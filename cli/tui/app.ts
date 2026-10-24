/**
 * Interactive console for a running gateway.
 *
 * ## Why this talks to the loopback control server instead of importing the
 * ## supervisor
 *
 * The console may run in a different process from the supervisor — with the
 * tray host in play, the tray owns the child process and the TUI is just
 * another client. Importing the supervisor directly would create a second,
 * conflicting owner of lifecycle: two restart paths, two pid files, two ideas
 * of what "running" means. The control server is the single owner. Every
 * action here is an HTTP call to it, so restart/stop/update behave identically
 * whether the TUI, the tray menu, or a script triggered them.
 *
 * ## Data sources
 *
 * - **Logs** are tailed by byte offset from `ctx.logFile`. `Bun.file().stream()`
 *   does not follow a growing file, and `fs.watch` would need a partial-line
 *   buffer plus platform-specific behaviour for a writer that may be another
 *   process and may rotate the file. Polling a byte offset every 250ms is
 *   cheaper to reason about and portable; a rotation shows up as a shrunken
 *   file and simply resets the offset.
 * - **Server state** comes from `GET /status` on the control server once a
 *   second, which also carries the update banner.
 * - **Counters** are derived from log lines that carry a status code. They are
 *   an approximation of the gateway's own metrics, deliberately not a second
 *   source of truth: reading real metrics would need a backend dependency this
 *   single-file binary does not ship.
 *
 * ## Redraw
 *
 * The frame is rebuilt at most every 100ms (10fps) and written only when its
 * signature changed. Repainting a 50-row terminal at 60fps is visible flicker
 * on Windows and burns CPU for a screen where only the clock moves.
 */

import { open, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { moveTo, terminalSize, withTerminal } from "./terminal";
import { flushPending, parseKeys, type TuiKey } from "./input";
import { frameSignature, renderView } from "./render";
import { CLI_VERSION } from "../src/version";
import { resolveControlFile, resolveLogFile } from "../src/paths";
import {
  createInitialView,
  reduceLogLine,
  reduceScroll,
  reduceServer,
  reduceStatusLine,
  reduceUpdate,
  type TuiLogLine,
  type TuiServerState,
  type TuiViewState,
} from "./state";

export interface TuiContext {
  readonly port: number;
  readonly controlUrl: string;
  readonly controlToken: string;
  readonly version: string;
  readonly logFile: string;
}

interface LogChunk {
  readonly text: string;
  readonly offset: number;
}

interface StatusPayload {
  readonly state?: unknown;
  readonly port?: unknown;
  readonly pid?: unknown;
  readonly startedAt?: unknown;
  readonly uptimeMs?: unknown;
  readonly url?: unknown;
  readonly update?: { readonly available?: unknown; readonly latest?: unknown } | null;
}

/** Log ring capacity: deep enough for a burst, shallow enough to stay cheap. */
const LOG_CAPACITY = 500;
/** A single line longer than this is clipped before it enters the ring. */
const MAX_LINE_LENGTH = 2000;
const LOG_POLL_MS = 250;
const STATUS_POLL_MS = 1000;
const REDRAW_MS = 100;
const ESCAPE_TIMEOUT_MS = 30;

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readServer(payload: StatusPayload, ctx: TuiContext): TuiServerState {
  // The supervisor reports `startedAt`, not a running uptime; deriving it here
  // keeps the clock moving between polls instead of freezing at the last value.
  const startedAt = typeof payload.startedAt === "number" && Number.isFinite(payload.startedAt) ? payload.startedAt : undefined;
  const reportedUptime = typeof payload.uptimeMs === "number" && Number.isFinite(payload.uptimeMs) ? payload.uptimeMs : undefined;
  return {
    state: typeof payload.state === "string" ? payload.state : "running",
    port: toNumber(payload.port, ctx.port),
    pid: typeof payload.pid === "number" && Number.isFinite(payload.pid) ? payload.pid : undefined,
    uptimeMs: reportedUptime ?? (startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt)),
    url: typeof payload.url === "string" ? payload.url : ctx.controlUrl,
  };
}

/**
 * Maps one raw log line to the ring shape.
 *
 * The gateway's file log is pino JSON; a pino-pretty line is not. Both go
 * through the same fallback chain: try JSON and read `level`/`msg`/`time` when
 * that shape is present, otherwise treat the raw text as an `info` line
 * stamped with the parse time. Guessing wrong costs a level colour, never a
 * dropped line.
 */
function toLogLine(raw: string, now: number): TuiLogLine {
  const text = raw.length > MAX_LINE_LENGTH ? raw.slice(0, MAX_LINE_LENGTH) : raw;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        const level = typeof record.level === "string" ? record.level : typeof record.level === "number" ? String(record.level) : "info";
        const message = typeof record.msg === "string" ? record.msg : typeof record.message === "string" ? record.message : trimmed;
        const time = typeof record.time === "string" ? Date.parse(record.time) : typeof record.time === "number" ? record.time : now;
        return { at: Number.isFinite(time) ? time : now, level, text: message };
      }
    } catch {
      // A truncated or non-JSON line is still worth showing verbatim.
    }
  }
  const pretty = /^\[?([A-Z]{4,5})\]?\s+(.*)$/.exec(trimmed);
  if (pretty !== null && pretty[1] !== undefined && pretty[2] !== undefined) {
    return { at: now, level: pretty[1].toLowerCase(), text: pretty[2] };
  }
  return { at: now, level: "info", text: trimmed };
}

async function fetchStatus(ctx: TuiContext): Promise<StatusPayload | undefined> {
  try {
    const response = await fetch(`${ctx.controlUrl}/status`, {
      headers: { "x-lianrouter-control": ctx.controlToken },
      signal: AbortSignal.timeout(900),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as StatusPayload) : undefined;
  } catch {
    return undefined;
  }
}

async function postControl(ctx: TuiContext, path: string): Promise<boolean> {
  try {
    const response = await fetch(`${ctx.controlUrl}${path}`, {
      method: "POST",
      headers: { "x-lianrouter-control": ctx.controlToken },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Reads only the bytes appended since `offset`.
 *
 * A file shorter than `offset` was rotated or truncated, so the read restarts
 * at zero instead of seeking past the end of the replacement file and showing
 * nothing forever.
 */
async function readNewBytes(path: string, offset: number): Promise<LogChunk> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { text: "", offset };
  }
  const start = size < offset ? 0 : offset;
  if (size === start) return { text: "", offset: size };

  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return { text: "", offset: start };
  }
  try {
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), offset: start + bytesRead };
  } finally {
    await handle.close();
  }
}

function isQuitKey(key: TuiKey): boolean {
  return key.type === "ctrl-c" || (key.type === "char" && (key.char === "q" || key.char === "Q"));
}

export default async function runTui(ctx: TuiContext): Promise<void> {
  if (!process.stdin.isTTY) {
    process.stdout.write("terminal UI requires an interactive terminal\n");
    return;
  }
  await withTerminal(async () => {
    let view: TuiViewState = reduceStatusLine(createInitialView(), "waiting for gateway status…");
    let logOffset = 0;
    let partialLine = "";
    let pendingInput: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let lastSignature = "";
    let escapeTimer: ReturnType<typeof setTimeout> | undefined;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const paint = (force: boolean): void => {
      const frame = renderView(view, terminalSize(), { color: true });
      const signature = frameSignature(frame);
      if (!force && signature === lastSignature) return;
      lastSignature = signature;
      // One write per frame with the cursor homed first: the alternate screen
      // has no scrollback, so a partially written frame leaves torn rows that
      // the next frame only partly overwrites.
      process.stdout.write(moveTo(1, 1) + frame.map((line) => `${line}\x1b[K`).join("\r\n"));
    };

    const sendAction = (path: string, pending: string, ok: string, failed: string): void => {
      view = reduceStatusLine(view, pending);
      void postControl(ctx, path).then((succeeded) => {
        view = reduceStatusLine(view, succeeded ? ok : failed);
      });
    };

    const applyKeys = (keys: readonly TuiKey[]): void => {
      const visibleRows = Math.max(1, terminalSize().rows - 6);
      for (const key of keys) {
        if (isQuitKey(key)) {
          finish();
          return;
        }
        switch (key.type) {
          case "up":
            view = reduceScroll(view, 1, visibleRows);
            break;
          case "down":
            view = reduceScroll(view, -1, visibleRows);
            break;
          case "pageup":
            view = reduceScroll(view, visibleRows, visibleRows);
            break;
          case "pagedown":
            view = reduceScroll(view, -visibleRows, visibleRows);
            break;
          case "home":
            view = reduceScroll(view, Number.MAX_SAFE_INTEGER, visibleRows);
            break;
          case "end":
          case "escape":
            view = reduceScroll(view, -Number.MAX_SAFE_INTEGER, visibleRows);
            break;
          case "char": {
            const char = key.char.toLowerCase();
            if (char === "r") sendAction("/server/restart", "restart requested…", "restart requested", "restart failed: control server unreachable");
            else if (char === "s") sendAction("/server/stop", "stop requested…", "gateway stopping", "stop failed: control server unreachable");
            else if (char === "o") sendAction("/open-web", "opening web console…", "web console opened", "could not open web console");
            else if (char === "u") sendAction("/update/start", "starting update…", "update started", "update failed: control server unreachable");
            break;
          }
          default:
            break;
        }
      }
    };

    const onData = (chunk: Buffer): void => {
      pendingInput = Buffer.concat([pendingInput, chunk]);
      const parsed = parseKeys(pendingInput);
      pendingInput = parsed.pending;
      clearTimeout(escapeTimer);
      escapeTimer = undefined;
      if (pendingInput.length > 0) {
        // A lone ESC is indistinguishable from the first byte of a sequence
        // until the next read arrives; after the timeout it is Escape, which
        // is how a terminal behaves without blocking on a bare ESC press.
        escapeTimer = setTimeout(() => {
          const resolved = flushPending(pendingInput);
          pendingInput = Buffer.alloc(0);
          applyKeys([resolved]);
        }, ESCAPE_TIMEOUT_MS);
      }
      applyKeys(parsed.keys);
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);

    const logTimer = setInterval(() => {
      void readNewBytes(ctx.logFile, logOffset).then((chunk) => {
        logOffset = chunk.offset;
        if (chunk.text.length === 0) return;
        const lines = (partialLine + chunk.text).split("\n");
        partialLine = lines.pop() ?? "";
        const now = Date.now();
        for (const raw of lines) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (line.length === 0) continue;
          view = reduceLogLine(view, toLogLine(line, now), LOG_CAPACITY);
        }
      });
    }, LOG_POLL_MS);

    const statusTimer = setInterval(() => {
      void fetchStatus(ctx).then((payload) => {
        if (payload === undefined) {
          view = reduceServer(view, { ...view.server, state: "unreachable" });
          view = reduceStatusLine(view, "control server unreachable");
          return;
        }
        view = reduceServer(view, readServer(payload, ctx));
        view = reduceUpdate(view, {
          available: payload.update?.available === true,
          latest: typeof payload.update?.latest === "string" ? payload.update.latest : null,
        });
        view = reduceStatusLine(view, "");
      });
    }, STATUS_POLL_MS);

    const redrawTimer = setInterval(() => paint(false), REDRAW_MS);
    paint(true);

    await done;

    clearInterval(logTimer);
    clearInterval(statusTimer);
    clearInterval(redrawTimer);
    clearTimeout(escapeTimer);
    process.stdin.off("data", onData);
    process.stdin.pause();
    process.stdin.setRawMode(false);
  });
}

/**
 * Reads the handshake the control server writes when the gateway starts:
 * `{ port, pid, startedAt, token }`. Missing or unreadable means "no gateway
 * is running", which the caller reports instead of guessing a port — a guessed
 * port would connect to whatever else happens to be listening.
 */
function readControlHandshake(): { readonly port: number; readonly token: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolveControlFile(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const port = typeof record.port === "number" && Number.isFinite(record.port) ? record.port : undefined;
    const token = typeof record.token === "string" && record.token.length > 0 ? record.token : undefined;
    return port === undefined || token === undefined ? undefined : { port, token };
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  if (!process.stdin.isTTY) {
    process.stdout.write("terminal UI requires an interactive terminal\n");
  } else {
    const handshake = readControlHandshake();
    if (handshake === undefined) {
      process.stderr.write("no running gateway: control handshake not found. Start the gateway first.\n");
      process.exitCode = 1;
    } else {
      await runTui({
        port: handshake.port,
        controlUrl: `http://127.0.0.1:${handshake.port}`,
        controlToken: handshake.token,
        version: CLI_VERSION,
        logFile: resolveLogFile(),
      });
    }
  }
}
