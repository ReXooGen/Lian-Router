import { describe, expect, test } from "bun:test";
import { NetworkPoolSelector } from "../../src/network/pool/selector";

describe("NetworkPoolSelector cooldown visibility", () => {
  test("flagProviderCooldown publishes the local cooldown in the same tick, before its first await", async () => {
    // No Redis client: the selector stays single-process, so the in-process map
    // is the only cooldown state and the redis branch never runs.
    const selector = new NetworkPoolSelector();
    const poolId = "pool-cooldown-sync";
    const providerId = "openai";

    // Mirrors the egress-failover caller, which flags fire-and-forget and then
    // re-acquires a lease immediately. If the map write ever moved below an
    // await, that re-selection would hand back the exit that just failed.
    void selector.flagProviderCooldown(poolId, providerId, 60_000, "rate limited");

    // `isProviderCooldown` settles its local hit synchronously — the map read
    // and the returned value are computed before the function's first await —
    // so this observes the map as it stood when the flag call returned, not
    // after the flag's continuation had a chance to run.
    const state = await selector.isProviderCooldown(poolId, providerId);
    expect(state.inCooldown).toBe(true);
    expect(state.reason).toBe("rate limited");
  });
});
