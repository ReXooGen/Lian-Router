import { describe, expect, test } from "bun:test";
import { createTunnelRoutes, type TunnelStatus } from "../../../src/console/tunnel/contracts";
import { ConsoleDomainError } from "../../../src/console/shared/errors";
import type { AccessDecision } from "../../../src/security/access-control";

const TUNNEL_URL = "https://remainder-portsmouth-roman-sends.trycloudflare.com";

const running: TunnelStatus = {
  running: true,
  publicUrl: TUNNEL_URL,
  startedAt: "2026-10-22T09:00:00.000Z",
  error: null,
};

const operator: AccessDecision = {
  id: "user-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
  admissionIdentity: "user-1",
};
const reader: AccessDecision = { ...operator, scopes: ["dashboard:read"] };

function app(access: AccessDecision | undefined, audited: string[] = [], startFails = false) {
  return createTunnelRoutes({
    service: {
      status: () => running,
      start: async () => {
        if (startFails) {
          throw new ConsoleDomainError("tunnel_unavailable", 502, "Could not start cloudflared");
        }
        return running;
      },
      stop: async () => ({ running: false, publicUrl: null, startedAt: null, error: null }),
    },
    accessResolver: () => access,
    auditSink: {
      async record(entry) {
        audited.push(entry.action);
      },
    },
  });
}

describe("tunnel routes", () => {
  test("serves the status to a dashboard reader", async () => {
    const response = await app(reader).handle(new Request("http://console.test/tunnel"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(running);
  });

  test("refuses start and stop without dashboard:write", async () => {
    const audited: string[] = [];
    for (const path of ["/tunnel/start", "/tunnel/stop"]) {
      const response = await app(reader, audited).handle(
        new Request(`http://console.test${path}`, { method: "POST" }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "insufficient_scope" });
    }
    expect(audited).toEqual([]);
  });

  test("audits a start and a stop", async () => {
    const audited: string[] = [];
    const routes = app(operator, audited);

    const started = await routes.handle(
      new Request("http://console.test/tunnel/start", { method: "POST" }),
    );
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual(running);

    const stopped = await routes.handle(
      new Request("http://console.test/tunnel/stop", { method: "POST" }),
    );
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ running: false, publicUrl: null });

    expect(audited).toEqual(["tunnel.started", "tunnel.stopped"]);
  });

  test("audits a failed start and returns the typed 502", async () => {
    const audited: string[] = [];
    const response = await app(operator, audited, true).handle(
      new Request("http://console.test/tunnel/start", { method: "POST" }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "tunnel_unavailable" });
    expect(audited).toEqual(["tunnel.start_failed"]);
  });

  test("rejects an unauthenticated caller", async () => {
    const response = await app(undefined).handle(new Request("http://console.test/tunnel"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });
});
