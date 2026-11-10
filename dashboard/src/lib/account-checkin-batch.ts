// Bounded fan-out for the console's bulk daily check-in. Kept free of React
// Query and hook imports so it can be exercised directly; the hook in
// `hooks/quota.ts` wires it to the per-account console route.

/** The subset of one check-in response the batch aggregation needs. */
export interface AccountCheckinLike {
  readonly ok: boolean;
  readonly message?: string;
  readonly data?: { readonly state: string };
}

/** One account's failure inside a bulk check-in. */
export interface BulkCheckinFailure {
  readonly accountId: string;
  readonly message: string;
}

/** Aggregated outcome of a bulk check-in. */
export interface BulkCheckinSummary {
  readonly attempted: number;
  readonly claimed: number;
  readonly alreadyClaimed: number;
  /** Non-error states that granted nothing: not eligible, event ended, unavailable. */
  readonly other: number;
  readonly failed: number;
  readonly failures: readonly BulkCheckinFailure[];
}

function checkinErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Check-in failed";
}

/**
 * Runs one check-in per account through a small worker pool and aggregates the
 * outcomes. Sequential fan-out would make a filtered set of a few dozen
 * accounts take minutes; unbounded fan-out would open a request per account at
 * once. Four keeps the operator's action responsive without looking like a
 * burst to the billing facade.
 */
export async function runAccountCheckinBatch(
  accountIds: readonly string[],
  checkin: (accountId: string) => Promise<AccountCheckinLike>,
  concurrency = 4,
): Promise<BulkCheckinSummary> {
  const queue = [...accountIds];
  const outcomes: Array<{
    readonly accountId: string;
    readonly result?: AccountCheckinLike;
    readonly error?: string;
  }> = [];
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const accountId = queue.shift();
      if (accountId === undefined) return;
      try {
        outcomes.push({ accountId, result: await checkin(accountId) });
      } catch (error) {
        outcomes.push({ accountId, error: checkinErrorMessage(error) });
      }
    }
  });
  await Promise.all(workers);

  let claimed = 0;
  let alreadyClaimed = 0;
  let other = 0;
  const failures: BulkCheckinFailure[] = [];
  for (const outcome of outcomes) {
    const result = outcome.result;
    if (result?.ok === true) {
      if (result.data?.state === "claimed") claimed += 1;
      else if (result.data?.state === "already_claimed") alreadyClaimed += 1;
      else other += 1;
      continue;
    }
    failures.push({
      accountId: outcome.accountId,
      message: result?.message ?? outcome.error ?? "Check-in failed",
    });
  }
  return {
    attempted: accountIds.length,
    claimed,
    alreadyClaimed,
    other,
    failed: failures.length,
    failures,
  };
}
