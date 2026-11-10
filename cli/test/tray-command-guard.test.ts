import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { callRecovering } from "../tray/connection";
import {
  MENU_REOPEN_GUARD_MS,
  OPEN_CONSOLE_GUARD_MS,
  createCommandGuard,
  createRepeatSuppressor,
} from "../tray/command-guard";
import { decodeTrayEvent } from "../tray/pump";
import { TRAY_COMMANDS } from "../tray/protocol";
import { ControlServer } from "../src/control-server";
import type { GatewaySupervisor, ServerStatus } from "../src/supervisor";

/**
 * The tray's duplicate-collapsing guards.
 *
 * These are the layer that makes one operator gesture produce one browser tab.
 * The clock is injected, so "inside the window" and "after the window" are
 * expressed as elapsed time rather than by sleeping, and nothing here touches
 * Win32 or a browser.
 */

/** A clock the test moves by hand. */
function manualClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("createCommandGuard", () => {
  it("runs the first command and drops a duplicate inside the window", async () => {
    const clock = manualClock();
    const guard = createCommandGuard(OPEN_CONSOLE_GUARD_MS, clock.now);
    let opens = 0;

    const first = await guard.run(TRAY_COMMANDS.openConsole, async () => {
      opens += 1;
    });
    // A double-click's second callback lands milliseconds later, well inside
    // the window, and must not reach the browser.
    clock.advance(120);
    const second = await guard.run(TRAY_COMMANDS.openConsole, async () => {
      opens += 1;
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(opens).toBe(1);
  });

  it("drops a duplicate that arrives while the first is still in flight", async () => {
    const clock = manualClock();
    const guard = createCommandGuard(OPEN_CONSOLE_GUARD_MS, clock.now);
    let opens = 0;

    const gate = Promise.withResolvers<void>();
    const running = guard.run(TRAY_COMMANDS.openConsole, async () => {
      opens += 1;
      await gate.promise;
    });
    // Same instant: the window alone would not catch this one, only the
    // in-flight claim does.
    const concurrent = await guard.run(TRAY_COMMANDS.openConsole, async () => {
      opens += 1;
    });

    gate.resolve();
    expect(await running).toBe(true);
    expect(concurrent).toBe(false);
    expect(opens).toBe(1);
  });

  it("accepts the command again once the window has elapsed", async () => {
    const clock = manualClock();
    const guard = createCommandGuard(OPEN_CONSOLE_GUARD_MS, clock.now);
    let opens = 0;

    await guard.run(TRAY_COMMANDS.openConsole, async () => {
      opens += 1;
    });
    // A deliberate second click on the menu, later than the guard window: the
    // operator asked twice and must get two tabs.
    clock.advance(OPEN_CONSOLE_GUARD_MS);
    const later = await guard.run(TRAY_COMMANDS.openConsole, async () => {
      opens += 1;
    });

    expect(later).toBe(true);
    expect(opens).toBe(2);
  });

  it("keeps other commands independent of the open-console window", async () => {
    const clock = manualClock();
    const guard = createCommandGuard(OPEN_CONSOLE_GUARD_MS, clock.now);
    const ran: number[] = [];

    await guard.run(TRAY_COMMANDS.openConsole, async () => {
      ran.push(TRAY_COMMANDS.openConsole);
    });
    clock.advance(50);
    const restarted = await guard.run(TRAY_COMMANDS.restart, async () => {
      ran.push(TRAY_COMMANDS.restart);
    });

    expect(restarted).toBe(true);
    expect(ran).toEqual([TRAY_COMMANDS.openConsole, TRAY_COMMANDS.restart]);
  });

  it("releases the in-flight claim when the action throws", async () => {
    const clock = manualClock();
    const guard = createCommandGuard(OPEN_CONSOLE_GUARD_MS, clock.now);
    let attempts = 0;

    await expect(
      guard.run(TRAY_COMMANDS.openConsole, async () => {
        attempts += 1;
        throw new Error("browser opener exploded");
      }),
    ).rejects.toThrow("browser opener exploded");

    // The failure must not wedge the guard: a retry after the window still runs.
    clock.advance(OPEN_CONSOLE_GUARD_MS);
    const retried = await guard.run(TRAY_COMMANDS.openConsole, async () => {
      attempts += 1;
    });

    expect(retried).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe("createRepeatSuppressor", () => {
  it("allows one context callback and drops the duplicate message", () => {
    const clock = manualClock();
    const suppressor = createRepeatSuppressor(MENU_REOPEN_GUARD_MS, clock.now);

    expect(suppressor.allow()).toBe(true);
    clock.advance(5);
    expect(suppressor.allow()).toBe(false);
  });

  it("allows a deliberate second right-click after the window", () => {
    const clock = manualClock();
    const suppressor = createRepeatSuppressor(MENU_REOPEN_GUARD_MS, clock.now);

    expect(suppressor.allow()).toBe(true);
    clock.advance(MENU_REOPEN_GUARD_MS);
    expect(suppressor.allow()).toBe(true);
  });
});

describe("decodeTrayEvent", () => {
  it("does not map both right-click messages to the same event", () => {
    // Explorer can report one physical right-click as both messages. If they
    // decoded identically the pump would open the menu twice, and the operator
    // would pick Open Console twice.
    expect(decodeTrayEvent(0x0205)).toBe("context");
    expect(decodeTrayEvent(0x007b)).toBe("context-alt");
    expect(decodeTrayEvent(0x0205)).not.toBe(decodeTrayEvent(0x007b));
  });

  it("maps a left click to activation without needing CS_DBLCLKS", () => {
    // The window class omits CS_DBLCLKS, so WM_LBUTTONDBLCLK never arrives and
    // a double-click is delivered as two WM_LBUTTONUP messages. Both must
    // activate, or a left click would open nothing at all.
    expect(decodeTrayEvent(0x0202)).toBe("activate");
    expect(decodeTrayEvent(0x0203)).toBe("activate");
  });

  it("ignores unrelated mouse messages", () => {
    expect(decodeTrayEvent(0x0200)).toBe("none");
    expect(decodeTrayEvent(0x0000)).toBe("none");
  });
});

describe("open console end to end", () => {
  const STATUS: ServerStatus = {
    state: "running",
    port: 12_800,
    pid: 4242,
    startedAt: 1,
    lastExitCode: undefined,
    lastError: undefined,
    url: "http://localhost:12800",
  };

  /** The members `ControlServer` touches; a real supervisor needs a child. */
  function fakeSupervisor(): GatewaySupervisor {
    return {
      status: STATUS,
      subscribe: () => () => undefined,
      start: async () => STATUS,
      stop: async () => STATUS,
      restart: async () => STATUS,
    } as unknown as GatewaySupervisor;
  }

  it("opens one tab for a duplicated command, and a later click still opens one", async () => {
    const root = await mkdtemp(join(tmpdir(), "lianrouter-open-console-"));
    const opened: string[] = [];
    const clock = manualClock();
    const control = new ControlServer({
      installRoot: root,
      supervisor: fakeSupervisor(),
      consoleUrl: "http://localhost:12800/console",
      onShutdown: () => undefined,
      openBrowser: (url) => opened.push(url),
      now: clock.now,
    });

    try {
      const handshake = await control.start();
      const guard = createCommandGuard(OPEN_CONSOLE_GUARD_MS, clock.now);
      const click = (): Promise<boolean> =>
        guard.run(TRAY_COMMANDS.openConsole, async () => {
          const result = await callRecovering({
            installRoot: root,
            startDir: import.meta.dir,
            deps: {
              spawn: () => undefined,
              readHandshakePid: () => handshake.pid,
              sleep: async () => undefined,
              now: clock.now,
            },
            call: (client) => client.openWeb(),
          });
          // The bug this pins down: a successful POST must report success. When
          // it decoded to "unexpected body shape" the host fell back to its own
          // opener, and one click produced two tabs.
          expect(result.result.ok).toBe(true);
        });

      expect(await click()).toBe(true);
      clock.advance(40);
      expect(await click()).toBe(false);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toBe("http://localhost:12800/console");

      // A later deliberate click passes both windows and opens one more tab.
      clock.advance(OPEN_CONSOLE_GUARD_MS + 3_000);
      expect(await click()).toBe(true);
      expect(opened).toHaveLength(2);
    } finally {
      await control.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not spawn a second browser for a retried POST inside the window", async () => {
    const root = await mkdtemp(join(tmpdir(), "lianrouter-open-web-retry-"));
    const opened: string[] = [];
    const clock = manualClock();
    const control = new ControlServer({
      installRoot: root,
      supervisor: fakeSupervisor(),
      consoleUrl: "http://localhost:12800/console",
      onShutdown: () => undefined,
      openBrowser: (url) => opened.push(url),
      now: clock.now,
    });

    try {
      const handshake = await control.start();
      const post = (): Promise<Response> =>
        fetch(`http://127.0.0.1:${handshake.port}/open-web`, {
          method: "POST",
          headers: { "x-lianrouter-control": handshake.token },
        });

      const first = await post();
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ ok: true, url: "http://localhost:12800/console" });

      // A retried POST — the client retries once on a slow or timed-out
      // response, which lands here after the tab is already open.
      clock.advance(250);
      const retried = await post();
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({ ok: true, url: "http://localhost:12800/console" });
      expect(opened).toHaveLength(1);
    } finally {
      await control.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
