// Client for the launcher's loopback control plane.
//
// The gateway cannot install an update. The launcher owns the binary and the
// supervisor, and it is the process that survives the gateway being stopped and
// replaced — so the console's update routes are a proxy: read the handshake the
// launcher publishes in `<installRoot>/run/control.json`, call it with the
// shared bearer token, and shape the answer for the dashboard. The token never
// leaves this module; no browser ever sees it.
//
// Nothing here is cached. The launcher may restart at any time, and it mints a
// fresh port and token each boot, so a handshake held across requests would
// point at a socket nobody owns. Every call re-reads the file.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Header carrying the launcher's bearer token. */
const CONTROL_TOKEN_HEADER = "x-lianrouter-control";
const REQUEST_TIMEOUT_MS = 5_000;

/** The port/token pair the launcher publishes. */
export interface LauncherHandshake {
  readonly port: number;
  readonly token: string;
}

/** One progress sample, as the launcher recorded it. */
export interface LauncherProgress {
  readonly phase: string;
  readonly percent: number;
  readonly message: string;
  readonly bytesReceived: number | null;
  readonly bytesTotal: number | null;
  readonly error: string | null;
}

/** The last update check the launcher performed. */
export interface LauncherSnapshot {
  readonly current: string;
  readonly latest: string;
  readonly available: boolean;
  readonly notesUrl: string | null;
  readonly publishedAt: string | null;
}

/** `GET /update/state` on the control plane. */
export interface LauncherUpdateState {
  readonly snapshot: LauncherSnapshot | null;
  readonly progress: LauncherProgress | null;
  readonly running: boolean;
}

/**
 * Outcome of one control call. `status` is the launcher's HTTP status, or
 * `undefined` when the request never reached it (dead port, timeout).
 */
export type LauncherCall<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number | undefined; readonly error: string };

/**
 * Reads and validates `run/control.json`.
 *
 * The file is plain JSON in a user-writable directory, so every field is
 * untrusted — the same posture the tray takes, restated here because `cli/` is a
 * separate package that the gateway's tsconfig does not include. A malformed
 * field is `undefined` rather than an exception: "no launcher attached" is a
 * normal state the console reports, not a failure it logs.
 */
export async function readLauncherHandshake(home: string): Promise<LauncherHandshake | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(home, "run", "control.json"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const port = record["port"];
  const token = record["token"];
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return undefined;
  }
  if (typeof token !== "string" || token.length === 0) {
    return undefined;
  }
  // `pid` and `startedAt` are validated by the tray, which needs them to decide
  // whether the file describes a live launcher. This client only dials the port,
  // so their absence changes nothing about the request it makes.
  return { port, token };
}

function readProgress(value: unknown): LauncherProgress | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const phase = record["phase"];
  const percent = record["percent"];
  const message = record["message"];
  if (typeof phase !== "string" || typeof percent !== "number" || typeof message !== "string") {
    return null;
  }
  const bytesReceived = record["bytesReceived"];
  const bytesTotal = record["bytesTotal"];
  const error = record["error"];
  return {
    phase,
    percent,
    message,
    bytesReceived: typeof bytesReceived === "number" ? bytesReceived : null,
    bytesTotal: typeof bytesTotal === "number" ? bytesTotal : null,
    error: typeof error === "string" ? error : null,
  };
}

function readSnapshot(value: unknown): LauncherSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const current = record["current"];
  const latest = record["latest"];
  const available = record["available"];
  if (typeof current !== "string" || typeof latest !== "string" || typeof available !== "boolean") {
    return null;
  }
  const notesUrl = record["notesUrl"];
  const publishedAt = record["publishedAt"];
  return {
    current,
    latest,
    available,
    notesUrl: typeof notesUrl === "string" ? notesUrl : null,
    publishedAt: typeof publishedAt === "string" ? publishedAt : null,
  };
}

/**
 * Reads the launcher's durable update state.
 *
 * A malformed body is reported as a launcher failure rather than silently
 * degraded to "no update": the console showing "up to date" because the
 * launcher answered something unparseable would be a lie about the state of the
 * installation.
 */
export async function fetchLauncherUpdateState(
  handshake: LauncherHandshake,
): Promise<LauncherCall<LauncherUpdateState>> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${handshake.port}/update/state`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { [CONTROL_TOKEN_HEADER]: handshake.token, accept: "application/json" },
    });
  } catch (error) {
    return { ok: false, status: undefined, error: describeFailure(error) };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    return { ok: false, status: response.status, error: readErrorMessage(body, response.status) };
  }
  if (typeof body !== "object" || body === null) {
    return { ok: false, status: response.status, error: "the launcher returned a non-object update state" };
  }
  const record = body as Record<string, unknown>;
  const running = record["running"];
  if (typeof running !== "boolean") {
    return { ok: false, status: response.status, error: "the launcher returned no usable running flag" };
  }
  return {
    ok: true,
    data: {
      snapshot: readSnapshot(record["snapshot"]),
      progress: readProgress(record["progress"]),
      running,
    },
  };
}

/**
 * Asks the launcher to start the update flow.
 *
 * The launcher answers `202` when it accepted the work and `409` when a flow is
 * already in progress; both are passed through with their status so the route
 * can map them to the console's own vocabulary.
 */
export async function startLauncherUpdate(
  handshake: LauncherHandshake,
): Promise<LauncherCall<null>> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${handshake.port}/update/start`, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { [CONTROL_TOKEN_HEADER]: handshake.token, accept: "application/json" },
    });
  } catch (error) {
    return { ok: false, status: undefined, error: describeFailure(error) };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    return { ok: false, status: response.status, error: readErrorMessage(body, response.status) };
  }
  return { ok: true, data: null };
}

function readErrorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const error = (body as Record<string, unknown>)["error"];
    if (typeof error === "string" && error.length > 0) return error;
  }
  return `the launcher answered ${status}`;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return `the launcher did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`;
    }
    return error.message;
  }
  return String(error);
}
