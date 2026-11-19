/**
 * Graceful shutdown for the launcher, and the console-close hand-off.
 *
 * A launcher that dies without cleaning up leaves `run/control.json` and
 * `run/lianrouter.pid` behind. The next process then reads a handshake that
 * describes a dead pid, and a tray started in that window talks to a control
 * port nobody is listening on.
 *
 * A forced kill cannot be intercepted — `taskkill /F`, Task Manager, a power
 * cut — so the teardown covers what can be covered: `SIGINT` (Ctrl-C) and
 * `SIGTERM`. The cleanup is written to be idempotent and safe to run twice,
 * because a second Ctrl-C during shutdown is normal operator behaviour.
 *
 * Closing the console window is a different event with a different answer:
 * the stack hands off to a headless launcher instead of dying.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveControlFile, resolvePidFile } from "./paths";
/** Everything shutdown needs from a running session. */
export interface ShutdownTarget {
  readonly installRoot: string;
  /** Stops the control server, which also removes its own handshake file. */
  stopControl(): Promise<void>;
  /** Stops the supervised gateway and disposes its handles. */
  stopGateway(): Promise<void>;
}

/**
 * Spawns one headless launcher, detached, carrying the session forward.
 *
 * Detached is the point: the child must not share the console that is closing,
 * or it dies with the same event that is killing this process. `--headless`
 * keeps a control server up (the tray needs it) and prints nothing.
 */
export function spawnHeadlessLauncher(command: readonly string[], installRoot: string): number | undefined {
  try {
    // stderr goes to the launcher log instead of nowhere: a successor that dies
    // before publishing its handshake is otherwise un-diagnosable — the parent
    // can only report the exit, never the reason.
    const logPath = join(installRoot, "logs", "successor.log");
    mkdirSync(dirname(logPath), { recursive: true });
    const out = openSync(logPath, "a");
    const child = spawn(command[0]!, command.slice(1), {
      cwd: installRoot,
      env: { ...process.env, LIANROUTER_HOME: installRoot },
      stdio: ["ignore", out, out],
      detached: true,
      windowsHide: true,
    });
    closeSync(out);
    child.unref();
    return child.pid;
  } catch {
    return undefined;
  }
}

/**
 * Stops a session and removes both handshake files.
 *
 * The removals are explicit rather than inferred from the stop calls: a
 * supervisor that never had a child pid returns early from `stop()` without
 * touching its pid file, and an adopted child is a case this process did not
 * create. Removing unconditionally is what makes the post-condition true
 * regardless of how the session started.
 */
export async function shutdownSessionFiles(target: ShutdownTarget): Promise<void> {
  try {
    await target.stopControl();
  } finally {
    try {
      await target.stopGateway();
    } finally {
      rmSync(resolveControlFile(target.installRoot), { force: true });
      rmSync(resolvePidFile(target.installRoot), { force: true });
    }
  }
}

/** The launcher entry that survives a closed console: `dist/cli.js`. */
export function resolveHeadlessEntry(installRoot: string): string | undefined {
  const candidate = join(installRoot, "dist", "cli.js");
  return existsSync(candidate) ? candidate : undefined;
}

export interface ShutdownRegistration {
  /** Runs the graceful path once; later calls are no-ops. */
  run(): Promise<void>;
  /** Removes the signal listeners, for tests and for a clean hand-off. */
  dispose(): void;
}

/**
 * Wires `SIGINT`/`SIGTERM` to the teardown and `SIGHUP` to a hand-off.
 *
 * Closing a console window is not an operator saying "stop": the tray path
 * exists precisely so the stack outlives the window. So the console-close
 * signal (`SIGHUP` on both platforms — Bun maps the Windows console-close
 * notification to it) hands the session to a detached headless launcher
 * instead of tearing it down, and only tears down when no headless entry
 * exists. Ctrl-C and `SIGTERM` keep their meaning: stop everything now.
 *
 * `exit` is injected so a test can observe the outcome without terminating
 * the test runner; production passes `process.exit`. The first signal wins —
 * a second Ctrl-C while the gateway is still terminating must not start a
 * second teardown.
 */
export function installShutdownHandlers(
  shutdown: () => Promise<void>,
  exit: (code: number) => void,
  handOff?: () => Promise<boolean>,
): ShutdownRegistration {
  let running: Promise<void> | undefined;
  const run = (): Promise<void> => {
    running ??= shutdown().then(
      () => exit(0),
      () => exit(1),
    );
    return running;
  };
  const onSignal = (): void => {
    void run();
  };
  const onConsoleClose = (): void => {
    if (handOff === undefined) {
      onSignal();
      return;
    }
    void handOff().then(
      (handed) => {
        if (!handed) onSignal();
      },
      () => onSignal(),
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onConsoleClose);
  return {
    run,
    dispose(): void {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onConsoleClose);
    },
  };
}

