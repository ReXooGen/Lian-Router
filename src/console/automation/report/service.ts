// Growth-activity report execution: pick accounts, hit them one at a time.
//
// This module is the single home of the loop the console route and the quota
// sweep both run. Two copies would drift in exactly the way that matters —
// the manual button and the schedule would disagree about which accounts are
// eligible and how fast they may be fired.
//
// Sequential with a fixed gap on purpose: `/v2/report` is a growth endpoint,
// and a burst of a hundred parallel posts from one IP is what trips upstream
// risk control. The cost is wall-clock time, which a background sweep does not
// care about and a manual run of at most 100 accounts absorbs.

import {
  checkinDayKey,
  fetchBuddyActivityReport,
} from "../../../providers/integrations/buddy/buddy-checkin";
import { buddyAccountUid } from "../../../providers/integrations/buddy/buddy-oauth-shared";
import type { ProviderId } from "../../../providers/provider-registry";
import type {
  ReportHitResult,
  ReportHitResponse,
  ReportRunDeps,
  ReportScheduleRecord,
} from "./contracts";

/** Gap between two upstream posts inside one pass. */
export const REPORT_SEQUENTIAL_GAP_MS = 150;

const defaultSleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** UTC start of the current day, matching the provider's own day boundary. */
export function reportDayStart(now: Date): Date {
  return new Date(`${checkinDayKey(now)}T00:00:00.000Z`);
}

/**
 * Reports up to `limit` accounts that have not been reported today.
 *
 * Accounts are chosen oldest-hit-first so a backlog drains in order instead of
 * the same head of the list being retried every run. The loop stops between
 * accounts when the caller aborts: an upstream request already in flight is
 * allowed to finish and be recorded, because discarding its result would leave
 * the database disagreeing with what the provider actually scored.
 */
export async function runReportPass(args: {
  readonly deps: ReportRunDeps;
  readonly providerId: string;
  readonly limit: number;
  readonly tenantId: string | null;
}): Promise<ReportHitResponse> {
  const { deps, providerId, limit, tenantId } = args;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const startedAt = now();

  const picks = await deps.store.pickUnhitAccounts({
    tenantId,
    providerId,
    limit,
    dayStart: reportDayStart(startedAt),
  });

  const results: ReportHitResult[] = [];
  for (const [index, pick] of picks.entries()) {
    if (deps.signal?.aborted === true) break;
    if (index > 0) await sleep(REPORT_SEQUENTIAL_GAP_MS);

    const result = await reportOneAccount({
      deps,
      providerId,
      accountId: pick.id,
      label: pick.label,
    });
    results.push(result);
  }

  const succeeded = results.filter((result) => result.state === "reported").length;
  return {
    ok: results.every((result) => result.state === "reported"),
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

/**
 * One account: resolve credential → report → record. Every failure path writes
 * a `lastState: "error"` row, because "the sweep tried and it failed" is the
 * fact the console needs to show; silently skipping would leave the account
 * looking untouched and the operator guessing.
 */
export async function reportOneAccount(args: {
  readonly deps: ReportRunDeps;
  readonly providerId: string;
  readonly accountId: string;
  readonly label: string;
}): Promise<ReportHitResult> {
  const { deps, providerId, accountId, label } = args;
  const at = (deps.now ?? (() => new Date()))();
  const record = async (state: "reported" | "error", error: string | null): Promise<ReportHitResult> => {
    await deps.store.recordHit({ accountId, providerId, state, error, at });
    return { accountId, label, state, error };
  };

  let credential: string;
  try {
    credential = await deps.resolveCredential(providerId as ProviderId, accountId);
  } catch (error) {
    return record("error", error instanceof Error ? error.message : "Credential resolution failed.");
  }

  // The growth event is scored by uid, and only a JWT carries one. Reporting an
  // opaque API key under some other identity would poison a stranger's streak.
  const userId = buddyAccountUid(credential);
  if (!userId) {
    return record("error", "Activity report needs an OAuth account (no uid in this credential).");
  }

  const result = await fetchBuddyActivityReport({
    providerId,
    accountId,
    credential,
    userId,
    fetcher: deps.fetcher ?? globalThis.fetch,
  });
  return record(result.state === "reported" ? "reported" : "error", result.error);
}

/**
 * Fires one schedule row: the same pass the manual button runs, capped by the
 * row's own `accountsPerRun`. Marks the run afterwards so the interval starts
 * from now even when the pass failed — a broken upstream must not turn a
 * 60-minute schedule into a tight retry loop.
 */
export async function runScheduleOnce(args: {
  readonly deps: ReportRunDeps;
  readonly schedule: ReportScheduleRecord;
}): Promise<ReportHitResponse> {
  const { deps, schedule } = args;
  const response = await runReportPass({
    deps,
    providerId: schedule.providerId,
    limit: schedule.accountsPerRun,
    tenantId: null,
  });
  await deps.store.markScheduleRun(schedule.providerId, (deps.now ?? (() => new Date()))());
  return response;
}
