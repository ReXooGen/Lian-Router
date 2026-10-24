/**
 * What the tray icon should say, and how to open the console without the
 * control port.
 *
 * The tooltip is the only always-visible surface the tray has, so it has to
 * distinguish the states an operator can act on: the launcher is gone, the
 * launcher is up but the gateway is stopped, or everything is running. A
 * single "control unreachable" conflates the first two, which is what made the
 * reported failure hard to diagnose.
 *
 * The console URL is derived rather than fetched. `POST /open-web` is the
 * normal path, but it needs the control server; when the launcher is gone the
 * gateway may still be serving, and the URL is computable from the stale
 * handshake's port or the gateway's default. Opening a URL never needs the
 * launcher, so this is the one action that must always work.
 */

import type { ControlStatus, ServerState } from "./control-client";

/** Gateway default, matching `DEFAULT_PORT` in `cli/src/paths.ts`. */
export const DEFAULT_GATEWAY_PORT = 12_800;

/** Everything the tooltip needs, resolved from one probe. */
export type TrayState =
  | { readonly kind: "running"; readonly url: string }
  | { readonly kind: "stopped"; readonly state: ServerState }
  | { readonly kind: "launcher-gone"; readonly expectedPid: number | undefined }
  | { readonly kind: "unreachable"; readonly detail: string };

/** Builds the tooltip text. Pure, so the wording is testable. */
export function describeTrayState(state: TrayState): string {
  switch (state.kind) {
    case "running":
      return `LianRouter — ${state.url}`;
    case "stopped":
      return `LianRouter — gateway ${state.state}`;
    case "launcher-gone":
      return state.expectedPid === undefined
        ? "LianRouter — launcher not running"
        : `LianRouter — launcher not running (pid ${state.expectedPid})`;
    case "unreachable":
      return `LianRouter — control unreachable: ${state.detail}`;
  }
}

/**
 * Classifies one probe of the launcher.
 *
 * `launcherAlive` is passed in rather than probed here so the caller owns the
 * one liveness check it already needs for resurrection, and so this stays pure.
 */
export function classifyTrayState(
  status: ControlStatus | undefined,
  launcherAlive: boolean,
  expectedPid: number | undefined,
  failure: string | undefined,
): TrayState {
  if (!launcherAlive) return { kind: "launcher-gone", expectedPid };
  if (status === undefined) return { kind: "unreachable", detail: failure ?? "no answer" };
  if (status.state === "running") return { kind: "running", url: status.url };
  return { kind: "stopped", state: status.state };
}

/**
 * The console URL to open without asking the launcher.
 *
 * Preference order: the URL the last good `status()` reported, then the
 * gateway's default port. The handshake is deliberately *not* consulted for the
 * port: `run/control.json`'s `port` is the control server's ephemeral port, not
 * the gateway's, so deriving a console URL from it would open a URL nothing
 * serves. `localhost` rather than `127.0.0.1` so the URL matches what the
 * launcher prints and what the dashboard expects for cookies.
 */
export function consoleUrlFallback(knownUrl: string | undefined): string {
  if (knownUrl !== undefined && knownUrl.length > 0) return knownUrl;
  return `http://localhost:${DEFAULT_GATEWAY_PORT}/console`;
}
