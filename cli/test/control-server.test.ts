import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlServer, CONTROL_TOKEN_HEADER, type UpdateProgressFrame } from "../src/control-server";
import type { GatewaySupervisor, ServerStatus } from "../src/supervisor";

/**
 * Control-plane update state, against a real listening socket.
 *
 * The point of `/update/state` is that the launcher outlives the gateway it
 * supervises, so the state cannot live in the child. These tests drive the real
 * `Bun.serve` the control server binds and assert what a reconnecting console
 * would read.
 */

const roots: string[] = [];
const servers: ControlServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.stop();
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const STATUS: ServerStatus = {
  state: "running",
  port: 12_800,
  pid: 4242,
  startedAt: 1,
  lastExitCode: undefined,
  lastError: undefined,
  url: "http://localhost:12800",
};

/** Only the members `ControlServer` touches; a real supervisor needs a child. */
function fakeSupervisor(): GatewaySupervisor {
  return {
    status: STATUS,
    subscribe: () => () => undefined,
    start: async () => STATUS,
    stop: async () => STATUS,
    restart: async () => STATUS,
  } as unknown as GatewaySupervisor;
}

async function startServer(options: {
  startUpdate?: () => Promise<void>;
} = {}): Promise<ControlServer> {
  const root = await mkdtemp(join(tmpdir(), "lianrouter-control-"));
  roots.push(root);
  const control = new ControlServer({
    installRoot: root,
    supervisor: fakeSupervisor(),
    consoleUrl: "http://localhost:12800/console",
    onShutdown: () => undefined,
    ...(options.startUpdate === undefined ? {} : { startUpdate: options.startUpdate }),
  });
  servers.push(control);
  await control.start();
  return control;
}

function call(control: ControlServer, path: string, method: "GET" | "POST" = "GET"): Promise<Response> {
  return fetch(`http://127.0.0.1:${control.port}${path}`, {
    method,
    headers: { [CONTROL_TOKEN_HEADER]: control.controlToken },
  });
}

/**
 * Drains pending microtasks without touching the clock.
 *
 * `setUpdateRunning(false)` runs in the acceptor's `finally`, which is one link
 * further down the promise chain than the flow's own `finally`; a single
 * `await Promise.resolve()` lands before it. `queueMicrotask` resolves after the
 * current queue empties, so this awaits the real signal rather than a duration.
 */
function drainMicrotasks(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(resolve);
  return promise;
}

describe("control plane update state", () => {
  test("reports an empty state before anything happens", async () => {
    const control = await startServer();

    const response = await call(control, "/update/state");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ snapshot: null, progress: null, running: false });
  });

  test("records the snapshot and progress frames it publishes", async () => {
    const control = await startServer();
    control.publishUpdate({ current: "2.0.0", latest: "2.0.5", available: true });
    const frame: UpdateProgressFrame = {
      phase: "downloading",
      percent: 41,
      message: "downloading lianrouter-windows-x64.zip",
      bytesReceived: 1234,
      bytesTotal: 5678,
    };
    control.publishProgress(frame);

    const body = await (await call(control, "/update/state")).json();

    expect(body).toEqual({
      snapshot: { current: "2.0.0", latest: "2.0.5", available: true },
      progress: frame,
      running: false,
    });
    // `/status` carries the same snapshot, so the tray and the console agree.
    const status = await (await call(control, "/status")).json();
    expect(status).toMatchObject({ update: { latest: "2.0.5", available: true } });
  });

  test("clears the progress frame once the flow reports done", async () => {
    const control = await startServer();
    control.publishProgress({ phase: "installing", percent: 92, message: "installing update" });
    control.publishProgress({ phase: "done", percent: 100, message: "updated to 2.0.5" });

    const body = await (await call(control, "/update/state")).json();

    expect(body).toMatchObject({ progress: null });
  });

  test("refuses a second start while one is running", async () => {
    const gate = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    let starts = 0;
    const control = await startServer({
      startUpdate: async () => {
        starts += 1;
        try {
          await gate.promise;
        } finally {
          settled.resolve();
        }
      },
    });

    const first = await call(control, "/update/start", "POST");
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: true });
    expect(await (await call(control, "/update/state")).json()).toMatchObject({ running: true });

    const second = await call(control, "/update/start", "POST");
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "an update is already running" });
    expect(starts).toBe(1);

    gate.resolve();
    // The acceptor's `finally` sits at the end of the flow's promise chain, so
    // drain the whole microtask queue rather than guess a duration.
    await settled.promise;
    await drainMicrotasks();
    expect(control.updateState.running).toBe(false);
  });

  test("clears the running flag when the flow throws", async () => {
    const settled = Promise.withResolvers<void>();
    const control = await startServer({
      startUpdate: async () => {
        try {
          throw new Error("download failed");
        } finally {
          settled.resolve();
        }
      },
    });

    const response = await call(control, "/update/start", "POST");
    expect(response.status).toBe(202);

    await settled.promise;
    await Promise.resolve();
    expect(control.updateState.running).toBe(false);
    expect(control.updateState.progress).toMatchObject({ phase: "error" });
  });

  test("rejects a request without the control token", async () => {
    const control = await startServer();

    const response = await fetch(`http://127.0.0.1:${control.port}/update/state`);

    expect(response.status).toBe(401);
  });
});
