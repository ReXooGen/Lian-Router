// Daily check-in ride-along.
//
// WorkBuddy/CodeBuddy grant a free credit package once per calendar day. This
// claims it for every stored account and logs one line per account, so an
// operator can confirm each account got its daily login credit.
//
// It deliberately has no timer of its own: it rides along with the quota
// refresh sweep (`quota-refresh-worker.ts`), which already resolves a fresh
// credential for each account every few minutes. Adding a second scheduled
// task would just duplicate that credential work for a once-a-day action.
//
// Budget is one attempt per account per day. A Redis day marker reserves the
// right to attempt, so a restart cannot double-post; the marker is released
// again when the attempt errors, so a transient failure retries on a later
// pass instead of forfeiting that day's grant.
//

import type { RedisClient } from "../persistence/redis";
import type { ProviderId } from "../providers/provider-registry";
import { log } from "../observability/logger";
import { buddyAccountUid } from "../providers/integrations/buddy/buddy-oauth-shared";
import {
  DAILY_CHECKIN_PROVIDER_IDS,
  checkinDayKey,
  fetchBuddyActivityReport,
  fetchDailyCheckin,
  type BuddyActivityReportResult,
  type DailyCheckinResult,
} from "../providers/integrations/buddy/buddy-checkin";
import {
  claimAutoClawCheckin,
  reportAutoClawActivity,
  type AutoClawCheckinResult,
} from "../providers/integrations/autoclaw/autoclaw-credits";
import { vendorDayKey } from "../providers/integrations/autoclaw/vendor-day-key";

export { DAILY_CHECKIN_PROVIDER_IDS, checkinDayKey };
export type { BuddyActivityReportResult, DailyCheckinResult };

const LEDGER_KEY_PREFIX = "lianrouter:daily-checkin";
/**
 * Ledger TTL. The key is already scoped to one calendar day, so the TTL only
 * needs to outlive that day; three days covers any timezone/clock skew without
 * relying on the key expiring for correctness.
 */
const LEDGER_TTL_SECONDS = 3 * 24 * 60 * 60;

/** The day-marker key for one account. Exported so the console reads the same key the sweep writes. */
export function ledgerKey(dayKey: string, accountId: string): string {
  return `${LEDGER_KEY_PREFIX}:${dayKey}:${accountId}`;
}

/** True when this pass won the account's day slot and must do the work. */
async function reserveDaySlot(
  redis: RedisClient,
  dayKey: string,
  accountId: string,
): Promise<boolean> {
  // `SET NX EX` is the whole coordination mechanism: one Redis round trip that
  // is atomic across processes, so two gateway instances cannot both attempt
  // the same account on the same day.
  const set = await redis.set(ledgerKey(dayKey, accountId), "1", "EX", LEDGER_TTL_SECONDS, "NX");
  return set !== null;
}

/**
 * Providers whose billing facade exposes the daily check-in routes.
 *
 * AutoClaw is listed separately from `DAILY_CHECKIN_PROVIDER_IDS` because its
 * claim lives on the task proxy rather than the buddy billing facade, but it
 * belongs in the sweep for the same reason: the grant is once a day and free,
 * and an account nobody opens the desktop app for would otherwise never claim
 * it.
 */
export function supportsDailyCheckin(providerId: string): boolean {
  return (
    providerId === "autoclaw" || (DAILY_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId)
  );
}

/**
 * The day key the vendor resets on.
 *
 * Buddy providers reset on UTC; AutoClaw resets on its own local day, measured
 * as UTC+8 (a claim landed 04:58 WIB while the UTC marker still read done).
 * Reserving the slot under the wrong key would keep an account marked as
 * attempted for hours after its grant went live again.
 */
export function checkinDayKeyFor(providerId: string, now: Date = new Date()): string {
  return providerId === "autoclaw" ? vendorDayKey(now) : checkinDayKey(now);
}

export type DailyGrowthPassResult = {
  readonly checkin: DailyCheckinResult;
  readonly report: BuddyActivityReportResult;
};

/**
 * Runs the full daily growth pass for one account: check-in claim first, then
 * (buddy only) the growth-activity report — same order as the dashboard's
 * growth button.
 *
 * The day slot is reserved here, so a caller cannot double-claim. The report
 * leg exists only for the buddy family, so any other provider's pass is the
 * check-in alone and the report field carries a "not supported" marker rather
 * than a fabricated success. The report fires only when the check-in step does
 * not hard-fail — reporting activity for an account whose credential just died
 * is noise at best. A report-side failure never releases the day slot: the
 * credit grant is the valuable half, and a failed report retries tomorrow
 * rather than spinning every sweep pass today.
 *
 * Returns `null` when no slot could be reserved (already settled today).
 */
export async function attemptDailyGrowthPass(args: {
  readonly redis: RedisClient;
  readonly providerId: ProviderId;
  readonly accountId: string;
  /** Refresh-aware credential resolution (the quota sweep's own resolver). */
  readonly resolveCredential: (providerId: ProviderId, accountId: string) => Promise<string>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}): Promise<DailyGrowthPassResult | null> {
  const { redis, providerId, accountId, resolveCredential } = args;
  const dayKey = checkinDayKeyFor(providerId, args.now?.() ?? new Date());

  let reserved = false;
  try {
    reserved = await reserveDaySlot(redis, dayKey, accountId);
  } catch (error) {
    log.warn(`[daily-checkin] ledger unavailable for account=${accountId}`, error as Error);
    reserved = true;
  }
  if (!reserved) return null;

  let credential = "";
  try {
    credential = await resolveCredential(providerId, accountId);
  } catch (error) {
    await redis.del(ledgerKey(dayKey, accountId)).catch(() => undefined);
    return {
      checkin: {
        providerId,
        accountId,
        state: "error",
        credit: null,
        streakDays: null,
        error: error instanceof Error ? error.message : "Daily check-in failed.",
      },
      report: {
        providerId,
        accountId,
        state: "error",
        error: "Skipped (check-in failed).",
      },
    };
  }

  let checkin: DailyCheckinResult;

  if (providerId === "autoclaw") {
    // AutoClaw's claim is the task proxy, not the buddy billing facade, so it
    // takes its own branch. The campaign report runs first for the same reason
    // the console route does it: the engine reads activity, and a period whose
    // reward is still unpaid can settle in this same pass.
    const activity = await reportAutoClawActivity(credential, args.fetcher ?? globalThis.fetch).catch(
      () => false,
    );
    let claimed: AutoClawCheckinResult;
    try {
      claimed = await claimAutoClawCheckin(credential, args.fetcher ?? globalThis.fetch);
    } catch (error) {
      checkin = {
        providerId,
        accountId,
        state: "error",
        credit: null,
        streakDays: null,
        error: error instanceof Error ? error.message : "Daily check-in failed.",
      };
      await redis.del(ledgerKey(dayKey, accountId)).catch(() => undefined);
      return {
        checkin,
        report: {
          providerId,
          accountId,
          state: activity ? "reported" : "unavailable",
          error: null,
        },
      };
    }
    // A failed pass must not consume the day slot: the grant is once a day and
    // free, so a transient transport error has to stay retryable on the next
    // sweep rather than forfeit it.
    if (claimed.state === "error") {
      await redis.del(ledgerKey(dayKey, accountId)).catch(() => undefined);
    }
    checkin = {
      providerId,
      accountId,
      state: claimed.state,
      credit: claimed.state === "claimed" ? claimed.credit : claimed.state === "already_claimed" ? 0 : null,
      streakDays: null,
      error: claimed.error,
    };
    return {
      checkin,
      report: {
        providerId,
        accountId,
        // The campaign report rides on a route that currently answers
        // `410000 Invalid access token` for this credential shape (measured on
        // all seven accounts 2026-11-25). It is best-effort decoration on top of
        // the grant, so a refusal is reported as unavailable rather than as a
        // failure — otherwise every sweep pass prints a warning for an account
        // whose check-in actually worked.
        state: activity ? "reported" : "unavailable",
        error: activity ? null : "Activity report refused.",
      },
    };
  }

  try {
    checkin = await fetchDailyCheckin({
      providerId,
      accountId,
      credential,
      fetcher: args.fetcher ?? globalThis.fetch,
    });
  } catch (error) {
    checkin = {
      providerId,
      accountId,
      state: "error",
      credit: null,
      streakDays: null,
      error: error instanceof Error ? error.message : "Daily check-in failed.",
    };
  }

  if (checkin.state === "error") {
    // Same release rule as the check-in-only path: a transient failure retries
    // on a later pass today, and the report is skipped with it.
    await redis.del(ledgerKey(dayKey, accountId)).catch(() => undefined);
    return {
      checkin,
      report: { providerId, accountId, state: "error", error: "Skipped (check-in failed)." },
    };
  }

  // The growth event scores by uid, and only a JWT carries one. An opaque API
  // key fails closed here — the sweep must never report one account's activity
  // under another account's uid.
  const userId = buddyAccountUid(credential);
  if (!userId) {
    return {
      checkin,
      report: {
        providerId,
        accountId,
        state: "error",
        error: "Skipped (no uid in this credential).",
      },
    };
  }

  let report: BuddyActivityReportResult;
  try {
    report = await fetchBuddyActivityReport({
      providerId,
      accountId,
      credential,
      userId,
      fetcher: args.fetcher ?? globalThis.fetch,
    });
  } catch (error) {
    report = {
      providerId,
      accountId,
      state: "error",
      error: error instanceof Error ? error.message : "Activity report failed.",
    };
  }
  return { checkin, report };
}

