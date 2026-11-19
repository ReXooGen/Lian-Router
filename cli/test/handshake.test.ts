import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { controlFilePath, readControlFile } from "../tray/paths";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-handshake-test-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "run"), { recursive: true });
  return dir;
}

async function writeHandshake(root: string, handshake: Record<string, unknown>): Promise<void> {
  await writeFile(controlFilePath(root), JSON.stringify(handshake, null, 2), "utf8");
}

/** Exactly what `ControlServer.start()` writes: `startedAt` is `Date.now()`. */
function producedHandshake(): Record<string, unknown> {
  return { port: 42_123, pid: 4242, startedAt: Date.now(), token: "a".repeat(32) };
}

describe("readControlFile", () => {
  it("accepts the handshake the control server actually writes", async () => {
    const root = await tempRoot();
    const produced = producedHandshake();
    await writeHandshake(root, produced);

    const file = readControlFile(root);
    expect(file.port).toBe(42_123);
    expect(file.pid).toBe(4242);
    expect(file.token).toBe("a".repeat(32));
    expect(file.startedAt).toBe(produced["startedAt"] as number);
    expect(typeof file.startedAt).toBe("number");
  });

  it("rejects a string startedAt", async () => {
    const root = await tempRoot();
    await writeHandshake(root, { ...producedHandshake(), startedAt: new Date().toISOString() });

    expect(() => readControlFile(root)).toThrow(/no usable "startedAt"/);
  });

  it("rejects a missing or non-numeric startedAt", async () => {
    const root = await tempRoot();
    const { startedAt: _dropped, ...withoutStart } = producedHandshake();
    void _dropped;
    await writeHandshake(root, withoutStart);
    expect(() => readControlFile(root)).toThrow(/no usable "startedAt"/);

    await writeHandshake(root, { ...producedHandshake(), startedAt: Number.NaN });
    expect(() => readControlFile(root)).toThrow(/no usable "startedAt"/);
  });

  it("still rejects a handshake with no token", async () => {
    const root = await tempRoot();
    const { token: _dropped, ...withoutToken } = producedHandshake();
    void _dropped;
    await writeHandshake(root, withoutToken);
    expect(() => readControlFile(root)).toThrow(/no "token"/);
  });
});

describe("shutdown cleanup", () => {
  it("removes run/control.json and run/lianrouter.pid", async () => {
    const root = await tempRoot();
    await writeHandshake(root, producedHandshake());
    await writeFile(join(root, "run", "lianrouter.pid"), "4242\n", "utf8");

    const { shutdownSessionFiles } = await import("../src/shutdown");
    const stopped: string[] = [];
    await shutdownSessionFiles({
      installRoot: root,
      stopControl: async () => {
        stopped.push("control");
      },
      stopGateway: async () => {
        stopped.push("gateway");
      },
    });

    expect(stopped).toEqual(["control", "gateway"]);
    expect(existsSync(controlFilePath(root))).toBe(false);
    expect(existsSync(join(root, "run", "lianrouter.pid"))).toBe(false);
  });

  it("runs the graceful path once when a signal fires twice", async () => {
    const { installShutdownHandlers } = await import("../src/shutdown");
    let shutdowns = 0;
    let exitCode: number | undefined;
    let release: (() => void) | undefined;
    const registration = installShutdownHandlers(
      () => {
        shutdowns += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      (code) => {
        exitCode = code;
      },
    );

    try {
      // The portable way to exercise the handler in-process: on Windows a real
      // SIGINT cannot be delivered to a child, and `process.emit` is what the
      // runtime itself does when one arrives. The second emit lands while the
      // first shutdown is still pending, which is the case that must not start
      // a second teardown.
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      expect(shutdowns).toBe(1);
      release?.();
      await registration.run();
    } finally {
      registration.dispose();
    }

    expect(shutdowns).toBe(1);
    expect(exitCode).toBe(0);
  });

  it("hands off on SIGHUP when a successor is configured, without teardown", async () => {
    const { installShutdownHandlers } = await import("../src/shutdown");
    let shutdowns = 0;
    let exitCode: number | undefined;
    let handoffs = 0;
    const registration = installShutdownHandlers(
      () => {
        shutdowns += 1;
        return Promise.resolve();
      },
      (code) => {
        exitCode = code;
      },
      async () => {
        handoffs += 1;
        return true;
      },
    );

    try {
      process.emit("SIGHUP", "SIGHUP");
      // The hand-off resolves on a microtask; let it settle.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      registration.dispose();
    }

    expect(handoffs).toBe(1);
    expect(shutdowns).toBe(0);
    expect(exitCode).toBeUndefined();
  });

  it("falls back to teardown on SIGHUP when no successor takes over", async () => {
    const { installShutdownHandlers } = await import("../src/shutdown");
    let shutdowns = 0;
    let exitCode: number | undefined;
    const registration = installShutdownHandlers(
      () => {
        shutdowns += 1;
        return Promise.resolve();
      },
      (code) => {
        exitCode = code;
      },
      async () => false,
    );

    try {
      process.emit("SIGHUP", "SIGHUP");
      await registration.run();
    } finally {
      registration.dispose();
    }

    expect(shutdowns).toBe(1);
    expect(exitCode).toBe(0);
  });

  it("tears down on SIGINT even when a hand-off is available", async () => {
    const { installShutdownHandlers } = await import("../src/shutdown");
    let shutdowns = 0;
    let handoffs = 0;
    const registration = installShutdownHandlers(
      () => {
        shutdowns += 1;
        return Promise.resolve();
      },
      () => undefined,
      async () => {
        handoffs += 1;
        return true;
      },
    );

    try {
      process.emit("SIGINT", "SIGINT");
      await registration.run();
    } finally {
      registration.dispose();
    }

    expect(shutdowns).toBe(1);
    expect(handoffs).toBe(0);
  });
});
