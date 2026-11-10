// Appeal execution: pick banned accounts, appeal them one at a time.
//
// Same shape as the report pass (`report/service.ts`) for the same reason: the
// manual button and any future sweep must agree on eligibility and pacing. One
// credential resolution + one upstream POST per account, sequential with a
// fixed gap — a burst of parallel feedback posts is exactly the pattern risk
// control punishes.

import type { ProviderId } from "../../../providers/provider-registry";
import {
  APPEAL_DECLINE_AFTER_MS,
  type AppealProbeOutcome,
  type AppealRecheckResponse,
  type AppealRecheckResult,
  type AppealRoutesConfig,
  type AppealSendResult,
  type AppealSendResponse,
  type AppealVerdictCandidate,
} from "./contracts";
import { APPEAL_SEQUENTIAL_GAP_MS, defaultAppealMessage, sendAppealForAccount } from "./upstream";

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/**
 * Appeals up to `limit` banned accounts. `onlyUnappealed` bounds a batch to
 * accounts without a prior acknowledgement unless the caller explicitly asks to
 * re-send (an upstream that already holds a ticket must not get dozens more).
 */
export async function runAppealPass(args: {
  readonly deps: AppealRoutesConfig;
  readonly providerId: string;
  readonly limit: number;
  readonly tenantId: string;
  readonly message: string;
  readonly onlyUnappealed: boolean;
}): Promise<AppealSendResponse> {
  const { deps, providerId, tenantId } = args;
  const picks = await deps.store.pickBannedAccounts({
    tenantId,
    providerId,
    limit: args.limit,
    onlyUnappealed: args.onlyUnappealed,
  });

  const message = args.message.trim();

  const results: AppealSendResult[] = [];
  for (const [index, pick] of picks.entries()) {
    if (index > 0) await sleep(APPEAL_SEQUENTIAL_GAP_MS);
    // A custom message goes out verbatim to every account in the batch; the
    // default substitutes each account's own label, never another's.
    const effective = message || defaultAppealMessage(pick.label);
    results.push(
      await appealOneAccount({
        deps,
        providerId,
        accountId: pick.id,
        label: pick.label,
        message: effective,
        recordMessage: effective,
      }),
    );
  }

  const succeeded = results.filter((result) => result.state === "appealed").length;
  return {
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

/**
 * One account: resolve credential → POST appeal → record. Every failure path
 * writes a `lastState: "error"` row, because "the operator tried and it failed"
 * is exactly what the console must show; silently skipping would leave the
 * account looking untouched.
 */
export async function appealOneAccount(args: {
  readonly deps: AppealRoutesConfig;
  readonly providerId: string;
  readonly accountId: string;
  readonly label: string;
  readonly message: string;
  readonly recordMessage: string;
}): Promise<AppealSendResult> {
  const { deps, providerId, accountId, label } = args;
  const at = (deps.now ?? (() => new Date()))();
  const record = async (
    state: AppealSendResult["state"],
    feedbackId: number | null,
    error: string | null,
  ): Promise<AppealSendResult> => {
    await deps.store.recordAppeal({
      accountId,
      providerId,
      succeeded: state === "appealed",
      feedbackId,
      error,
      message: args.recordMessage,
      at,
    });
    return { accountId, label, state, feedbackId, error };
  };

  let credential: string;
  try {
    credential = await deps.resolveCredential(providerId as ProviderId, accountId);
  } catch (error) {
    return record("error", null, error instanceof Error ? error.message : "Credential resolution failed.");
  }

  const result = await sendAppealForAccount({
    providerId,
    accountId,
    label,
    credential,
    message: args.message,
    fetcher: deps.fetcher ?? globalThis.fetch,
  });
  return record(result.state, result.feedbackId, result.error);
}

/**
 * Judges whether a failed probe still shows the ban.
 *
 * The probe's error string drops the upstream envelope's `code`
 * (`computeProbeVerdict` keeps the message, not the raw body), so the HTTP
 * status carries the signal: this family answers a restricted account with 403
 * `11140` "request illegal". A 403 caused by a request-shape refusal (`11128`
 * channel verification) is not a verdict on the account, so it is excluded
 * explicitly rather than being read as a ban.
 */
function stillRestricted(outcome: AppealProbeOutcome): boolean {
  const text = outcome.error ?? "";
  if (/\b11128\b|conversation id|channel verification|failed channel/i.test(text)) return false;
  if (/\b11140\b|request illegal|has been restricted/i.test(text)) return true;
  return outcome.statusCode === 403;
}

/**
 * Derives the verdict for up to `limit` acknowledged appeals.
 *
 * Sequential with the same fixed gap as the send pass: every probe is a real
 * upstream turn on an account the risk system already flagged, and a burst is
 * the pattern that got it flagged. One account's failure never aborts the batch,
 * and a probe that says nothing about the ban (network, 5xx, timeout) leaves the
 * appeal pending instead of guessing.
 */
export async function runAppealRecheck(args: {
  readonly deps: AppealRoutesConfig;
  readonly providerId: string;
  readonly tenantId: string;
  readonly modelId: string;
  readonly limit: number;
}): Promise<AppealRecheckResponse> {
  const { deps, providerId, tenantId, modelId } = args;
  const candidates = await deps.store.pickAwaitingVerdict({
    tenantId,
    providerId,
    limit: args.limit,
  });

  const results: AppealRecheckResult[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (index > 0) await sleep(APPEAL_SEQUENTIAL_GAP_MS);
    results.push(await recheckOne({ deps, providerId, tenantId, modelId, candidate }));
  }

  const accepted = results.filter((entry) => entry.verdict === "accepted").length;
  const declined = results.filter((entry) => entry.verdict === "declined").length;
  return {
    providerId,
    attempted: results.length,
    accepted,
    declined,
    pending: results.length - accepted - declined,
    results,
  };
}

/**
 * One account: probe → derive → record. Every path returns a result; nothing
 * here throws, because a single dead account must not abort the batch.
 */
async function recheckOne(args: {
  readonly deps: AppealRoutesConfig;
  readonly providerId: string;
  readonly tenantId: string;
  readonly modelId: string;
  readonly candidate: AppealVerdictCandidate;
}): Promise<AppealRecheckResult> {
  const { deps, providerId, tenantId, modelId, candidate } = args;
  const base = { accountId: candidate.id, label: candidate.label };
  try {
    const probe = await deps.probeAccount({
      tenantId,
      providerId,
      accountId: candidate.id,
      modelId,
    });
    const at = (deps.now ?? (() => new Date()))();
    if (probe.ok) {
      await deps.store.recordVerdict({ accountId: candidate.id, verdict: "accepted", at });
      // The account demonstrably works again, so it is no longer banned: put it
      // back in rotation. Recovery is reported separately — the verdict stands
      // even if the health write fails.
      try {
        await deps.recoverAccount(candidate.id);
      } catch (error) {
        return { ...base, verdict: "accepted", error: messageOfError(error) };
      }
      return { ...base, verdict: "accepted", error: null };
    }
    if (!stillRestricted(probe)) {
      return { ...base, verdict: "pending", error: probe.error ?? null };
    }
    // Still restricted. Under the review window the appeal may simply not have
    // been read yet; past it, the restriction is the answer.
    if (at.getTime() - candidate.appealedAt.getTime() < APPEAL_DECLINE_AFTER_MS) {
      return { ...base, verdict: "pending", error: probe.error ?? null };
    }
    await deps.store.recordVerdict({ accountId: candidate.id, verdict: "declined", at });
    return { ...base, verdict: "declined", error: probe.error ?? null };
  } catch (error) {
    return { ...base, verdict: "pending", error: messageOfError(error) };
  }
}

function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : "Recheck failed.";
}
