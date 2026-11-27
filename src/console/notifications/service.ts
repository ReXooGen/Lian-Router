import type { RedisClient } from "../../persistence/redis";
import { log } from "../../observability/logger";
import { fetchDailyCheckinStatus } from "../../providers/integrations/buddy/buddy-checkin";
import { listZcodeClaims, type ZcodeClaimListing } from "../../providers/integrations/zcode/zcode-claim";
import type { ProviderId } from "../../providers/provider-registry";
import { checkinDayKeyFor } from "../../workers/daily-checkin";
import type { ProviderNotification, ProviderNotificationsResponse } from "./contracts";
import { claimedPlanKey, notificationCacheKey, readCheckinEvidence, recordCheckinEvidence } from "./store";

export interface NotificationAccount {
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
}

interface NotificationSnapshot {
  readonly checkedAt: string;
  readonly validUntil: number;
  readonly dayKey: string;
  readonly items: readonly ProviderNotification[];
}

interface BuddyStatus {
  readonly state: "due" | "completed" | "unavailable" | "error";
  readonly streakDays: number | null;
}

export interface ProviderNotificationDeps {
  readonly redis: RedisClient;
  readonly resolveCredential: (providerId: ProviderId, accountId: string) => Promise<string>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly buddyStatus?: typeof fetchDailyCheckinStatus;
  readonly listClaims?: (credential: string, fetcher: typeof fetch) => Promise<ZcodeClaimListing>;
}

const FRESH_MS = 60_000;
const CLAIMS_FRESH_MS = 5 * 60_000;
const DESKTOP_FRESH_MS = 10 * 60_000;
const MAX_CONCURRENCY = 3;

/** Per-account snapshots are shared across sessions, after authorization filters the target list. */
export class ProviderNotificationService {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly deps: ProviderNotificationDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private item(account: NotificationAccount, kind: ProviderNotification["kind"], message: string, at: string, plan?: { id: string; name: string }): ProviderNotification {
    const dayKey = account.providerId === "zcode" ? null : checkinDayKeyFor(account.providerId, this.now());
    const title = kind === "checkin_due" ? "Daily check-in available"
      : kind === "checkin_completed" ? "Checked in today"
      : kind === "plan_claimable" ? `Plan available: ${plan?.name ?? "ZCode"}`
      : "Reward status not verified";
    return {
      id: [account.providerId, account.id, kind, plan?.id ?? dayKey ?? "status"].join(":"),
      kind,
      providerId: account.providerId,
      accountId: account.id,
      accountLabel: account.label,
      title,
      message,
      href: `/providers/${encodeURIComponent(account.providerId)}?account=${encodeURIComponent(account.id)}`,
      occurredAt: at,
      dayKey,
      ...(plan ? { planId: plan.id } : {}),
    };
  }

  private unknown(account: NotificationAccount, at: string, message?: string): ProviderNotification {
    return this.item(account, "status_unknown", message ?? "Could not verify the provider status. Open the account to retry.", at);
  }

  /** Fast read: upstream work is queued and never holds the notification request open. */
  async snapshot(accounts: readonly NotificationAccount[]): Promise<ProviderNotificationsResponse> {
    const now = this.now();
    let pending = false;
    const result = await Promise.all(accounts.map(async (account): Promise<readonly ProviderNotification[]> => {
      try {
        const raw = await this.deps.redis.get(notificationCacheKey(account.id));
        if (raw !== null) {
          const cached = JSON.parse(raw) as NotificationSnapshot;
          const dayKey = checkinDayKeyFor(account.providerId, now);
          if (cached.dayKey === dayKey && cached.validUntil > now.getTime() && Array.isArray(cached.items)) {
            return (cached.items as readonly ProviderNotification[]).map(item => ({ ...item, accountLabel: account.label }));
          }
        }
      } catch {
        // The next read remains explicitly unknown while a bounded retry is queued.
      }
      pending = true;
      void this.refresh(account);
      return [this.unknown(account, now.toISOString(), account.providerId === "autoclaw"
        ? "Open the AutoClaw desktop app and refresh the relay to confirm today's check-in."
        : "Checking the provider's reward status. No check-in or plan claim is performed by this read.")];
    }));
    const priority = { checkin_due: 0, plan_claimable: 1, status_unknown: 2, checkin_completed: 3 };
    return {
      items: result.flat().sort((a, b) => priority[a.kind] - priority[b.kind] || a.accountLabel.localeCompare(b.accountLabel) || a.id.localeCompare(b.id)),
      checkedAt: now.toISOString(),
      pending,
    };
  }

  /** Single flight plus a global concurrency budget prevents multi-tab polling from multiplying probes. */
  refresh(account: NotificationAccount): Promise<void> {
    const existing = this.jobs.get(account.id);
    if (existing) return existing;
    const job = new Promise<void>(resolve => {
      this.queue.push(() => {
        this.running += 1;
        void this.probe(account).catch(error => {
          log.warn(`[notifications] refresh failed account=${account.id}`, error as Error);
        }).finally(() => {
          this.running -= 1;
          this.jobs.delete(account.id);
          resolve();
          this.pump();
        });
      });
    });
    this.jobs.set(account.id, job);
    this.pump();
    return job;
  }

  private pump(): void {
    while (this.running < MAX_CONCURRENCY && this.queue.length > 0) this.queue.shift()?.();
  }

  private async probe(account: NotificationAccount): Promise<void> {
    const started = this.now();
    const at = started.toISOString();
    const dayKey = checkinDayKeyFor(account.providerId, started);
    let items: readonly ProviderNotification[];
    let validUntil = started.getTime() + (account.providerId === "zcode" ? CLAIMS_FRESH_MS : FRESH_MS);
    try {
      const signal = AbortSignal.timeout(15_000);
      const upstream = this.deps.fetcher ?? globalThis.fetch;
      const fetcher = Object.assign(
        (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
          upstream(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
        { preconnect: globalThis.fetch.preconnect },
      ) as typeof fetch;
      if (account.providerId === "autoclaw") {
        items = await this.desktopCheckin(account, dayKey, started);
      } else if (account.providerId === "zcode") {
        const credential = await this.deps.resolveCredential(account.providerId as ProviderId, account.id);
        const listing = await (this.deps.listClaims ?? listZcodeClaims)(credential, fetcher);
        const seen = new Set<string>();
        const plans: ProviderNotification[] = [];
        for (const plan of listing.plans) {
          const start = plan.startsAt === null ? null : Date.parse(plan.startsAt);
          const end = plan.endsAt === null ? null : Date.parse(plan.endsAt);
          if (start !== null && (!Number.isFinite(start) || start > started.getTime())) {
            if (start !== null && Number.isFinite(start)) validUntil = Math.min(validUntil, start);
            continue;
          }
          if (end !== null && (!Number.isFinite(end) || end <= started.getTime())) continue;
          if (seen.has(plan.planId)) continue;
          seen.add(plan.planId);
          if (await this.deps.redis.get(claimedPlanKey(account.id, plan.planId))) continue;
          if (end !== null) validUntil = Math.min(validUntil, end);
          plans.push(this.item(account, "plan_claimable", `${plan.name} can be claimed${plan.endsAt ? ` until ${plan.endsAt}` : ""}. Review eligibility and any captcha before claiming.`, at, { id: plan.planId, name: plan.name }));
        }
        items = listing.errors.length > 0
          ? [...plans, this.unknown(account, at, "Some ZCode campaign sources could not be read.")]
          : plans;
      } else {
        const evidence = await readCheckinEvidence(this.deps.redis, account.providerId, account.id, dayKey);
        if (evidence?.state === "completed") {
          items = [this.item(account, "checkin_completed", this.completionMessage(evidence.credit, evidence.streakDays), evidence.observedAt)];
        } else {
          const credential = await this.deps.resolveCredential(account.providerId as ProviderId, account.id);
          const status: BuddyStatus = await (this.deps.buddyStatus ?? fetchDailyCheckinStatus)({ providerId: account.providerId, accountId: account.id, credential, fetcher });
          const confirmed = await readCheckinEvidence(this.deps.redis, account.providerId, account.id, dayKey);
          if (confirmed?.state === "completed") {
            items = [this.item(account, "checkin_completed", this.completionMessage(confirmed.credit, confirmed.streakDays), confirmed.observedAt)];
          } else if (status.state === "due" || status.state === "completed") {
            if (status.state === "completed") {
              await recordCheckinEvidence(this.deps.redis, account.providerId, account.id, { state: "completed", dayKey, observedAt: at, credit: null, streakDays: status.streakDays });
            }
            items = [this.item(account, status.state === "due" ? "checkin_due" : "checkin_completed", status.state === "due" ? "Not checked in today. Open the account to claim." : this.completionMessage(null, status.streakDays), at)];
          } else {
            items = [this.unknown(account, at, status.state === "unavailable" ? "The provider reported no active check-in. Eligibility is unverified." : undefined)];
          }
        }
      }
    } catch {
      items = [this.unknown(account, at)];
    }
    const snapshot: NotificationSnapshot = { checkedAt: at, validUntil, dayKey, items };
    await this.deps.redis.set(notificationCacheKey(account.id), JSON.stringify(snapshot), "EX", 24 * 60 * 60);
  }

  private completionMessage(credit: number | null, streakDays: number | null): string {
    return `Checked in today.${credit !== null && credit > 0 ? ` Reward: ${credit} credits.` : ""}${streakDays !== null ? ` Streak: ${streakDays} days.` : ""}`;
  }

  private async desktopCheckin(account: NotificationAccount, dayKey: string, now: Date): Promise<readonly ProviderNotification[]> {
    const raw = await this.deps.redis.get(`lianrouter:autoclaw:observed:${account.id}`);
    if (raw !== null) {
      const observed = JSON.parse(raw) as { observedAt?: string; checkinDate?: string; claimStatus?: string; claimedAmount?: number; streakDays?: number };
      const time = Date.parse(observed.observedAt ?? "");
      if (observed.checkinDate === dayKey && time <= now.getTime() && now.getTime() - time <= DESKTOP_FRESH_MS) {
        const state = observed.claimStatus === "claimed" ? "completed" : observed.claimStatus === "unclaimed" ? "due" : null;
        if (state !== null) {
          const credit = typeof observed.claimedAmount === "number" && Number.isFinite(observed.claimedAmount) ? observed.claimedAmount : null;
          const streak = typeof observed.streakDays === "number" && Number.isFinite(observed.streakDays) ? observed.streakDays : null;
          if (state === "completed") await recordCheckinEvidence(this.deps.redis, account.providerId, account.id, { state, dayKey, observedAt: observed.observedAt!, credit, streakDays: streak });
          return [this.item(account, state === "completed" ? "checkin_completed" : "checkin_due", state === "completed" ? this.completionMessage(credit, streak) : "AutoClaw's desktop card reports an unclaimed daily check-in. Open the desktop app to claim, then refresh the relay.", observed.observedAt!)];
        }
      }
    }
    const evidence = await readCheckinEvidence(this.deps.redis, account.providerId, account.id, dayKey);
    if (evidence?.state === "completed") return [this.item(account, "checkin_completed", this.completionMessage(evidence.credit, evidence.streakDays), evidence.observedAt)];
    return [this.unknown(account, now.toISOString(), "Open the AutoClaw desktop app and refresh the relay to confirm today's check-in.")];
  }
}
