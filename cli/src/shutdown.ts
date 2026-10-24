/**
 * Graceful shutdown for the launcher.
 *
 * A launcher that dies without cleaning up leaves `run/control.json` and
 * `run/lianrouter.pid` behind. The next process then reads a handshake that
 * describes a dead pid, and a tray started in that window talks to a control
 * port nobody is listening on.
 *
 * A forced kill cannot be intercepted — `taskkill /F`, Task Manager, a power
 * cut — so this only covers what can be covered: `SIGINT` (Ctrl-C) and
 * `SIGTERM`. The cleanup is written to be idempotent and safe to run twice,
 * because a second Ctrl-C during shutdown is normal operator behaviour.
 */

import { rmSync } from "node:fs";
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

export interface ShutdownRegistration {
  /** Runs the graceful path once; later calls are no-ops. */
  run(): Promise<void>;
  /** Removes the signal listeners, for tests and for a clean hand-off. */
  dispose(): void;
}

/**
 * Wires `SIGINT`/`SIGTERM` to one graceful shutdown.
 *
 * `exit` is injected so a test can observe the outcome without terminating the
 * test runner; production passes `process.exit`. The first signal wins — a
 * second Ctrl-C while the gateway is still terminating must not start a second
 * teardown, because both would signal the same child and race the pid file.
 */
export function installShutdownHandlers(
  shutdown: () => Promise<void>,
  exit: (code: number) => void,
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
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return {
    run,
    dispose(): void {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}
