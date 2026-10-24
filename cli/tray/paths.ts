/**
 * Install-root and control-file resolution for the tray process.
 *
 * The tray is a separate process from the CLI, so it cannot import the CLI's
 * own resolver without dragging the server graph (Elysia, database drivers,
 * pino) into a 2 MB tray binary. The rule below is duplicated on purpose and
 * must stay identical to `resolveInstallRoot` in `cli/src/paths.ts`:
 * `LIANROUTER_HOME` wins (resolved against cwd), otherwise the per-OS
 * application-data directory — `%LOCALAPPDATA%\LianRouter` on Windows,
 * `~/Library/Application Support/LianRouter` on macOS, and
 * `$XDG_DATA_HOME/LianRouter` or `~/.local/share/LianRouter` on Linux.
 *
 * If the two ever disagree the tray reads a control file nobody wrote.
 * `cli/test/tray-paths.test.ts` holds them together by comparing both
 * resolvers across every platform and environment combination.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The port/pid/token quadruple the CLI writes after it binds the control API. */
export interface ControlFile {
  readonly port: number;
  readonly pid: number;
  readonly token: string;
  /** Milliseconds since the epoch, as `ControlHandshake` writes it. */
  readonly startedAt: number;
}

/** Env override that relocates the whole layout, for portable installs. */
const HOME_ENV = "LIANROUTER_HOME";

/** App-data folder name; the same string on all three platforms by design. */
const APP_DIR_NAME = "LianRouter";

/**
 * Where the tray looks for `run/control.json`.
 *
 * A byte-for-byte mirror of `resolveInstallRoot` in `cli/src/paths.ts`, down to
 * the relative-path resolution and the XDG fallback. Duplication is deliberate
 * — importing the launcher's module would drag the server graph into the tray
 * bundle — but the rule must not drift: on Linux a lowercase or XDG-less path
 * makes the tray read a control file nobody wrote, which is exactly the failure
 * this module's header warns about. `cli/test/tray-paths.test.ts` asserts the
 * two agree across every platform and env combination.
 */
export function resolveInstallRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env[HOME_ENV];
  if (override !== undefined && override.trim() !== "") {
    // Resolved once, here, so a later `chdir` cannot silently move the install.
    return resolve(override);
  }
  return join(appDataRoot(env, platform), APP_DIR_NAME);
}

/** Per-OS data parent, without the app folder. Mirrors the launcher's exactly. */
function appDataRoot(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"];
    if (localAppData !== undefined && localAppData.trim() !== "") {
      return localAppData;
    }
    return join(homedir(), "AppData", "Local");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  const xdgData = env["XDG_DATA_HOME"];
  if (xdgData !== undefined && xdgData.trim() !== "") {
    return xdgData;
  }
  return join(homedir(), ".local", "share");
}

/** Absolute path of the control file for a resolved install root. */
export function controlFilePath(root: string): string {
  return join(root, "run", "control.json");
}

/** Raised when `run/control.json` is absent or does not describe a live CLI. */
export class ControlFileError extends Error {
  override readonly name = "ControlFileError";
}

function readPort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 65535) return undefined;
  return value;
}

/**
 * Reads and validates the control file.
 *
 * Every field is treated as untrusted: the file is plain JSON in a user-writable
 * directory, so a truncated or hand-edited write must fail here with a message
 * the operator can act on rather than producing `NaN` requests.
 *
 * The shape is the producer's, exactly: `startedAt` is epoch milliseconds as a
 * number, matching `ControlHandshake` in `cli/src/control-server.ts`. Accepting
 * an ISO string as well would hide a producer/consumer drift instead of
 * surfacing it, and the drift is what silently disabled the tray once already.
 */
export function readControlFile(root: string): ControlFile {
  const path = controlFilePath(root);
  if (!existsSync(path)) {
    throw new ControlFileError(`No control file at ${path}. Start the CLI first ("lianrouter"), then hide it to the tray.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ControlFileError(`Control file at ${path} is not valid JSON: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ControlFileError(`Control file at ${path} is not a JSON object.`);
  }
  const port = "port" in parsed ? readPort(parsed.port) : undefined;
  const pid = "pid" in parsed ? parsed.pid : undefined;
  const token = "token" in parsed ? parsed.token : undefined;
  const startedAt = "startedAt" in parsed ? parsed.startedAt : undefined;
  if (port === undefined) throw new ControlFileError(`Control file at ${path} has no usable "port".`);
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw new ControlFileError(`Control file at ${path} has no usable "pid".`);
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new ControlFileError(`Control file at ${path} has no "token"; the tray cannot authenticate to the CLI.`);
  }
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) {
    throw new ControlFileError(`Control file at ${path} has no usable "startedAt" (epoch milliseconds).`);
  }
  return { port, pid, token, startedAt };
}
