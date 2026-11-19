import { describe, expect, test } from "bun:test";
import {
  startAutoClawLoopbackBridge,
  stopAutoClawLoopbackBridge,
} from "../../../../src/providers/integrations/autoclaw/loopback-bridge";


/** The gateway-side completion endpoint the bridge forwards to. */
const completions: Array<{ code: string; state: string }> = [];

describe("autoclaw loopback bridge", () => {
  test("forwards the callback to the gateway completion endpoint", async () => {
    const fetchFn = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const body = JSON.parse(String(init?.body ?? "{}")) as { code: string; state: string };
      completions.push(body);
      expect(url).toBe("http://127.0.0.1:1/console/api/providers/autoclaw/oauth/complete");
      return new Response(JSON.stringify({ accountId: "acc-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const start = startAutoClawLoopbackBridge({
      gatewayOrigin: "http://127.0.0.1:1",
      fetchFn,
      port: 0,
    });
    expect(start.started).toBe(true);
    const bound = start.port;
    try {
      const response = await fetch(
        `http://127.0.0.1:${bound}/auth/callback-zai?code=code-1&state=st-1`,
      );
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("Account connected");
      expect(completions).toEqual([{ code: "code-1", state: "st-1" }]);
    } finally {
      stopAutoClawLoopbackBridge();
    }
  });

  test("reports a failed exchange without throwing", async () => {
    const fetchFn = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: "bad state" }), { status: 400 });
    const start = startAutoClawLoopbackBridge({
      gatewayOrigin: "http://127.0.0.1:1",
      fetchFn,
      port: 0,
    });
    expect(start.started).toBe(true);
    const bound = start.port;
    try {
      const response = await fetch(
        `http://127.0.0.1:${bound}/auth/callback-zai?code=x&state=y`,
      );
      const html = await response.text();
      expect(html).toContain("Login failed");
    } finally {
      stopAutoClawLoopbackBridge();
    }
  });

  test("rejects other paths and missing params", async () => {
    const start = startAutoClawLoopbackBridge({
      gatewayOrigin: "http://127.0.0.1:1",
      fetchFn: async (): Promise<Response> => new Response("{}", { status: 200 }),
      port: 0,
    });
    expect(start.started).toBe(true);
    const bound = start.port;
    try {
      const other = await fetch(`http://127.0.0.1:${bound}/other`);
      expect(other.status).toBe(404);
      const missing = await fetch(`http://127.0.0.1:${bound}/auth/callback-zai`);
      expect(await missing.text()).toContain("no code");
    } finally {
      stopAutoClawLoopbackBridge();
    }
  });
});
