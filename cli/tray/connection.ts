/**
 * Resolving the launcher's control endpoint, and recovering when it moves.
 *
 * The handshake in `run/control.json` is not a stable address: `ControlServer`
 * binds `port: 0` and mints a new token on every `start()`, so a launcher
 * restart invalidates both values. A tray that read the file once and kept the
 * client would answer every later click with "could not reach the control port"
 * while a perfectly healthy launcher sat on a different port.
 *
 * So the tray never holds a client. It resolves one per action, and on a
 * connection-shaped failure it re-reads the handshake and retries once. That
 * covers the two cases the operator actually hits — launcher restarted, and
 * launcher gone — and keeps them distinct: a missing file or a dead pid is
 * reported as such, not as a generic network error.
 */

import { readFileSync } from "node:fs";
import { createControlClient } from "./control-client";
import type { ControlClient, ControlResult } from "./control-client";
import { ControlFileError, controlFilePath, readControlFile } from "./paths";
import type { ControlFile } from "./paths";
import { resurrectLauncher } from "./resurrect";
import type { ResurrectionDeps } from "./resurrect";

/** A client plus the handshake it was built from. */
export interface ControlConnection {
  readonly client: ControlClient;
  readonly handshake: ControlFile;
  /** Identity of the endpoint; two resolutions with the same key are the same launcher. */
  readonly key: string;
}

export type ConnectionResult =
  | { readonly ok: true; readonly connection: ControlConnection }
  | { readonly ok: false; readonly error: string };

/**
 * Failure texts that mean "the endpoint moved" rather than "the request was
 * wrong".
 *
 * The client produces these from `describeFailure` and from the 401 branch. A
 * 401 belongs here because a restarted launcher mints a new token: the old
 * token is rejected by the new server, which is indistinguishable from a stale
 * endpoint until the handshake is re-read.
 */
const CONNECTION_FAILURES: readonly string[] = [
  "Could not reach the CLI control port",
  "did not answer within",
  "missing or invalid control token",
];

export function isConnectionFailure(error: string): boolean {
  return CONNECTION_FAILURES.some((marker) => error.includes(marker));
}

/** True when the pid names a live process this user can signal. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the handshake and builds a client for it.
 *
 * Deliberately not cached. A menu click is not a hot path, and the whole bug
 * this module exists to fix came from caching a value that the launcher is free
 * to change. The `key` is returned for callers that want to compare two
 * resolutions, not so they can skip the read.
 */
export function resolveControlConnection(installRoot: string): ConnectionResult {
  let handshake: ControlFile;
  try {
    handshake = readControlFile(installRoot);
  } catch (error) {
    if (error instanceof ControlFileError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: `Could not read ${controlFilePath(installRoot)}: ${String(error)}` };
  }

  // A handshake can outlive the launcher that wrote it: a forced kill removes
  // neither `run/control.json` nor `run/lianrouter.pid`. Without this check the
  // tray would retry a dead port and report a network error instead of naming
  // the actual condition.
  if (!isProcessAlive(handshake.pid)) {
    return {
      ok: false,
      error:
        `The launcher recorded in ${controlFilePath(installRoot)} is not running (pid ${handshake.pid}). ` +
        "Start it again with `lianrouter`, then use the tray from its menu.",
    };
  }

  return {
    ok: true,
    connection: {
      client: createControlClient(handshake.port, handshake.token),
      handshake,
      key: `${handshake.port}:${handshake.token}`,
    },
  };
}

/**
 * Runs one control call, re-resolving and retrying once on a connection failure.
 *
 * The retry is capped at one attempt on purpose: a second failure means the
 * launcher is genuinely unreachable, and repeating the call would only delay
 * the dialog the operator needs. When the retry resolves a different endpoint
 * the call is repeated against it; when it resolves the same endpoint there is
 * nothing to retry, so the original failure is returned unchanged.
 */
export async function callWithReconnect<T>(
  installRoot: string,
  call: (client: ControlClient) => Promise<ControlResult<T>>,
): Promise<ControlResult<T>> {
  const first = resolveControlConnection(installRoot);
  if (!first.ok) return { ok: false, error: first.error };

  const result = await call(first.connection.client);
  if (result.ok || !isConnectionFailure(result.error)) return result;

  const second = resolveControlConnection(installRoot);
  if (!second.ok) return { ok: false, error: second.error };
  if (second.connection.key === first.connection.key) return result;

  return call(second.connection.client);
}

/** Why a call needed (or failed to get) a resurrection. */
export type RecoveredFailure =
  | { readonly kind: "none" }
  | { readonly kind: "resurrected" }
  | { readonly kind: "failed"; readonly message: string };

export interface CallRecoveringOptions {
  readonly installRoot: string;
  /** Passed to `resolveLauncherCommand`; production passes `import.meta.dir`. */
  readonly startDir: string;
  readonly call: (client: ControlClient) => Promise<ControlResult<unknown>>;
  /** Gateway port to reuse on resurrection; keeps an open console tab valid. */
  readonly gatewayPort?: number;
  /** Injected so tests drive the spawn and the clock. */
  readonly deps: Omit<ResurrectionDeps, "installRoot" | "startDir" | "gatewayPort">;
}

/**
 * Runs a call, and if the launcher is gone, brings one back and tries again.
 *
 * The order matters: reconnect first (cheap, covers a launcher that merely
 * restarted onto a new port), and only then resurrect. A resurrection is
 * visible to the operator — a new process appears — so it must not be the first
 * response to a transient blip.
 *
 * The returned error text is deliberately specific. "Could not reach the
 * control port" is what made the original failure hard to diagnose: it is true
 * of a dead launcher, a closed port, and a stale handshake alike, and it names
 * none of them.
 */
export async function callRecovering(
  options: CallRecoveringOptions,
): Promise<{ readonly result: ControlResult<unknown>; readonly recovery: RecoveredFailure }> {
  const direct = await callWithReconnect(options.installRoot, options.call);
  if (direct.ok) return { result: direct, recovery: { kind: "none" } };

  const resolved = resolveControlConnection(options.installRoot);
  const launcherAlive = resolved.ok ? true : !resolved.error.includes("is not running");
  if (launcherAlive) {
    // The launcher answers for its own pid, so this is a real request failure
    // (or a live launcher that is not listening) — not a resurrection case.
    return { result: direct, recovery: { kind: "none" } };
  }

  const stalePid = resolved.ok ? resolved.connection.handshake.pid : readStalePid(options.installRoot);
  const resurrected = await resurrectLauncher(
    {
      ...options.deps,
      installRoot: options.installRoot,
      startDir: options.startDir,
      ...(options.gatewayPort === undefined ? {} : { gatewayPort: options.gatewayPort }),
    },
    stalePid,
  );

  if (resurrected.kind === "started") {
    const retried = await callWithReconnect(options.installRoot, options.call);
    if (retried.ok) return { result: retried, recovery: { kind: "resurrected" } };
    return {
      result: { ok: false, error: `The launcher restarted but the action still failed: ${retried.error}` },
      recovery: { kind: "resurrected" },
    };
  }

  const where = resurrected.kind === "failed" ? resurrected.command : undefined;
  const target = where === undefined ? "the launcher" : where.file;
  const detail = resurrected.kind === "skipped" ? resurrected.reason : resurrected.reason;
  return {
    result: {
      ok: false,
      error:
        `The launcher is not running, and it could not be restarted (${target}: ${detail}). ` +
        "The gateway may still be serving — try Open Console, or run `lianrouter` in a terminal.",
    },
    recovery: { kind: "failed", message: detail },
  };
}

/** Best-effort read of a dead handshake's pid, for the error text and the wait. */
function readStalePid(installRoot: string): number | undefined {
  try {
    const raw = readFileSync(controlFilePath(installRoot), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "pid" in parsed && typeof parsed.pid === "number") {
      return parsed.pid;
    }
  } catch {
    // Missing or malformed: nothing to compare against.
  }
  return undefined;
}
