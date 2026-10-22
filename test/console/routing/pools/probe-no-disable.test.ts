import { expect, test } from "bun:test";
import net from "node:net";
import { DrizzleNetworkPoolStore } from "../../../../src/console/routing/pools/store";

/**
 * A manual probe is a diagnostic, not a dispatch decision. A proxy that has
 * just been added by the provider can answer 407 while the new endpoint is
 * still provisioning; letting that single probe disable the pool parked 46 of
 * 100 freshly imported exits even though every one of them tunneled fine
 * moments later.
 */
test("a 407 manual probe records diagnostics without disabling the pool", async () => {
  const proxy = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
    });
  });
  const port = await new Promise<number>((resolve) => {
    proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as net.AddressInfo).port));
  });

  const updates: Array<Record<string, unknown>> = [];
  const row = {
    id: "pool-1",
    status: "active",
    tenantId: "tenant-1",
    kind: "http",
    endpointConfig: { endpoint: `http://user:pass@127.0.0.1:${port}` },
    credentialCiphertext: null,
    maxInflight: 10,
    weight: 100,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastSuccessAt: null,
    lastLatencyMs: null,
    lastHealthCheckAt: null,
    lastErrorAt: null,
    lastError: null,
    lastErrorCategory: null,
    createdAt: new Date(),
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve([row]), {
            limit: async () => [row],
          }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          return Object.assign(Promise.resolve([]), {
            returning: async () => [{ id: "pool-1" }],
          });
        },
      }),
    }),
  } as never;

  try {
    const store = new DrizzleNetworkPoolStore(db, { allowPrivate: true });
    const result = await store.healthCheck("tenant-1", "pool-1");

    expect(result.status).toBe("reachable");
    expect(result.httpStatus).toBe(407);
    // Only the check diagnostics were written; nothing set `status`.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveProperty("lastHealthCheckAt");
    expect(updates[0]).not.toHaveProperty("status");
  } finally {
    proxy.close();
  }
});
