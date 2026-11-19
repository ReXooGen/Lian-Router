/**
 * Bringing the launcher back when the tray outlives it.
 *
 * The control server lives in the launcher process, so a menu the operator is
 * looking at can lose its only backend: closing the console window, a Ctrl-C,
 * or a crash all end that process. Before this module existed the tray kept its
 * icon and answered every click with "could not reach the control port", which
 * names the symptom and not the cause.
 *
 * Resurrection is deliberately conservative. It spawns the launcher detached
 * and headless (`--headless --no-open` — resident with a control server, no
 * menu, no browser), waits for a *new* handshake, and gives up quickly. Two
 * guards keep it from becoming a spawn storm: a module-level in-flight flag,
 * and a cooldown after a failed attempt.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** How long to wait for a resurrected launcher to publish a handshake. */
export const RESURRECT_TIMEOUT_MS = 10_000;
export const RESURRECT_POLL_MS = 250;

/**
 * After a failed resurrection, do not try again for this long.
 *
 * A launcher that cannot start will fail in milliseconds, and a user clicking
 * three menu items should not produce three doomed spawns (and three dialogs
 * stacking on each other).
 */
export const RESURRECT_COOLDOWN_MS = 30_000;

/** A launcher entry plus the argv that makes it run headless. */
export interface LauncherCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Finds something to spawn as a launcher.
 *
 * Three layouts, in order of preference:
 *
 * 1. `dist/cli.js` beside the tray bundle — the launcher's own JavaScript
 *    entry. This is the correct resurrection target for an npm install: the
 *    `lianrouter.exe` in the install root is the *gateway* binary, not a
 *    launcher, and spawning it starts a gateway with no control server, which
 *    leaves the tray with a handshake that never appears.
 * 2. A source checkout, found by walking up for `src/app.ts` — the gateway's
 *    application builder, the same marker `resolveDevRepoRoot` uses.
 * 3. The compiled `lianrouter` binary in the install root, when the install
 *    ships one that is actually a launcher.
 *
 * The check is by existence, because a checkout that has not been built has
 * neither entry and a packaged install has no source at all.
 */
export function resolveLauncherCommand(
  startDir: string,
  gatewayPort?: number,
): LauncherCommand | undefined {
  // Carrying the port through matters: the console URL the operator already has
  // open points at the old port, and a launcher that comes back on a different
  // one silently breaks that tab.
  const portArgs = gatewayPort === undefined ? [] : ["--port", String(gatewayPort)];
  // `--headless`, not `--background`: the tray needs a control server to talk
  // to, and `--background` stops it and returns. Headless stays resident with
  // the server up and prints no menu.
  const headlessArgs = ["--headless", "--no-open", ...portArgs];

  // The tray bundle lives in the launcher package's `dist/`, so a launcher
  // entry beside it is the same installation this process came from. This is
  // the correct resurrection target for an npm install: the `lianrouter.exe`
  // in the install root is the *gateway* binary, not a launcher, and spawning
  // it starts a gateway with no control server — a handshake that never
  // appears and a tray that stays dead.
  const besideBundle = join(dirname(dirname(import.meta.path)), "cli.js");
  if (existsSync(besideBundle)) {
    return { file: process.execPath, args: [besideBundle, ...headlessArgs] };
  }

  let current = startDir;
  for (;;) {
    if (existsSync(join(current, "src", "app.ts")) && existsSync(join(current, "src", "main.ts"))) {
      const entry = join(current, "cli", "src", "main.ts");
      if (existsSync(entry)) {
        return { file: process.execPath, args: ["run", entry, ...headlessArgs] };
      }
      return undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Outcome of one resurrection attempt. */
export type ResurrectionResult =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string; readonly command: LauncherCommand | undefined }
  | { readonly kind: "started"; readonly pid: number };

/** Injected so the guards are testable without real processes or clocks. */
export interface ResurrectionDeps {
  readonly installRoot: string;
  /** Where to start the checkout walk; production passes `import.meta.dir`. */
  readonly startDir: string;
  /** Gateway port to reuse, so the console URL the operator has keeps working. */
  readonly gatewayPort?: number;
  readonly spawn: (command: LauncherCommand) => number | undefined;
  /** Reads the handshake pid, or `undefined` when the file is missing/invalid. */
  readonly readHandshakePid: () => number | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** Module-level, so two clicks in the same process cannot both spawn. */
let inFlight = false;
let lastFailureAt: number | undefined;

/** Test seam: forget the guards. */
export function resetResurrectionState(): void {
  inFlight = false;
  lastFailureAt = undefined;
}

/**
 * Spawns a launcher and waits for it to publish a handshake.
 *
 * Success is "a handshake naming a *different* pid than the one we gave up on",
 * not merely "a file exists": the stale file is still on disk, so a naive wait
 * would return immediately and the retry would hit the same dead port.
 */
export async function resurrectLauncher(
  deps: ResurrectionDeps,
  stalePid: number | undefined,
): Promise<ResurrectionResult> {
  if (inFlight) return { kind: "skipped", reason: "a launcher is already being started" };

  const now = deps.now();
  if (lastFailureAt !== undefined && now - lastFailureAt < RESURRECT_COOLDOWN_MS) {
    const seconds = Math.ceil((RESURRECT_COOLDOWN_MS - (now - lastFailureAt)) / 1000);
    return { kind: "skipped", reason: `the last attempt failed; try again in ${seconds}s` };
  }

  const command = resolveLauncherCommand(deps.startDir, deps.gatewayPort);
  if (command === undefined) {
    lastFailureAt = now;
    return { kind: "failed", reason: "no launcher entry was found for this install", command: undefined };
  }

  inFlight = true;
  try {
    const pid = deps.spawn(command);
    if (pid === undefined) {
      lastFailureAt = now;
      return { kind: "failed", reason: "the launcher process could not be started", command };
    }

    const deadline = deps.now() + RESURRECT_TIMEOUT_MS;
    while (deps.now() < deadline) {
      const handshakePid = deps.readHandshakePid();
      if (handshakePid !== undefined && handshakePid !== stalePid) {
        return { kind: "started", pid };
      }
      await deps.sleep(RESURRECT_POLL_MS);
    }

    lastFailureAt = now;
    return {
      kind: "failed",
      reason: `the launcher started (pid ${pid}) but published no control handshake within ${RESURRECT_TIMEOUT_MS / 1000}s`,
      command,
    };
  } finally {
    inFlight = false;
  }
}
