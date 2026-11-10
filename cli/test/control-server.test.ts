import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlServer,
  CONTROL_TOKEN_HEADER,
  type UpdateProgressFrame,
  type UpdateSnapshot,
} from "../src/control-server";
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
  onCheckUpdate?: () => Promise<UpdateSnapshot>;
} = {}): Promise<ControlServer> {
  const root = await mkdtemp(join(tmpdir(), "lianrouter-control-"));
  roots.push(root);
  const control = new ControlServer({
    installRoot: root,
    supervisor: fakeSupervisor(),
    consoleUrl: "http://localhost:12800/console",
    onShutdown: () => undefined,
    ...(options.startUpdate === undefined ? {} : { startUpdate: options.startUpdate }),
    ...(options.onCheckUpdate === undefined ? {} : { onCheckUpdate: options.onCheckUpdate }),
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

describe("POST /update/check", () => {
  const SNAPSHOT: UpdateSnapshot = {
    current: "2.2.0",
    latest: "2.2.2",
    available: true,
  };

  test("publishes the snapshot it resolved and returns it", async () => {
    let checks = 0;
    const control = await startServer({
      onCheckUpdate: async () => {
        checks += 1;
        return SNAPSHOT;
      },
    });

    const response = await call(control, "/update/check", "POST");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SNAPSHOT);
    expect(checks).toBe(1);
    // Published, not just returned: the tray reads `/status` and the console
    // reads `/update/state`, and both must see the release this check found.
    expect(control.updateState.snapshot).toEqual(SNAPSHOT);
    expect(await (await call(control, "/status")).json()).toMatchObject({
      update: { latest: "2.2.2", available: true },
    });
  });

  test("coalesces concurrent calls onto one engine check", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    let checks = 0;
    const control = await startServer({
      onCheckUpdate: async () => {
        checks += 1;
        started.resolve();
        await gate.promise;
        return SNAPSHOT;
      },
    });

    // Driven through the method the route calls, not through two sockets: the
    // guard is what is under test, and two `fetch`es race the socket write
    // against the resolution order, which would make the count depend on the
    // scheduler instead of on the coalescing.
    const first = control.checkUpdate();
    await started.promise;
    const second = control.checkUpdate();

    expect(checks).toBe(1);
    gate.resolve();

    expect(await first).toEqual(SNAPSHOT);
    expect(await second).toEqual(SNAPSHOT);
    expect(checks).toBe(1);
  });

  test("two concurrent requests both answer with the coalesced snapshot", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const control = await startServer({
      onCheckUpdate: async () => {
        started.resolve();
        await gate.promise;
        return SNAPSHOT;
      },
    });

    const first = call(control, "/update/check", "POST");
    await started.promise;
    const second = call(control, "/update/check", "POST");
    // The second request needs a turn to reach the handler; the engine call it
    // joins is still parked on the gate either way.
    await drainMicrotasks();
    gate.resolve();

    const [a, b] = await Promise.all([first, second]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(SNAPSHOT);
    expect(await b.json()).toEqual(SNAPSHOT);
  });

  test("starts a fresh check once the previous one settled", async () => {
    let checks = 0;
    const control = await startServer({
      onCheckUpdate: async () => {
        checks += 1;
        return SNAPSHOT;
      },
    });

    await call(control, "/update/check", "POST");
    await call(control, "/update/check", "POST");

    // Coalescing must not become caching: the second call is a second request
    // to the feed, because the operator asked for a re-read.
    expect(checks).toBe(2);
  });

  test("refuses to check while an install is running", async () => {
    let checks = 0;
    const gate = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const control = await startServer({
      startUpdate: async () => {
        try {
          await gate.promise;
        } finally {
          settled.resolve();
        }
      },
      onCheckUpdate: async () => {
        checks += 1;
        return SNAPSHOT;
      },
    });

    const started = await call(control, "/update/start", "POST");
    expect(started.status).toBe(202);

    const refused = await call(control, "/update/check", "POST");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "an update is already running" });
    expect(checks).toBe(0);

    gate.resolve();
    await settled.promise;
    await drainMicrotasks();
    expect(control.updateState.running).toBe(false);
  });

  test("a failing check publishes nothing and leaves the flag clear", async () => {
    const control = await startServer({
      onCheckUpdate: async () => {
        throw new Error("release feed unreachable");
      },
    });
    control.publishUpdate({ current: "2.2.0", latest: "2.2.1", available: false });

    const response = await call(control, "/update/check", "POST");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "update check failed: release feed unreachable",
    });
    // The previous snapshot stands: the launcher learned nothing new, and
    // clearing it would erase a release the console can still install.
    expect(control.updateState.snapshot).toEqual({
      current: "2.2.0",
      latest: "2.2.1",
      available: false,
    });
    expect(control.updateState.running).toBe(false);
  });

  test("a failed check does not wedge the next one", async () => {
    let attempt = 0;
    const control = await startServer({
      onCheckUpdate: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("first attempt failed");
        return SNAPSHOT;
      },
    });

    expect((await call(control, "/update/check", "POST")).status).toBe(502);
    const retry = await call(control, "/update/check", "POST");

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(SNAPSHOT);
    expect(attempt).toBe(2);
  });

  test("answers 501 when the build has no check hook", async () => {
    const control = await startServer();

    const response = await call(control, "/update/check", "POST");

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "update checks are unavailable in this build" });
  });

  test("rejects a check without the control token", async () => {
    const control = await startServer({ onCheckUpdate: async () => SNAPSHOT });

    const response = await fetch(`http://127.0.0.1:${control.port}/update/check`, { method: "POST" });

    expect(response.status).toBe(401);
  });

  test("checkUpdate publishes without a request, which is the boot shape", async () => {
    const control = await startServer({ onCheckUpdate: async () => SNAPSHOT });

    // `openSession` calls exactly this and drops the promise. The snapshot has
    // to reach `/update/state` with no HTTP client involved, otherwise the
    // console's first render has nothing to show until someone clicks.
    const published = await control.checkUpdate();

    expect(published).toEqual(SNAPSHOT);
    expect(control.updateState.snapshot).toEqual(SNAPSHOT);
    expect((await (await call(control, "/update/state")).json()).snapshot).toEqual(SNAPSHOT);
  });

  test("checkUpdate rejects when the build has no hook", async () => {
    const control = await startServer();

    await expect(control.checkUpdate()).rejects.toThrow("update checks are unavailable in this build");
  });
});
