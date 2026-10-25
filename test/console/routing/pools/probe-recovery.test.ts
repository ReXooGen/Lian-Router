import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { eq, inArray } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../../../src/persistence/postgres";
import { healthEvents, networkPools, tenants } from "../../../../src/persistence/schema";
import { DrizzleNetworkPoolStore } from "../../../../src/console/routing/pools/store";
import {
  listNetworkPoolHealthEvents,
  recordPoolDispatchOutcome,
  recordPoolProbeOutcome,
} from "../../../../src/network/pool-health-machine";
import { ProxyConnectError } from "../../../../src/network/pool/agent";
import { dbDescribe } from "../../../helpers/db-gate";

/**
 * The recovery direction of the probe asymmetry: a manual probe that fails is
 * only a diagnostic, but a probe that succeeds is evidence the tunnel works and
 * must clear dispatch-health state. Without it a pool parked by one bad minute
 * stays out of routing after it demonstrably tunnels again.
 */
dbDescribe("pool probe recovery", () => {
  let db: LianRouterDatabase;
  let store: DrizzleNetworkPoolStore;
  let proxy: net.Server;
  let proxyPort: number;
  const tenantId = randomUUID();
  const poolIds: string[] = [];

  /** A CONNECT proxy that tunnels to the requested host — a working exit. */
  beforeAll(async () => {
    db = getDb();
    store = new DrizzleNetworkPoolStore(db, { allowPrivate: true });
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "pool-probe-recovery-test", status: "active" });
    proxy = net.createServer((socket) => {
      socket.once("data", (head) => {
        const line = head.toString().split("\r\n")[0] ?? "";
        const target = /^CONNECT (\S+) HTTP/.exec(line)?.[1];
        if (!target) {
          socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        const [host, port] = target.split(":");
        const upstream = net.connect(Number(port), host, () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
      });
    });
    proxyPort = await new Promise<number>((resolve) =>
      proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as net.AddressInfo).port)),
    );
  });

  afterAll(async () => {
    if (poolIds.length > 0) {
      await db.delete(healthEvents).where(inArray(healthEvents.networkPoolId, poolIds));
      await db.delete(networkPools).where(inArray(networkPools.id, poolIds));
    }
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    proxy.close();
  });

  async function insertPool(status: "active" | "degraded" | "cooldown" | "disabled"): Promise<string> {
    const id = randomUUID();
    poolIds.push(id);
    await db.insert(networkPools).values({
      id,
      tenantId,
      kind: "http",
      endpointConfig: { endpoint: `http://127.0.0.1:${proxyPort}` },
      status,
      consecutiveFailures: status === "active" ? 0 : 3,
      ...(status === "cooldown" || status === "degraded"
        ? { cooldownUntil: new Date(Date.now() + 60_000) }
        : {}),
      ...(status === "active"
        ? {}
        : {
            lastError: "Proxy transport failed (proxy_unreachable)",
            lastErrorCategory: "proxy_unreachable",
            lastErrorAt: new Date(Date.now() - 30_000),
          }),
    });
    return id;
  }

  test("a passing probe clears a cooldown pool: status, counter, errors, event", async () => {
    const poolId = await insertPool("cooldown");
    const result = await store.healthCheck(tenantId, poolId);
    expect(result.status).toBe("healthy");

    const after = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0]!;
    expect(after).toMatchObject({
      status: "active",
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastError: null,
      lastErrorCategory: null,
      lastErrorAt: null,
    });
    expect(after.lastSuccessAt).toBeInstanceOf(Date);
    expect(after.lastHealthCheckAt).toBeInstanceOf(Date);

    const events = await listNetworkPoolHealthEvents(db, tenantId, poolId);
    expect(events).toContainEqual(
      expect.objectContaining({
        fromStatus: "cooldown",
        toStatus: "active",
        errorCategory: null,
      }),
    );
  });

  test("a passing probe promotes a degraded pool the same way", async () => {
    const poolId = await insertPool("degraded");
    expect((await store.healthCheck(tenantId, poolId)).status).toBe("healthy");
    const after = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0]!;
    expect(after).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  test("a passing probe never resurrects an operator-disabled pool", async () => {
    const poolId = await insertPool("disabled");
    // A cached agent can outlive a disable, so a real probe can legitimately
    // come back healthy for a disabled row; the recorder is what must refuse.
    const promoted = await recordPoolProbeOutcome(db, tenantId, poolId, {
      status: "healthy",
      latencyMs: 40,
    });
    expect(promoted).toBe(false);
    await store.healthCheck(tenantId, poolId);
    const after = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0]!;
    expect(after.status).toBe("disabled");
    expect(after.lastHealthCheckAt).toBeInstanceOf(Date);
    expect(after.lastSuccessAt).toBeNull();
    expect(await listNetworkPoolHealthEvents(db, tenantId, poolId)).toHaveLength(0);
  });

  test("a failing probe records diagnostics without demoting", async () => {
    const poolId = await insertPool("active");
    // Reachable-but-refusing is the failure shape that must not park a pool.
    const promoted = await recordPoolProbeOutcome(db, tenantId, poolId, {
      status: "reachable",
      latencyMs: 12,
    });
    expect(promoted).toBe(false);
    const after = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0]!;
    expect(after).toMatchObject({ status: "active", consecutiveFailures: 0, lastSuccessAt: null });
    expect(after.lastHealthCheckAt).toBeInstanceOf(Date);
    expect(after.lastLatencyMs).toBe(12);
    expect(await listNetworkPoolHealthEvents(db, tenantId, poolId)).toHaveLength(0);
  });

  test("a failing probe leaves an already-parked pool parked", async () => {
    const poolId = await insertPool("cooldown");
    const promoted = await recordPoolProbeOutcome(db, tenantId, poolId, {
      status: "timeout",
      latencyMs: 8_000,
    });
    expect(promoted).toBe(false);
    const after = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0]!;
    expect(after).toMatchObject({ status: "cooldown", consecutiveFailures: 3 });
  });

  test("the add-form probe labels a CONNECT rejection like the saved-pool probe", async () => {
    const rejecting = net.createServer((socket) => {
      socket.once("data", () => {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
      });
    });
    const rejectingPort = await new Promise<number>((resolve) =>
      rejecting.listen(0, "127.0.0.1", () => resolve((rejecting.address() as net.AddressInfo).port)),
    );
    try {
      const adhoc = await store.probeAdHoc(tenantId, {
        kind: "http",
        endpoint: `http://127.0.0.1:${rejectingPort}`,
      });
      expect(adhoc.status).toBe("reachable");
      expect(adhoc.httpStatus).toBe(407);
      expect(adhoc.errorMessage).toContain("refused the tunnel");
    } finally {
      rejecting.close();
    }
  });

  test("a CONNECT tunnel fault from dispatch parks the pool", async () => {
    const poolId = await insertPool("active");
    // The attempt loop reports this as a non-GatewayError with
    // `errorOrigin: "gateway"`, which is why the category has to come from the
    // error type rather than from `origin`.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await recordPoolDispatchOutcome(db, poolId, {
        succeeded: false,
        error: new ProxyConnectError(poolId, 0, "handshake timed out"),
        errorOrigin: "gateway",
      });
    }
    const after = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0]!;
    expect(after).toMatchObject({
      status: "cooldown",
      consecutiveFailures: 3,
      lastErrorCategory: "proxy_unreachable",
    });
  });

  test("recovery resets the counter so one new fault does not re-park the pool", async () => {
    const poolId = await insertPool("cooldown");
    await store.healthCheck(tenantId, poolId);
    const recovered = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0]!;
    expect(recovered.consecutiveFailures).toBe(0);

    // A single transport fault after recovery must read `degraded`, not jump
    // straight back to `cooldown` on a stale counter of 3.
    await recordPoolDispatchOutcome(db, poolId, {
      succeeded: false,
      error: new Error("proxy connection refused"),
      errorOrigin: "network",
    });
    const after = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0]!;
    expect(after).toMatchObject({ status: "degraded", consecutiveFailures: 1 });
  });

  test("re-enabling a parked pool clears the counter and the error fields", async () => {
    const poolId = await insertPool("cooldown");
    const updated = await store.update(tenantId, poolId, { status: "active" });
    expect(updated?.status).toBe("active");
    const after = (await db.select().from(networkPools).where(eq(networkPools.id, poolId)))[0]!;
    expect(after).toMatchObject({
      status: "active",
      consecutiveFailures: 0,
      cooldownUntil: null,
      lastError: null,
      lastErrorCategory: null,
      lastErrorAt: null,
    });
    expect(after.lastRecoveredAt).toBeInstanceOf(Date);
  });
});
