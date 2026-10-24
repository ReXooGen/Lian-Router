// Update control-plane contracts and operations.
//
// The dashboard asks two questions: "is there a newer release for this install"
// and "start installing it". Neither can be answered here. The gateway does not
// own its own binary, cannot replace a file it is executing, and dies in the
// middle of the operation — the launcher owns all three. So this domain is a
// proxy: it reads the handshake the launcher publishes in
// `<installRoot>/run/control.json`, dials the launcher's loopback control port
// with the shared token, and reshapes the answer for the browser. The token
// stays inside `launcher-client.ts`; no response here ever carries it.

import type { ConsoleAccessResolver } from "../auth/access";
import type { AuditSink } from "../domains/audit/contracts";
import { ConsoleDomainError, requireTenantScope } from "../shared/errors";
import type { AccessDecision } from "../../security/access-control";
import { LIANROUTER_VERSION } from "../../transport/version";
import {
  fetchLauncherUpdateState,
  readLauncherHandshake,
  startLauncherUpdate,
  type LauncherHandshake,
  type LauncherProgress,
  type LauncherSnapshot,
} from "./launcher-client";

/** One progress sample, flattened so absent counters are explicit nulls. */
export interface UpdateProgressResponse {
  readonly phase: string;
  readonly percent: number;
  readonly message: string;
  readonly bytesReceived: number | null;
  readonly bytesTotal: number | null;
  readonly error: string | null;
}

/**
 * The dashboard's whole update surface.
 *
 * `launcher` is false when no launcher is attached — an install started by hand,
 * a stripped build, or a launcher that just exited. `available` is false in that
 * case too, because "there might be an update but nothing can install it" is not
 * a state the UI can act on.
 */
export interface UpdateStatusResponse {
  readonly launcher: boolean;
  readonly current: string;
  readonly latest: string | null;
  readonly available: boolean;
  readonly notesUrl: string | null;
  readonly publishedAt: string | null;
  readonly running: boolean;
  readonly progress: UpdateProgressResponse | null;
}

/** `202` from `POST /update/start`; the flow continues after the response. */
export interface UpdateStartResponse {
  readonly accepted: true;
}

export interface UpdateRoutesConfig {
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
}

/** The access-checked operations the routes call; each takes the caller's decision. */
export interface UpdateOperations {
  status(access: AccessDecision | undefined): Promise<UpdateStatusResponse>;
  start(access: AccessDecision | undefined): Promise<UpdateStartResponse>;
}

/**
 * Reads the launcher handshake for this request.
 *
 * Deliberately per call, never memoized: the launcher mints a new port and token
 * on every boot, and an update restarts nothing but the gateway — so a cached
 * handshake would survive a launcher restart and point at a socket nobody owns.
 */
async function currentHandshake(): Promise<LauncherHandshake | undefined> {
  const home = process.env["LIANROUTER_LAUNCHER_HOME"]?.trim();
  if (home === undefined || home.length === 0) return undefined;
  return await readLauncherHandshake(home);
}

function toProgress(progress: LauncherProgress): UpdateProgressResponse {
  return {
    phase: progress.phase,
    percent: progress.percent,
    message: progress.message,
    bytesReceived: progress.bytesReceived,
    bytesTotal: progress.bytesTotal,
    error: progress.error,
  };
}

function toStatus(
  launcher: boolean,
  snapshot: LauncherSnapshot | null,
  running: boolean,
  progress: LauncherProgress | null,
): UpdateStatusResponse {
  return {
    launcher,
    current: snapshot?.current ?? LIANROUTER_VERSION,
    latest: snapshot?.latest ?? null,
    available: launcher && (snapshot?.available ?? false),
    notesUrl: snapshot?.notesUrl ?? null,
    publishedAt: snapshot?.publishedAt ?? null,
    running,
    progress: progress === null ? null : toProgress(progress),
  };
}

export function createUpdateOperations(config: UpdateRoutesConfig): UpdateOperations {
  return {
    async status(access: AccessDecision | undefined): Promise<UpdateStatusResponse> {
      requireTenantScope(access, "dashboard:read");
      const handshake = await currentHandshake();
      if (handshake === undefined) return toStatus(false, null, false, null);
      const state = await fetchLauncherUpdateState(handshake);
      // A launcher that cannot be read is reported as absent, not as an error:
      // the dashboard's honest rendering of "no update control" is the same
      // whether the launcher never existed or just exited.
      if (!state.ok) return toStatus(false, null, false, null);
      return toStatus(true, state.data.snapshot, state.data.running, state.data.progress);
    },

    async start(access: AccessDecision | undefined): Promise<UpdateStartResponse> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const handshake = await currentHandshake();
      if (handshake === undefined) {
        throw new ConsoleDomainError(
          "launcher_unavailable",
          503,
          "The launcher is not running; start LianRouter from the CLI to install updates",
        );
      }
      // Read the state first so the audit row names the versions the operator
      // actually saw when they confirmed. A read failure here is not fatal —
      // the start below is what the caller asked for.
      const state = await fetchLauncherUpdateState(handshake);
      const snapshot = state.ok ? state.data.snapshot : null;
      const started = await startLauncherUpdate(handshake);
      if (!started.ok) {
        if (started.status === 409) {
          throw new ConsoleDomainError("update_in_progress", 409, started.error);
        }
        if (started.status === undefined) {
          // The handshake was readable but the socket is not: the launcher
          // exited between the file read and the call.
          throw new ConsoleDomainError("launcher_unavailable", 503, started.error);
        }
        throw new ConsoleDomainError("launcher_error", 502, started.error);
      }
      await config.auditSink?.record({
        access: authorized,
        action: "settings.update.started",
        target: snapshot?.current ?? LIANROUTER_VERSION,
        detail: { latest: snapshot?.latest ?? null },
      });
      return { accepted: true };
    },
  };
}
