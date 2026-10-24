import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { callWithReconnect, isConnectionFailure, resolveControlConnection } from "../tray/connection";
import { controlFilePath } from "../tray/paths";
import type { ControlResult, ControlStatus } from "../tray/control-client";
import {
  RESURRECT_COOLDOWN_MS,
  RESURRECT_POLL_MS,
  resetResurrectionState,
  resurrectLauncher,
} from "../tray/resurrect";
import type { ResurrectionDeps } from "../tray/resurrect";
import { classifyTrayState, consoleUrlFallback, describeTrayState } from "../tray/state";
import { classifyUpdateOutcome, watchUpdate } from "../tray/update-watch";
import type { UpdateStateFrame } from "../tray/control-client";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-tray-host-test-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "run"), { recursive: true });
  return dir;
}

/**
 * Writes a handshake naming this test process.
 *
 * The pid has to be alive or the resolver refuses it — that check is the whole
 * point of the stale-handshake guard, so the fixture satisfies it rather than
 * working around it.
 */
async function writeHandshake(root: string, port: number, token: string): Promise<void> {
  await writeFile(
    controlFilePath(root),
    JSON.stringify({ port, pid: process.pid, startedAt: Date.now(), token }, null, 2),
    "utf8",
  );
}

describe("resolveControlConnection", () => {
  it("uses a rewritten handshake on the next call, not the first one", async () => {
    const root = await tempRoot();

    await writeHandshake(root, 41_001, "token-a");
    const first = resolveControlConnection(root);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.connection.handshake.port).toBe(41_001);
    expect(first.connection.handshake.token).toBe("token-a");

    // A launcher restart: new ephemeral port, new token.
    await writeHandshake(root, 41_002, "token-b");
    const second = resolveControlConnection(root);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.connection.handshake.port).toBe(41_002);
    expect(second.connection.handshake.token).toBe("token-b");
    expect(second.connection.key).not.toBe(first.connection.key);
  });

  it("names the dead launcher instead of returning a client", async () => {
    const root = await tempRoot();
    await writeFile(
      controlFilePath(root),
      JSON.stringify({ port: 41_003, pid: 2_147_483_646, startedAt: Date.now(), token: "t" }),
      "utf8",
    );

    const resolved = resolveControlConnection(root);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("is not running");
    expect(resolved.error).toContain("2147483646");
  });

  it("reports a missing handshake with the path it looked for", async () => {
    const root = await tempRoot();
    const resolved = resolveControlConnection(root);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain(controlFilePath(root));
  });
});

describe("isConnectionFailure", () => {
  it("separates endpoint failures from request failures", () => {
    expect(isConnectionFailure("Could not reach the CLI control port; it may have exited.")).toBe(true);
    expect(isConnectionFailure("The CLI did not answer within 5s.")).toBe(true);
    expect(isConnectionFailure("missing or invalid control token")).toBe(true);
    expect(isConnectionFailure("/server/restart failed (500): boom")).toBe(false);
  });
});

describe("callWithReconnect", () => {
  it("retries once against the new handshake when the old endpoint is gone", async () => {
    const root = await tempRoot();
    await writeHandshake(root, 41_010, "stale-token");

    const seen: string[] = [];
    const result = await callWithReconnect(root, async () => {
      // Identity is not exposed, so the call itself is what observes the
      // endpoint: the stale client fails, and the rewrite below makes the
      // retry land on a different key.
      seen.push("call");
      if (seen.length === 1) {
        await writeHandshake(root, 41_011, "fresh-token");
        return { ok: false, error: "Could not reach the CLI control port; it may have exited." };
      }
      return { ok: true, data: "reached" };
    });

    expect(seen).toHaveLength(2);
    expect(result).toEqual({ ok: true, data: "reached" });
  });

  it("does not retry when the endpoint did not move", async () => {
    const root = await tempRoot();
    await writeHandshake(root, 41_012, "same-token");

    let calls = 0;
    const result = await callWithReconnect(root, async (): Promise<ControlResult<string>> => {
      calls += 1;
      return { ok: false, error: "Could not reach the CLI control port; it may have exited." };
    });

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("does not retry a request-level failure", async () => {
    const root = await tempRoot();
    await writeHandshake(root, 41_013, "token");

    let calls = 0;
    const result = await callWithReconnect(root, async (): Promise<ControlResult<string>> => {
      calls += 1;
      return { ok: false, error: "/server/stop failed (500): nope" };
    });

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("surfaces a dead launcher when the retry cannot resolve", async () => {
    const root = await tempRoot();
    await writeHandshake(root, 41_014, "token");

    const result = await callWithReconnect(root, async () => {
      await rm(controlFilePath(root), { force: true });
      return { ok: false, error: "Could not reach the CLI control port; it may have exited." } as ControlResult<string>;
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No control file");
  });
});

describe("classifyUpdateOutcome", () => {
  const frame = (running: boolean, progress: UpdateStateFrame["progress"], snapshot: UpdateStateFrame["snapshot"] = null): UpdateStateFrame => ({
    running,
    progress,
    snapshot,
  });

  it("reports failure with the frame's error text", () => {
    const outcome = classifyUpdateOutcome([
      frame(true, { phase: "downloading", percent: 10, message: "downloading" }),
      frame(false, { phase: "error", percent: 0, message: "install failed", error: "rename failed (EPERM)" }),
    ]);
    expect(outcome).toEqual({ kind: "failed", message: "rename failed (EPERM)" });
  });

  it("falls back to the message when the error field is absent", () => {
    const outcome = classifyUpdateOutcome([frame(false, { phase: "error", percent: 0, message: "sha256 mismatch" })]);
    expect(outcome).toEqual({ kind: "failed", message: "sha256 mismatch" });
  });

  it("treats a settled run with no error as done, naming the version", () => {
    const outcome = classifyUpdateOutcome([
      frame(false, null, { available: true, current: "2.0.0", latest: "2.0.5" }),
    ]);
    expect(outcome).toEqual({ kind: "done", version: "2.0.5" });
  });

  it("keeps an error that a later empty poll would otherwise erase", () => {
    const outcome = classifyUpdateOutcome([
      frame(false, { phase: "error", percent: 0, message: "boom" }),
      frame(false, null),
    ]);
    expect(outcome.kind).toBe("failed");
  });

  it("reports unknown when the run never settled", () => {
    const outcome = classifyUpdateOutcome([frame(true, { phase: "downloading", percent: 5, message: "go" })]);
    expect(outcome.kind).toBe("unknown");
  });

  it("reports none when nothing was observed", () => {
    expect(classifyUpdateOutcome([])).toEqual({ kind: "none" });
  });
});

describe("watchUpdate", () => {
  it("stops as soon as running goes false and classifies once", async () => {
    const frames: UpdateStateFrame[] = [
      { running: true, progress: { phase: "downloading", percent: 10, message: "go" }, snapshot: null },
      { running: true, progress: { phase: "installing", percent: 90, message: "go" }, snapshot: null },
      { running: false, progress: null, snapshot: { available: true, current: "2.0.0", latest: "2.0.5" } },
    ];
    let index = 0;
    const settled: string[] = [];

    await watchUpdate({
      timeoutMs: 60_000,
      intervalMs: 1,
      sleep: async () => {},
      now: () => 0,
      readState: async () => frames[Math.min(index++, frames.length - 1)],
      onSettled: (outcome) => {
        settled.push(outcome.kind);
      },
    });

    expect(settled).toEqual(["done"]);
    expect(index).toBe(3);
  });

  it("keeps polling through read failures instead of reporting them", async () => {
    let attempts = 0;
    const settled: string[] = [];

    await watchUpdate({
      timeoutMs: 60_000,
      intervalMs: 1,
      sleep: async () => {},
      now: () => 0,
      readState: async () => {
        attempts += 1;
        if (attempts < 3) return undefined;
        return { running: false, progress: { phase: "error", percent: 0, message: "late failure" }, snapshot: null };
      },
      onSettled: (outcome) => {
        settled.push(outcome.kind);
      },
    });

    expect(attempts).toBe(3);
    expect(settled).toEqual(["failed"]);
  });
});

describe("resurrectLauncher", () => {
  /** The repo root resolves a launcher entry; a fake path never would. */
  const repoRoot = join(import.meta.dir, "..", "..");
  /**
   * A clock that advances on every read.
   *
   * The wait loop bounds itself with `now()`, so a frozen clock would spin
   * forever — the same trap the production code would have if it compared
   * against a captured constant.
   */
  const advancingClock = (): (() => number) => {
    let clock = 0;
    return () => {
      clock += RESURRECT_POLL_MS;
      return clock;
    };
  };
  const baseDeps = (overrides: Partial<ResurrectionDeps> = {}): ResurrectionDeps => ({
    installRoot: "/tmp/install",
    startDir: repoRoot,
    spawn: () => 4_242,
    readHandshakePid: () => 4_242,
    sleep: async () => {},
    now: advancingClock(),
    ...overrides,
  });

  it("spawns once and reports the new launcher when a fresh handshake appears", async () => {
    resetResurrectionState();
    let spawned = 0;
    const result = await resurrectLauncher(
      baseDeps({
        spawn: () => {
          spawned += 1;
          return 4_242;
        },
        // The stale pid is 111; anything else means the new launcher published.
        readHandshakePid: () => 4_242,
      }),
      111,
    );

    expect(spawned).toBe(1);
    expect(result.kind).toBe("started");
  });

  it("refuses a second spawn while one is in flight", async () => {
    resetResurrectionState();
    let spawned = 0;
    const deps = baseDeps({
      spawn: () => {
        spawned += 1;
        return 4_242;
      },
      // Never publishes a new handshake, so the first attempt stays in flight
      // until its window expires.
      readHandshakePid: () => 111,
    });

    const first = resurrectLauncher(deps, 111);
    // Started before the first attempt settles: this is the double-click case.
    const second = await resurrectLauncher(deps, 111);
    const firstResult = await first;

    expect(second.kind).toBe("skipped");
    if (second.kind === "skipped") expect(second.reason).toContain("already being started");
    expect(firstResult.kind).toBe("failed");
    expect(spawned).toBe(1);
    resetResurrectionState();
  });

  it("enters a cooldown after a failed attempt", async () => {
    resetResurrectionState();
    let spawned = 0;
    let clock = 1_000;
    const deps = baseDeps({
      spawn: () => {
        spawned += 1;
        return 4_242;
      },
      readHandshakePid: () => 111,
      // Advances so the first attempt's wait loop terminates.
      now: () => {
        clock += RESURRECT_POLL_MS;
        return clock;
      },
    });

    await resurrectLauncher(deps, 111);
    expect(spawned).toBe(1);

    // Immediately after the failure: refused without spawning.
    const during = await resurrectLauncher(deps, 111);
    expect(during.kind).toBe("skipped");
    expect(spawned).toBe(1);

    // Past the cooldown: allowed again.
    clock += RESURRECT_COOLDOWN_MS + 1;
    await resurrectLauncher(deps, 111);
    expect(spawned).toBe(2);
    resetResurrectionState();
  });

  it("fails with the launcher path when no entry exists", async () => {
    resetResurrectionState();
    const isolated = await mkdtemp(join(tmpdir(), "lianrouter-no-entry-"));
    tempDirs.push(isolated);
    const result = await resurrectLauncher(baseDeps({ installRoot: isolated, startDir: isolated }), 111);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.reason).toContain("no launcher entry");
    expect(result.command).toBeUndefined();
    resetResurrectionState();
  });
});

describe("classifyTrayState", () => {
  const running: ControlStatus = {
    state: "running",
    port: 12_800,
    pid: 5,
    url: "http://localhost:12800",
    update: { available: false },
  };

  it("reports a live pid with a refused port as unreachable, not launcher-gone", () => {
    // The operator's actual case: the handshake pid is alive, the socket is
    // refused. That must not read as "launcher not running", or the fix targets
    // the wrong process.
    const state = classifyTrayState(undefined, true, 5, "Could not reach the CLI control port; it may have exited.");
    expect(state.kind).toBe("unreachable");
    const text = describeTrayState(state);
    expect(text).toContain("control unreachable");
    expect(text).toContain("control port");
    expect(text).not.toContain("launcher not running");
  });

  it("reports launcher-gone with the pid it expected", () => {
    const text = describeTrayState(classifyTrayState(undefined, false, 9_876, "whatever"));
    expect(text).toContain("launcher not running");
    expect(text).toContain("9876");
  });

  it("distinguishes a stopped gateway from a missing launcher", () => {
    const text = describeTrayState(classifyTrayState({ ...running, state: "stopped" }, true, 5, undefined));
    expect(text).toContain("gateway stopped");
    expect(text).not.toContain("launcher not running");
  });

  it("shows the url when everything is running", () => {
    expect(describeTrayState(classifyTrayState(running, true, 5, undefined))).toBe("LianRouter — http://localhost:12800");
  });
});

describe("consoleUrlFallback", () => {
  it("uses the last known url", () => {
    expect(consoleUrlFallback("http://localhost:12900/console")).toBe("http://localhost:12900/console");
  });

  it("falls back to the gateway default with no launcher and no history", () => {
    expect(consoleUrlFallback(undefined)).toBe("http://localhost:12800/console");
  });
});
