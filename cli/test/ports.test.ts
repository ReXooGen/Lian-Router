/**
 * The port pre-flight and `--auto-port`, exercised against real sockets.
 *
 * These are integration tests on purpose: the behaviour they pin is Windows
 * kernel behaviour (`SO_REUSEPORT` hiding a conflict from both the listener and a
 * plain bind attempt), so a mock would assert the opposite of what the operating
 * system does.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { applyAutoPort } from "../src/launcher";
import { describePortConflict, findFreePort, isPortBusy } from "../src/ports";

/** Ports parked well above the ephemeral range so a parallel suite cannot take one. */
const BASE_PORT = 46_120;

const servers: { stop: (force?: boolean) => void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

/** Binds the way the gateway does: with `reusePort`, which hides collisions. */
function gatewayShapedListener(port: number): void {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    reusePort: true,
    fetch: () => new Response("serving"),
  });
  servers.push(server);
}

describe("isPortBusy", () => {
  it("reports a gateway-shaped listener as busy", async () => {
    // The regression this pins: a bind probe answered "free" here, because
    // Windows lets a plain listener share a port that `SO_REUSEPORT` holds. A
    // launcher that trusted it spawned a second gateway that received no
    // traffic, while its health check passed against the first one.
    gatewayShapedListener(BASE_PORT);
    expect(await isPortBusy(BASE_PORT)).toBe(true);
  });

  it("reports a closed port as free", async () => {
    expect(await isPortBusy(BASE_PORT + 1)).toBe(false);
  });

  it("reports the port as free again once the listener stops", async () => {
    gatewayShapedListener(BASE_PORT + 2);
    expect(await isPortBusy(BASE_PORT + 2)).toBe(true);
    for (const server of servers.splice(0)) {
      server.stop(true);
    }
    // The kernel releases the socket synchronously on stop(true); the loopback
    // connect that follows is refused immediately.
    expect(await isPortBusy(BASE_PORT + 2)).toBe(false);
  });
});

describe("findFreePort", () => {
  it("skips a taken port and returns the next one", async () => {
    gatewayShapedListener(BASE_PORT + 10);
    expect(await findFreePort(BASE_PORT + 10)).toBe(BASE_PORT + 11);
  });

  it("returns undefined when the whole window is taken", async () => {
    gatewayShapedListener(BASE_PORT + 20);
    gatewayShapedListener(BASE_PORT + 21);
    expect(await findFreePort(BASE_PORT + 20, 2)).toBeUndefined();
  });
});

describe("describePortConflict", () => {
  it("names the port and the free alternative", () => {
    expect(describePortConflict(12_800, 12_801)).toBe(
      "port 12800 is already in use; stop the other process or pass --port 12801",
    );
  });

  it("says so when no alternative was found", () => {
    expect(describePortConflict(12_800, undefined)).toContain("no free port in the next 20");
  });
});

describe("applyAutoPort", () => {
  const baseOptions = {
    host: "localhost",
    noOpen: true,
    background: false,
    headless: false,
    help: false,
    version: false,
    command: undefined,
  } as const;

  it("leaves the port alone when the flag is absent", async () => {
    gatewayShapedListener(BASE_PORT + 30);
    const result = await applyAutoPort({ ...baseOptions, port: BASE_PORT + 30, autoPort: false });
    expect(result.port).toBe(BASE_PORT + 30);
  });

  it("moves to the next free port when the flag is set and the port is taken", async () => {
    gatewayShapedListener(BASE_PORT + 31);
    const result = await applyAutoPort({ ...baseOptions, port: BASE_PORT + 31, autoPort: true });
    expect(result.port).toBe(BASE_PORT + 32);
  });

  it("keeps the port when the flag is set but the port is free", async () => {
    const result = await applyAutoPort({ ...baseOptions, port: BASE_PORT + 33, autoPort: true });
    expect(result.port).toBe(BASE_PORT + 33);
  });

  it("never moves a port for status or stop", async () => {
    // Those commands answer a question about a machine; reporting on a different
    // port than the one asked about would be a lie.
    gatewayShapedListener(BASE_PORT + 34);
    for (const command of ["status", "stop", "update"] as const) {
      const result = await applyAutoPort({ ...baseOptions, port: BASE_PORT + 34, autoPort: true, command });
      expect(result.port).toBe(BASE_PORT + 34);
    }
  });
});
