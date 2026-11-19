import { afterAll, describe, expect, test } from "bun:test";

import { traySurvivedStartup } from "../src/launcher";

/**
 * The defect these pin: `startTrayHost` hid the console the moment `startTray`
 * reported a spawn. A spawn is not a running tray — the host can exit a moment
 * later on a dead handshake, a rival pid file, or a failed pump — and the
 * operator was left with a window that vanished and no icon to bring it back.
 *
 * `traySurvivedStartup` is the gate that decision now goes through. It takes a
 * pid, so the test spawns real processes rather than mocking liveness: a gate
 * tested against a stub proves the stub, not the gate.
 *
 * These are the documented exception to deterministic time control. The
 * question under test is "did the OS still have this pid", which no fake clock
 * can answer — process death is a platform fact, not a timer the test owns.
 * Durations are kept short and every wait is bounded by the gate's own window
 * rather than a guessed sleep.
 */

const children: Bun.Subprocess[] = [];

afterAll(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
});

/** Spawns a process that stays alive until the test kills it. */
function spawnLive(): number {
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(child);
  return child.pid;
}

/** Spawns a process that exits immediately, then awaits its actual exit. */
async function spawnDead(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", "process.exit(1)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = child.pid;
  await child.exited;
  return pid;
}

describe("traySurvivedStartup", () => {
  test("a tray that died during startup fails the gate", async () => {
    const pid = await spawnDead();
    expect(await traySurvivedStartup(pid, 400)).toBe(false);
  });

  test("a tray still running after the window passes the gate", async () => {
    const pid = spawnLive();
    expect(await traySurvivedStartup(pid, 400)).toBe(true);
  });

  test("a tray that dies inside the window is caught without waiting it out", async () => {
    // 5 s window, child exits at ~50 ms. The poll must notice the exit long
    // before the deadline: a gate that always waited the full window would make
    // every failed tray take 5 s to report.
    const child = Bun.spawn(
      [process.execPath, "-e", "setTimeout(() => process.exit(0), 50)"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    children.push(child);
    const started = Date.now();
    const survived = await traySurvivedStartup(child.pid, 5_000);
    const elapsed = Date.now() - started;

    expect(survived).toBe(false);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("an already-dead pid fails the gate immediately", async () => {
    const pid = await spawnDead();
    const started = Date.now();
    expect(await traySurvivedStartup(pid, 3_000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
