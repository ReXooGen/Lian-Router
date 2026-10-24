import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateRoutes } from "../../src/console/update/routes";
import { LIANROUTER_VERSION } from "../../src/transport/version";
import type { AccessDecision } from "../../src/security/access-control";

/**
 * Update routes against a real fake launcher.
 *
 * The fake is an actual `Bun.serve` on 127.0.0.1 with a real `control.json` on
 * disk, not a stubbed client: the handshake parse, the bearer header, the status
 * mapping, and the 409 path only mean anything when a socket and a file are
 * really involved.
 */

const operator: AccessDecision = {
  id: "user-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
  admissionIdentity: "user-1",
};
const reader: AccessDecision = { ...operator, scopes: ["dashboard:read"] };

const LAUNCHER_HOME_ENV = "LIANROUTER_LAUNCHER_HOME";

const homes: string[] = [];
const servers: Array<Server<unknown>> = [];
const originalHome = process.env[LAUNCHER_HOME_ENV];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env[LAUNCHER_HOME_ENV];
  } else {
    process.env[LAUNCHER_HOME_ENV] = originalHome;
  }
});

interface FakeLauncherOptions {
  readonly state?: unknown;
  readonly startStatus?: number;
  readonly startBody?: unknown;
}

interface FakeLauncher {
  readonly home: string;
  readonly requests: Array<{ readonly path: string; readonly token: string | null }>;
}

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lianrouter-update-"));
  homes.push(home);
  await mkdir(join(home, "run"), { recursive: true });
  return home;
}

async function writeHandshake(home: string, port: number, token = "test-token"): Promise<void> {
  await writeFile(
    join(home, "run", "control.json"),
    `${JSON.stringify({ port, pid: 4242, startedAt: Date.now(), token }, null, 2)}\n`,
    "utf8",
  );
}

async function startLauncher(options: FakeLauncherOptions = {}): Promise<FakeLauncher> {
  const home = await makeHome();
  const requests: Array<{ readonly path: string; readonly token: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push({ path: pathname, token: request.headers.get("x-lianrouter-control") });
      if (pathname === "/update/state") {
        return Response.json(
          options.state ?? { snapshot: null, progress: null, running: false },
        );
      }
      if (pathname === "/update/start") {
        const status = options.startStatus ?? 202;
        return Response.json(options.startBody ?? { accepted: true }, { status });
      }
      return Response.json({ error: `unknown route ${pathname}` }, { status: 404 });
    },
  });
  servers.push(server);
  const port = server.port;
  if (port === undefined) {
    throw new Error("fake launcher bound without a TCP port");
  }
  await writeHandshake(home, port);
  process.env[LAUNCHER_HOME_ENV] = home;
  return { home, requests };
}

function app(access: AccessDecision | undefined, audited: Array<Record<string, unknown>> = []) {
  return createUpdateRoutes({
    accessResolver: () => access,
    auditSink: {
      async record(entry) {
        audited.push({
          action: entry.action,
          target: entry.target,
          detail: entry.detail,
        });
      },
    },
  });
}

describe("update routes", () => {
  test("reports no launcher when LIANROUTER_LAUNCHER_HOME is unset", async () => {
    delete process.env[LAUNCHER_HOME_ENV];

    const response = await app(reader).handle(new Request("http://console.test/update"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      launcher: false,
      current: LIANROUTER_VERSION,
      latest: null,
      available: false,
      notesUrl: null,
      publishedAt: null,
      running: false,
      progress: null,
    });
  });

  test("round-trips a launcher reporting an available update", async () => {
    const launcher = await startLauncher({
      state: {
        snapshot: {
          current: "2.0.0",
          latest: "2.0.5",
          available: true,
          notesUrl: "https://github.com/lianrouter/lianrouter/releases/tag/v2.0.5",
          publishedAt: "2026-10-20T10:00:00Z",
        },
        progress: {
          phase: "downloading",
          percent: 41,
          message: "downloading lianrouter-windows-x64.zip",
          bytesReceived: 1234,
          bytesTotal: 5678,
        },
        running: true,
      },
    });

    const response = await app(reader).handle(new Request("http://console.test/update"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      launcher: true,
      current: "2.0.0",
      latest: "2.0.5",
      available: true,
      notesUrl: "https://github.com/lianrouter/lianrouter/releases/tag/v2.0.5",
      publishedAt: "2026-10-20T10:00:00Z",
      running: true,
      progress: {
        phase: "downloading",
        percent: 41,
        message: "downloading lianrouter-windows-x64.zip",
        bytesReceived: 1234,
        bytesTotal: 5678,
        error: null,
      },
    });
    // The token never leaves the gateway: it is not in the body, and the
    // launcher received it on the header.
    expect(launcher.requests).toEqual([{ path: "/update/state", token: "test-token" }]);
  });

  test("treats a malformed control file as no launcher", async () => {
    const home = await makeHome();
    process.env[LAUNCHER_HOME_ENV] = home;

    for (const body of [
      "{ not json",
      JSON.stringify({ port: "not-a-port", token: "t" }),
      JSON.stringify({ port: 4242 }),
      JSON.stringify({ port: 0, token: "t" }),
      JSON.stringify([]),
    ]) {
      await writeFile(join(home, "run", "control.json"), body, "utf8");
      const response = await app(reader).handle(new Request("http://console.test/update"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        launcher: false,
        available: false,
        running: false,
        progress: null,
      });
    }
  });

  test("accepts a start, audits it, and answers 202", async () => {
    const audited: Array<Record<string, unknown>> = [];
    await startLauncher({
      state: {
        snapshot: { current: "2.0.0", latest: "2.0.5", available: true },
        progress: null,
        running: false,
      },
    });

    const response = await app(operator, audited).handle(
      new Request("http://console.test/update/start", { method: "POST" }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(audited).toEqual([
      {
        action: "settings.update.started",
        target: "2.0.0",
        detail: { latest: "2.0.5" },
      },
    ]);
  });

  test("maps a launcher 409 to update_in_progress", async () => {
    const audited: Array<Record<string, unknown>> = [];
    await startLauncher({
      startStatus: 409,
      startBody: { error: "an update is already running" },
    });

    const response = await app(operator, audited).handle(
      new Request("http://console.test/update/start", { method: "POST" }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "update_in_progress",
      error: "lianrouter Error: an update is already running",
    });
    expect(audited).toEqual([]);
  });

  test("refuses a start with no launcher", async () => {
    delete process.env[LAUNCHER_HOME_ENV];

    const response = await app(operator).handle(
      new Request("http://console.test/update/start", { method: "POST" }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "launcher_unavailable" });
  });

  test("requires dashboard:write to start", async () => {
    const audited: Array<Record<string, unknown>> = [];
    await startLauncher();

    const response = await app(reader, audited).handle(
      new Request("http://console.test/update/start", { method: "POST" }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "insufficient_scope" });
    expect(audited).toEqual([]);
  });

  test("rejects an unauthenticated caller", async () => {
    const response = await app(undefined).handle(new Request("http://console.test/update"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });
});
