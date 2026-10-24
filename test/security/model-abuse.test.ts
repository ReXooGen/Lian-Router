import { describe, expect, test } from "bun:test";
import {
  InMemoryModelAbuseStore,
  ModelStrikeService,
  modelAbuseBannedError,
  modelWarningMessage,
  withModelStrikeWarning,
} from "../../src/security/model-abuse";
import { GatewayError } from "../../src/transport/gateway-error";

/**
 * Strike semantics, exercised through the service (not the store directly) so
 * the assertions describe what a request sees: a counter that escalates on
 * invalid attempts only, a ban that trips at the threshold, a ban that lapses
 * on its own, and a ban that does not reset early.
 */
function service(options: { threshold?: number; windowMs?: number; banTtlMs?: number } = {}) {
  let now = 1_000_000;
  const store = new InMemoryModelAbuseStore({ clock: () => now });
  const strikes = new ModelStrikeService(store, {
    threshold: options.threshold ?? 3,
    windowMs: options.windowMs ?? 60_000,
    banTtlMs: options.banTtlMs ?? 10_000,
  });
  return {
    strikes,
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("model-abuse strikes", () => {
  test("invalid attempts accumulate and the threshold trips a ban", async () => {
    const { strikes } = service({ threshold: 3 });
    const ip = "203.0.113.7";

    const first = await strikes.noteInvalid({ ip });
    expect(first).toEqual({ banned: false, strikes: 1, bannedNow: false });
    const second = await strikes.noteInvalid({ ip });
    expect(second).toEqual({ banned: false, strikes: 2, bannedNow: false });

    const third = await strikes.noteInvalid({ ip });
    expect(third.bannedNow).toBe(true);
    expect(third.banned).toBe(true);
    expect(third.strikes).toBe(3);

    expect(await strikes.check({ ip })).toBe(true);
  });

  test("a valid request does not reset the window", async () => {
    const { strikes } = service({ threshold: 3 });
    const ip = "203.0.113.8";

    await strikes.noteInvalid({ ip });
    await strikes.noteInvalid({ ip });
    await strikes.noteValid({ ip });
    const afterValid = await strikes.noteInvalid({ ip });

    // Third invalid attempt trips the ban even though a valid one landed
    // between them: a prober that occasionally guesses a real model name must
    // not be able to erase its own history.
    expect(afterValid.strikes).toBe(3);
    expect(afterValid.bannedNow).toBe(true);
  });

  test("attempts older than the window stop counting", async () => {
    const { strikes, advance } = service({ threshold: 3, windowMs: 60_000 });
    const ip = "203.0.113.9";

    await strikes.noteInvalid({ ip });
    await strikes.noteInvalid({ ip });
    advance(60_001);
    const afterWindow = await strikes.noteInvalid({ ip });

    expect(afterWindow.strikes).toBe(1);
    expect(afterWindow.bannedNow).toBe(false);
  });

  test("a ban lapses on its own and the address is served again", async () => {
    const { strikes, advance } = service({ threshold: 2, banTtlMs: 10_000 });
    const ip = "203.0.113.10";

    await strikes.noteInvalid({ ip });
    const ban = await strikes.noteInvalid({ ip });
    expect(ban.bannedNow).toBe(true);
    expect(await strikes.check({ ip })).toBe(true);

    advance(10_001);
    expect(await strikes.check({ ip })).toBe(false);

    // The window was cleared when the ban was recorded, so the address starts
    // from zero rather than resuming one attempt short of a second ban.
    const afterBan = await strikes.noteInvalid({ ip });
    expect(afterBan.strikes).toBe(1);
    expect(afterBan.bannedNow).toBe(false);
  });

  test("a banned address records no further strikes", async () => {
    const { strikes } = service({ threshold: 2 });
    const ip = "203.0.113.11";

    await strikes.noteInvalid({ ip });
    await strikes.noteInvalid({ ip });
    const whileBanned = await strikes.noteInvalid({ ip });

    expect(whileBanned).toEqual({ banned: true, strikes: 0, bannedNow: false });
  });

  test("another address is unaffected by a ban", async () => {
    const { strikes } = service({ threshold: 2 });
    await strikes.noteInvalid({ ip: "203.0.113.12" });
    await strikes.noteInvalid({ ip: "203.0.113.12" });

    expect(await strikes.check({ ip: "203.0.113.12" })).toBe(true);
    expect(await strikes.check({ ip: "203.0.113.13" })).toBe(false);
  });

  test("the console can lift a ban early and list what is live", async () => {
    const { strikes, advance } = service({ threshold: 2, banTtlMs: 60_000 });

    await strikes.noteInvalid({ ip: "203.0.113.14" });
    await strikes.noteInvalid({ ip: "203.0.113.14" });
    await strikes.ban("203.0.113.15");

    const live = await strikes.listBans();
    expect(live.map((entry) => entry.ip).sort()).toEqual(["203.0.113.14", "203.0.113.15"]);
    for (const entry of live) expect(entry.reason).toBe("repeated_invalid_model_requests");

    expect(await strikes.unban("203.0.113.14")).toBe(true);
    expect(await strikes.check({ ip: "203.0.113.14" })).toBe(false);
    expect(await strikes.unban("203.0.113.14")).toBe(false);

    // A lapsed ban is not listed even before anything sweeps it.
    advance(60_001);
    expect(await strikes.listBans()).toEqual([]);
  });

  test("an operator instant-ban applies the configured TTL", async () => {
    const { strikes } = service({ banTtlMs: 5_000 });
    const ban = await strikes.ban("203.0.113.16");

    expect(ban.ip).toBe("203.0.113.16");
    expect(ban.expiresAt).toBe(1_000_000 + 5_000);
    expect(await strikes.check({ ip: "203.0.113.16" })).toBe(true);
  });
});

describe("model-abuse rejection surface", () => {
  test("the ban error is a distinct 403 the console and client can tell apart", () => {
    const error = modelAbuseBannedError();
    expect(error.code).toBe("model_abuse_banned");
    expect(error.status).toBe(403);
    expect(error.details.reason).toBe("model_abuse_banned");
    // The duration is not disclosed: it would only tell a prober how long to wait.
    expect(error.message).not.toMatch(/\b(hour|minute|second|6h)\b/i);
  });

  test("the warning states the strike count and the remaining allowance", () => {
    const message = modelWarningMessage(
      "gpt-nope",
      { banned: false, strikes: 2, bannedNow: false },
      3,
    );
    expect(message).toContain("Model 'gpt-nope' is not available");
    expect(message).toContain("Warning 2/3");
    expect(message).toContain("1 more invalid request");
  });

  test("re-throwing a rejection keeps the code and status, and adds the count", () => {
    const original = new GatewayError("model_not_found", 404, "model is not allowed", {
      model: "gpt-nope",
    });
    const warned = withModelStrikeWarning(
      original,
      { banned: false, strikes: 1, bannedNow: false },
      3,
    );

    expect(warned).not.toBe(original);
    expect(warned.code).toBe("model_not_found");
    expect(warned.status).toBe(404);
    expect(warned.origin).toBe(original.origin);
    expect(warned.details.model).toBe("gpt-nope");
    expect(warned.details.strikes).toBe(1);
    expect(warned.details.strike_limit).toBe(3);
    expect(warned.details.remaining_before_ban).toBe(2);
  });
});
