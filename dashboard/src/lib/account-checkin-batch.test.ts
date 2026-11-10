import { describe, expect, test } from "bun:test";
import { runAccountCheckinBatch, type AccountCheckinLike } from "./account-checkin-batch";

function result(state: string, ok = true): AccountCheckinLike {
  return { ok, data: { state } };
}

describe("runAccountCheckinBatch", () => {
  test("runs with bounded concurrency and aggregates every outcome", async () => {
    const responses: Record<string, AccountCheckinLike> = {
      a: result("claimed"),
      b: result("already_claimed"),
      c: result("not_eligible"),
      d: { ok: false, message: "upstream rejected the claim" },
    };
    let active = 0;
    let peak = 0;
    const summary = await runAccountCheckinBatch(
      ["a", "b", "c", "d", "boom"],
      async (accountId) => {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(2);
        active -= 1;
        if (accountId === "boom") throw new Error("account missing");
        return responses[accountId]!;
      },
      2,
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(summary).toMatchObject({
      attempted: 5,
      claimed: 1,
      alreadyClaimed: 1,
      other: 1,
      failed: 2,
    });
    expect(summary.failures.map((failure) => failure.accountId).sort()).toEqual(["boom", "d"]);
    expect(summary.failures.find((failure) => failure.accountId === "d")?.message).toContain(
      "upstream rejected",
    );
  });

  test("empty input resolves without work", async () => {
    const summary = await runAccountCheckinBatch([], async () => result("claimed"));
    expect(summary).toMatchObject({ attempted: 0, claimed: 0, failed: 0 });
  });
});
