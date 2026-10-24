import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Filesystem layout for the launcher.
 *
 * Everything the CLI writes at runtime lives under one root so an uninstall is
 * a single directory delete, and so the tray host and the gateway can find each
 * other's handshake files without knowing how the CLI was installed:
 *
 * ```
 * <installRoot>/            compiled gateway binary, migrations/, dist/dashboard/
 *   logs/lianrouter.log     child stdout+stderr, appended across restarts
 *   cache/updates/          downloaded release artifacts
 *   run/lianrouter.pid      gateway pid, written on spawn
 *   run/control.json        control port + bearer token + tray pid handshake
 *   run/tray.pid            tray host pid
 * ```
 *
 * Every getter here is pure — no `mkdir`. Creation is deferred to
 * {@link ensureStateDirs} so that `status` on a machine that never ran the
 * server prints "not running" instead of creating a directory tree as a side
 * effect of asking a question.
 */

/** Env override that relocates the whole layout, for portable installs. */
const HOME_ENV = "LIANROUTER_HOME";

/** App-data folder name; the same string on all three platforms by design. */
const APP_DIR_NAME = "LianRouter";

const LOGS_DIR = "logs";
const CACHE_DIR = "cache";
const RUN_DIR = "run";
const UPDATE_CACHE_DIR = "updates";

const LOG_FILE_NAME = "lianrouter.log";
const PID_FILE_NAME = "lianrouter.pid";
const CONTROL_FILE_NAME = "control.json";
const TRAY_PID_FILE_NAME = "tray.pid";

/** Default HTTP port, matching the gateway's own `PORT` default. */
export const DEFAULT_PORT = 12_800;

/**
 * Where the compiled gateway binary, `migrations/`, and `dist/dashboard/` live.
 *
 * Resolution order is env override → per-OS app data. A relative
 * `LIANROUTER_HOME` is resolved against the process cwd once, here, so callers
 * never have to think about it and a later `chdir` cannot silently move the
 * install.
 */
export function resolveInstallRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env[HOME_ENV];
  if (override !== undefined && override.trim() !== "") {
    return resolve(override);
  }
  const appData = appDataRoot(env, platform);
  return join(appData, APP_DIR_NAME);
}

/** Per-OS data parent, without the app folder. */
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

/**
 * Mutable runtime state (pid, control handshake, tray pid). Kept as a named
 * resolver rather than inlined joins because the tray host and the control
 * server must agree on the exact directory without importing each other.
 */
export function resolveStateDir(installRoot: string = resolveInstallRoot()): string {
  return join(installRoot, RUN_DIR);
}

/** The gateway executable name for this platform. */
export function resolveBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "lianrouter.exe" : "lianrouter";
}

/** Absolute path of the gateway executable inside the install root. */
export function resolveBinaryPath(
  installRoot: string = resolveInstallRoot(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(installRoot, resolveBinaryName(platform));
}

/** Append-only log file for the supervised child's stdout and stderr. */
export function resolveLogFile(installRoot: string = resolveInstallRoot()): string {
  return join(installRoot, LOGS_DIR, LOG_FILE_NAME);
}

/** Gateway pid file. Presence means "a gateway claimed this install root". */
export function resolvePidFile(installRoot: string = resolveInstallRoot()): string {
  return join(resolveStateDir(installRoot), PID_FILE_NAME);
}

/** Control-plane handshake: `{ port, pid, startedAt, token }` for tray + UI. */
export function resolveControlFile(installRoot: string = resolveInstallRoot()): string {
  return join(resolveStateDir(installRoot), CONTROL_FILE_NAME);
}

/** Tray host pid file. */
export function resolveTrayPidFile(installRoot: string = resolveInstallRoot()): string {
  return join(resolveStateDir(installRoot), TRAY_PID_FILE_NAME);
}

/** Downloaded release artifacts, one subdirectory per version. */
export function resolveUpdateCacheDir(installRoot: string = resolveInstallRoot()): string {
  return join(installRoot, CACHE_DIR, UPDATE_CACHE_DIR);
}

/**
 * Creates every directory the launcher writes into. Idempotent, recursive.
 * The only function in this module with filesystem side effects.
 */
export function ensureStateDirs(installRoot: string = resolveInstallRoot()): void {
  for (const dir of [
    dirname(resolveLogFile(installRoot)),
    resolveStateDir(installRoot),
    resolveUpdateCacheDir(installRoot),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Locates the gateway repository when the CLI runs from source
 * (`bun run cli:dev`).
 *
 * The markers must identify the *gateway* tree, not merely a directory that
 * looks like a launcher: `cli/` has both `src/main.ts` and a `package.json`
 * named `lianrouter`, so a two-part check stops there and hands the launcher
 * its own entry as the supervised child — which recurses forever. `src/app.ts`
 * is the gateway's application builder and exists only in the gateway tree, so
 * requiring it makes the walk skip `cli/` and continue to the repository root.
 *
 * A global install has no such ancestor and returns `undefined`, which is what
 * sends the caller to the install root.
 */
export function resolveDevRepoRoot(startDir: string = import.meta.dir): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    if (isRepoRoot(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isRepoRoot(dir: string): boolean {
  // `src/app.ts` is the discriminator: `src/main.ts` alone also matches the
  // launcher package, and the name check alone matches its manifest.
  if (!existsSync(join(dir, "src", "app.ts"))) {
    return false;
  }
  if (!existsSync(join(dir, "src", "main.ts"))) {
    return false;
  }
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    // A malformed manifest in an ancestor directory is not this launcher's
    // problem; keep walking rather than failing the whole resolution.
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) {
    return false;
  }
  return parsed.name === "lianrouter";
}

/** Console URL the menu and tray open. */
export function consoleUrl(port: number, host: string = "localhost"): string {
  return `http://${host}:${port}/console`;
}

/** Health probe URL used by the supervisor's readiness wait. */
export function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`;
}
