import { describe, expect, test } from "bun:test";
import type { RedisClient } from "../../../src/persistence/redis";
import { ProviderNotificationService, type NotificationAccount, type ProviderNotificationDeps } from "../../../src/console/notifications/service";
import { notificationCacheKey, recordCheckinEvidence, recordClaimedPlan } from "../../../src/console/notifications/store";
import { checkinDayKeyFor, ledgerKey } from "../../../src/workers/daily-checkin";
import type { ZcodeClaimPlan } from "../../../src/providers/integrations/zcode/zcode-claim";

function fixture(providerId = "cbcn", overrides: Partial<ProviderNotificationDeps> = {}) {
  const data = new Map<string, string>();
  const redis = {
    async get(key: string) { return data.get(key) ?? null; },
    async set(key: string, value: string) { data.set(key, value); return "OK"; },
    async del(key: string) { return Number(data.delete(key)); },
  } as unknown as RedisClient;
  let now = new Date("2026-11-27T12:00:00.000Z");
  let credentialReads = 0;
  const account: NotificationAccount = { id: "account-1", providerId, label: "Primary" };
  const service = new ProviderNotificationService({
    redis,
    now: () => now,
    resolveCredential: async () => { credentialReads++; return "test-credential"; },
    ...overrides,
  });
  return { account, service, redis, data, setNow: (next: string) => { now = new Date(next); }, credentialReads: () => credentialReads };
}

function plan(planId: string, startsAt: string | null = null, endsAt: string | null = null): ZcodeClaimPlan {
  return { planId, name: planId, priority: null, startsAt, endsAt, source: "preview" };
}

describe("provider notifications", () => {
  test("due becomes a distinct completion notification, cached reads do not repeat probes", async () => {
    let probes = 0;
    const f = fixture("cbcn", { buddyStatus: async args => { probes++; return { ...args, state: "due", error: null, streakDays: 2 }; } });
    await f.service.refresh(f.account);
    const due = await f.service.snapshot([f.account]);
    expect(due.pending).toBe(false);
    expect(due.items[0]?.kind).toBe("checkin_due");
    await f.service.snapshot([f.account]);
    expect(probes).toBe(1);
    await recordCheckinEvidence(f.redis, "cbcn", f.account.id, { state: "completed", dayKey: "2026-11-27", observedAt: "2026-11-27T12:01:00.000Z", credit: 50, streakDays: 3 });
    await f.service.refresh(f.account);
    const completed = await f.service.snapshot([f.account]);
    expect(completed.items[0]?.kind).toBe("checkin_completed");
    expect(completed.items[0]?.id).not.toBe(due.items[0]?.id);
    expect(completed.items[0]?.message).toContain("50 credits");
    expect(probes).toBe(1);
  });

  test("an attempt marker cannot manufacture check-in completion", async () => {
    const f = fixture("cbcn", { buddyStatus: async args => ({ ...args, state: "error", streakDays: null, error: "upstream down" }) });
    f.data.set(ledgerKey("2026-11-27", f.account.id), "1");
    await f.service.refresh(f.account);
    const result = await f.service.snapshot([f.account]);
    expect(result.items.map(item => item.kind)).toEqual(["status_unknown"]);
    expect(JSON.stringify(result)).not.toContain("upstream down");
  });

  test("missing state returns immediately while a shared background probe is pending", async () => {
    let finish!: (value: Awaited<ReturnType<NonNullable<ProviderNotificationDeps["buddyStatus"]>>>) => void;
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let probes = 0;
    const f = fixture("cbcn", { buddyStatus: () => { probes++; started(); return new Promise(resolve => { finish = resolve; }); } });
    const first = await f.service.snapshot([f.account]);
    await f.service.snapshot([f.account]);
    expect(first.pending).toBe(true);
    expect(first.items[0]?.kind).toBe("status_unknown");
    const pending = f.service.refresh(f.account);
    await began;
    finish({ providerId: "cbcn", accountId: f.account.id, state: "completed", streakDays: 1, error: null });
    await pending;
    expect(probes).toBe(1);
    expect((await f.service.snapshot([f.account])).items[0]?.kind).toBe("checkin_completed");
  });

  test("AutoClaw uses current desktop evidence and retains confirmed completion for the vendor day", async () => {
    const f = fixture("autoclaw");
    const dayKey = checkinDayKeyFor("autoclaw", new Date("2026-11-27T12:00:00Z"));
    f.data.set(`lianrouter:autoclaw:observed:${f.account.id}`, JSON.stringify({ observedAt: "2026-11-27T11:59:00Z", checkinDate: dayKey, claimStatus: "unclaimed" }));
    await f.service.refresh(f.account);
    expect((await f.service.snapshot([f.account])).items[0]?.kind).toBe("checkin_due");
    f.data.set(`lianrouter:autoclaw:observed:${f.account.id}`, JSON.stringify({ observedAt: "2026-11-27T12:00:00Z", checkinDate: dayKey, claimStatus: "claimed", claimedAmount: 300, streakDays: 4 }));
    await f.service.refresh(f.account);
    expect((await f.service.snapshot([f.account])).items[0]?.message).toContain("300 credits");
    f.data.delete(`lianrouter:autoclaw:observed:${f.account.id}`);
    f.setNow("2026-11-27T12:30:00Z");
    await f.service.refresh(f.account);
    expect((await f.service.snapshot([f.account])).items[0]?.kind).toBe("checkin_completed");
    expect(f.credentialReads()).toBe(0);
    f.setNow("2026-11-28T12:00:00Z");
    await f.service.refresh(f.account);
    expect((await f.service.snapshot([f.account])).items[0]?.kind).toBe("status_unknown");
  });

  test.each(["processing", "unclaimed", "claimed"])("stale AutoClaw %s observations and task attempts are not proof", async claimStatus => {
    const f = fixture("autoclaw");
    f.data.set(ledgerKey(checkinDayKeyFor("autoclaw", new Date("2026-11-27T12:00:00Z")), f.account.id), "1");
    f.data.set(`lianrouter:autoclaw:observed:${f.account.id}`, JSON.stringify({ observedAt: "2026-11-27T10:00:00Z", checkinDate: "2026-11-27", claimStatus }));
    await f.service.refresh(f.account);
    expect((await f.service.snapshot([f.account])).items[0]?.kind).toBe("status_unknown");
  });

  test("ZCode emits only current distinct campaigns and removes a redeemed plan", async () => {
    let probes = 0;
    const f = fixture("zcode", { listClaims: async () => { probes++; return { plans: [plan("ready"), plan("ready"), plan("expired", null, "2026-11-26T00:00:00Z"), plan("future", "2026-11-29T00:00:00Z")], errors: [] }; } });
    await f.service.refresh(f.account);
    const first = await f.service.snapshot([f.account]);
    expect(first.items.map(item => item.planId)).toEqual(["ready"]);
    expect(first.items[0]?.href).toContain("?account=account-1");
    await f.service.snapshot([f.account]);
    expect(probes).toBe(1);
    await recordClaimedPlan(f.redis, f.account.id, "ready");
    await f.service.refresh(f.account);
    expect((await f.service.snapshot([f.account])).items).toEqual([]);
  });

  test("partial ZCode failures keep known campaigns without claiming the inventory is complete", async () => {
    const f = fixture("zcode", { listClaims: async () => ({ plans: [plan("ready")], errors: ["secret-bearing vendor response"] }) });
    await f.service.refresh(f.account);
    const response = await f.service.snapshot([f.account]);
    expect(response.items.map(item => item.kind)).toEqual(["plan_claimable", "status_unknown"]);
    expect(JSON.stringify(response)).not.toContain("secret-bearing");
  });

  test("a new day invalidates cached completion instead of carrying it forward", async () => {
    const f = fixture("cbcn", { buddyStatus: async args => ({ ...args, state: "due", streakDays: null, error: null }) });
    await recordCheckinEvidence(f.redis, "cbcn", f.account.id, { state: "completed", dayKey: "2026-11-27", observedAt: "2026-11-27T12:00:00Z", credit: null, streakDays: 1 });
    await f.service.refresh(f.account);
    f.setNow("2026-11-28T00:00:01Z");
    const next = await f.service.snapshot([f.account]);
    expect(next.pending).toBe(true);
    expect(next.items.some(item => item.kind === "checkin_completed")).toBe(false);
    await f.service.refresh(f.account);
    expect((await f.service.snapshot([f.account])).items[0]?.kind).toBe("checkin_due");
    expect(f.data.has(notificationCacheKey(f.account.id))).toBe(true);
  });
});
