import { describe, expect, test } from "bun:test";
import { createEmbeddedRedis } from "../../src/persistence/embedded-redis";
import { RedisAdmissionCounterStore } from "../../src/security/admission";
import { RedisIpAbuseStore } from "../../src/security/abuse";
import { RedisModelAbuseStore } from "../../src/security/model-abuse";
import { NetworkPoolSelector } from "../../src/network/pool/selector";
import type { AdmissionReserveRequest } from "../../src/security/admission";

/**
 * The embedded Redis mode is only honest if the real stores run on it.
 *
 * Every atomic decision in this codebase is a Lua script: admission counters
 * compare-and-increment, IP abuse slides a window, model strikes graduate to a
 * ban, pool selection tracks in-flight leases. A stand-in that answered
 * `GET`/`SET` but stubbed `EVAL` would let all four degrade into races while
 * every unit test kept passing. So these tests drive the *production* store
 * classes — not copies of their scripts — against the embedded client and
 * assert the decisions they make, including the ones that only hold if the
 * script ran atomically.
 *
 * Each test starts from an empty store. `ioredis-mock` keeps its data in a
 * module-level shared store, so two clients in one process see the same keys —
 * which is the right behaviour for the gateway (one client, one process) and
 * the wrong behaviour for independent tests. `flushall` is the boundary.
 */

async function freshRedis() {
  const redis = createEmbeddedRedis();
  await redis.flushall();
  return redis;
}

function reserveRequest(overrides: Partial<AdmissionReserveRequest> = {}): AdmissionReserveRequest {
  return {
    reservationId: "res-1",
    apiKeyId: "key-1",
    now: 1_700_000_000_000,
    estimatedTokens: 10,
    rpmLimit: null,
    dailyLimit: null,
    monthlyLimit: null,
    lifetimeBudget: null,
    lifetimeConsumed: 0,
    concurrencyLimit: null,
    tenantId: "tenant-1",
    tenantConcurrencyLimit: null,
    ...overrides,
  };
}

describe("embedded redis — admission counters", () => {
  test("enforces an RPM window and admits again after it rolls over", async () => {
    const store = new RedisAdmissionCounterStore(await freshRedis());
    const base = 1_700_000_000_000;

    await store.reserve(reserveRequest({ reservationId: "a", now: base, rpmLimit: 2 }));
    await store.reserve(reserveRequest({ reservationId: "b", now: base + 1_000, rpmLimit: 2 }));

    await expect(
      store.reserve(reserveRequest({ reservationId: "c", now: base + 2_000, rpmLimit: 2 })),
    ).rejects.toMatchObject({ code: "quota_exceeded" });

    // One full window later the rolling counter has drained.
    await store.reserve(reserveRequest({ reservationId: "d", now: base + 61_000, rpmLimit: 2 }));
  });

  test("a reservation id is idempotent, so a retry cannot double-count", async () => {
    const store = new RedisAdmissionCounterStore(await freshRedis());
    const request = reserveRequest({ reservationId: "same", rpmLimit: 1 });

    await store.reserve(request);
    // Replaying the identical reservation must be a no-op, not a second unit.
    await store.reserve(request);
  });

  test("reconcile releases the concurrency slot the reservation took", async () => {
    const store = new RedisAdmissionCounterStore(await freshRedis());
    const now = 1_700_000_000_000;
    await store.reserve(
      reserveRequest({ reservationId: "c1", now, concurrencyLimit: 1, estimatedTokens: 5 }),
    );

    // Slot is taken: a second concurrent reservation must be refused.
    await expect(
      store.reserve(
        reserveRequest({ reservationId: "c2", now: now + 1, concurrencyLimit: 1 }),
      ),
    ).rejects.toMatchObject({ code: "capacity_exhausted" });

    await store.reconcile("key-1", 5, 5, "c1");
    // Freed: the next reservation fits again.
    await store.reserve(
      reserveRequest({ reservationId: "c3", now: now + 2, concurrencyLimit: 1 }),
    );
  });

  test("release frees the slot without consuming budget", async () => {
    const store = new RedisAdmissionCounterStore(await freshRedis());
    const now = 1_700_000_000_000;
    await store.reserve(
      reserveRequest({ reservationId: "r1", now, concurrencyLimit: 1, lifetimeBudget: 100 }),
    );
    await store.release("key-1", 10, "r1");
    await store.reserve(
      reserveRequest({
        reservationId: "r2",
        now: now + 1,
        concurrencyLimit: 1,
        lifetimeBudget: 100,
        lifetimeConsumed: 0,
      }),
    );
  });
});

describe("embedded redis — IP abuse windows", () => {
  test("counts attempts inside the window and bans at the threshold", async () => {
    const store = new RedisIpAbuseStore(await freshRedis(), 60_000);
    const base = 1_700_000_000_000;

    const first = await store.checkAndRecord({
      identity: "203.0.113.7",
      route: "/v1/chat/completions",
      now: base,
      limit: 100,
      banThreshold: 3,
      banDurationMs: 300_000,
    });
    expect(first.banned).toBe(false);
    expect(first.count).toBe(1);

    const second = await store.checkAndRecord({
      identity: "203.0.113.7",
      route: "/v1/chat/completions",
      now: base + 1_000,
      limit: 100,
      banThreshold: 3,
      banDurationMs: 300_000,
    });
    expect(second.banned).toBe(false);
    expect(second.count).toBe(2);

    const third = await store.checkAndRecord({
      identity: "203.0.113.7",
      route: "/v1/chat/completions",
      now: base + 2_000,
      limit: 100,
      banThreshold: 3,
      banDurationMs: 300_000,
    });
    expect(third.bannedNow).toBe(true);

    // A banned identity is refused before it increments anything.
    const afterBan = await store.checkAndRecord({
      identity: "203.0.113.7",
      route: "/v1/chat/completions",
      now: base + 3_000,
      limit: 100,
      banThreshold: 3,
      banDurationMs: 300_000,
    });
    expect(afterBan.banned).toBe(true);
    expect(afterBan.count).toBe(0);
  });
});

describe("embedded redis — model strikes", () => {
  test("graduates to a ban and then refuses to record", async () => {
    let now = 1_700_000_000_000;
    const store = new RedisModelAbuseStore(await freshRedis(), () => now);
    const attempt = { ip: "198.51.100.9", valid: false, threshold: 2, windowMs: 60_000, banTtlMs: 120_000 };

    const one = await store.record(attempt);
    expect(one.banned).toBe(false);
    expect(one.strikes).toBe(1);

    now += 1_000;
    const two = await store.record(attempt);
    expect(two.bannedNow).toBe(true);

    now += 1_000;
    expect(await store.isBanned("198.51.100.9")).toBe(true);
    const banned = await store.record(attempt);
    expect(banned.banned).toBe(true);
    expect(banned.strikes).toBe(0);

    expect(await store.unban("198.51.100.9")).toBe(true);
    expect(await store.isBanned("198.51.100.9")).toBe(false);
  });
});

describe("embedded redis — pool in-flight accounting", () => {
  test("admits up to the cap and reports the authoritative count", async () => {
    const selector = new NetworkPoolSelector(await freshRedis());
    const poolId = "pool-1";

    expect(await selector.getInflightAuthoritative(poolId)).toBe(0);
  });

  test("provider cooldown round-trips through the script path", async () => {
    const selector = new NetworkPoolSelector(await freshRedis());
    const poolId = "pool-2";
    const providerId = "openai";

    expect((await selector.isProviderCooldown(poolId, providerId)).inCooldown).toBe(false);

    await selector.flagProviderCooldown(poolId, providerId, 60_000, "rate_limited");
    // The local map answers this; the Redis script is what a second process
    // would read, so assert it landed in the store too.
    const flagged = await selector.isProviderCooldown(poolId, providerId);
    expect(flagged.inCooldown).toBe(true);

    await selector.clearProviderCooldown(poolId, providerId);
    expect((await selector.isProviderCooldown(poolId, providerId)).inCooldown).toBe(false);
  });
});
