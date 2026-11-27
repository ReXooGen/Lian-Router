import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import { queryKeys } from "../query-keys";
import { querySignal } from "./common";
import {
  runAccountCheckinBatch,
  type BulkCheckinSummary,
} from "../account-checkin-batch";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";


export interface QuotaProviderSummary {
  readonly id: string;
  readonly name: string;
  readonly icon?: string;
}

export interface QuotaWindow {
  readonly kind?: string;
  readonly label: string;
  readonly remainingPercent: number | null;
  readonly usedPercent?: number | null;
  readonly resetsAt: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
  readonly recurring?: boolean;
  /** Plan that granted this window when an account holds several plans. */
  readonly group?: string | null;
  /** Instant a pending grant becomes spendable; `null` when nothing is scheduled. */
  readonly availableAt?: string | null;
}

export interface QuotaData {
  readonly source: string | null;
  readonly status: "unknown" | "refreshing" | "ready" | "error";
  readonly plan: string | null;
  readonly windows: QuotaWindow[];
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly error: string | null;
  /** True when every grant is spent; such a plan is hidden from the dashboard. */
  readonly exhausted?: boolean;
}


export interface QuotaAccountHealth {
  readonly status: string;
  readonly statusCode?: number | null;
  readonly sanitizedMessage?: string | null;
  readonly lastErrorCategory?: string | null;
  readonly retryAt?: string | null;
}

export interface QuotaEntry {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly credentialHint: string;
  readonly active: boolean;
  readonly quota: QuotaData | null;
  /** True while the gateway is filling this account's cache in the background. */
  readonly pending?: boolean;
  readonly health: QuotaAccountHealth | null;
  readonly providerName: string;
  readonly providerIcon: string;
  /**
   * Present only on buddy-family accounts (`workbuddy`/`cb`/`cbcn`).
   * `attemptedToday` is the sweep's day marker: true means the sweep already
   * tried this account today (no upstream cost to read). False means unknown —
   * the sweep may simply not have reached it yet, never "not claimed".
   */
  readonly checkin?: {
    readonly attemptedToday: boolean;
  };
}

export interface QuotaOverview {
  readonly providers: QuotaProviderSummary[];
  readonly accounts: QuotaEntry[];
  /** Accounts the gateway is currently refreshing; drives the fast poll cadence. */
  readonly refreshing?: number;
}

/** Loads the server-joined provider/account quota projection. */
export async function fetchQuotaOverview(signal?: AbortSignal): Promise<QuotaOverview> {
  return consoleRequest<QuotaOverview>("/quota/overview", signal ? { signal } : undefined);
}

/**
 * Loads the tenant's providers/accounts joined with quota + health.
 *
 * `staleTime: 0` is deliberate: the overview is cheap (one batch cache read
 * server-side) and the gateway fills cold accounts in the background, so the
 * page must re-read to observe that fill. Polling is adaptive — while the
 * server reports accounts still being refreshed it polls at `refreshingMs`,
 * otherwise it drops to `idleMs` — so a warming page converges in seconds and
 * a settled page stops hammering the API without any manual reload.
 */
export function useQuotaOverview(options?: {
  readonly refreshingMs?: number;
  readonly idleMs?: number;
  /** Set false to hold the read until the caller actually needs it. */
  readonly enabled?: boolean;
}) {
  const refreshingMs = options?.refreshingMs ?? 2_000;
  const idleMs = options?.idleMs ?? 60_000;
  return useQuery<QuotaOverview>({
    queryKey: queryKeys.quota.all,
    queryFn: (context) => fetchQuotaOverview(querySignal(context)),
    enabled: options?.enabled ?? true,
    staleTime: 0,
    refetchInterval: (query) => ((query.state.data?.refreshing ?? 0) > 0 ? refreshingMs : idleMs),
    refetchIntervalInBackground: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    placeholderData: (previous) => previous,
  });
}


/** Result of a single-account test (`POST /accounts/:id/quota/refresh`). */
export interface AccountTestResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** Response of `GET /accounts/:id/quota` — the account's own plan and windows. */
export interface AccountQuotaResponse {
  readonly accountId: string;
  readonly quota: QuotaData | null;
  readonly health: QuotaAccountHealth | null;
}

/**
 * Reads one account's quota.
 *
 * The provider-detail page shows a card per account, and its quota lived only
 * on the separate Quota page: an operator opening the provider could see the
 * credential and its usage but never the plan it pays for. This reads the same
 * projection the Quota page uses, for one account.
 *
 * `enabled` is required rather than defaulted so a caller cannot accidentally
 * issue one request per card while the list is still loading accounts.
 */
export function useAccountQuota(accountId: string, enabled: boolean) {
  return useQuery<AccountQuotaResponse>({
    queryKey: queryKeys.quota.account(accountId),
    queryFn: (context) =>
      consoleRequest<AccountQuotaResponse>(
        `/accounts/${encodeURIComponent(accountId)}/quota`,
        { signal: querySignal(context) },
      ),
    enabled: enabled && accountId.length > 0,
    staleTime: 30_000,
  });
}

/** Tests one account against its upstream provider and refreshes its views. */
export function useRefreshAccountQuota(accountId: string) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.quota.account(accountId);
  return useMutation<AccountTestResult, ApiErrorShape, void>({
    mutationFn: async () => {
      return consoleRequest<AccountTestResult>(
        `/accounts/${encodeURIComponent(accountId)}/quota/refresh`,
        {
          method: "POST",
        },
      );
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        // The test stamps lastSuccessAt/lastError on the account row, so the
        // account list (Last check) must refetch too — otherwise the test
        // looks like it did nothing.
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}


/** Aggregated result of one or more `/quota/refresh` batches. */
export interface QuotaRefreshResult {
  readonly ok: boolean;
  readonly queued: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly failures: ReadonlyArray<{ accountId: string; code: string; message: string }>;
}

/** Backend cap on `accountIds` per `/quota/refresh` request (mirrors `QUOTA_REFRESH_MAX_IDS`). */
const QUOTA_REFRESH_BATCH_SIZE = 100;

/** Queues a quota refresh for every account passed and invalidates the overview once queued. */
export function useRefreshAllQuotas() {
  const queryClient = useQueryClient();
  return useMutation<QuotaRefreshResult, ApiErrorShape, string[]>({
    mutationFn: async (accountIds): Promise<QuotaRefreshResult> => {
      const batches: string[][] = [];
      for (let index = 0; index < accountIds.length; index += QUOTA_REFRESH_BATCH_SIZE) {
        batches.push(accountIds.slice(index, index + QUOTA_REFRESH_BATCH_SIZE));
      }
      const results = await Promise.all(
        batches.map((batch) =>
          consoleRequest<QuotaRefreshResult>("/quota/refresh", {
            method: "POST",
            body: JSON.stringify({ accountIds: batch }),
          }),
        ),
      );
      const failures = results.flatMap((result) => result.failures);
      return {
        ok: failures.length === 0,
        queued: results.reduce((sum, result) => sum + result.queued, 0),
        succeeded: results.reduce((sum, result) => sum + result.succeeded, 0),
        failed: results.reduce((sum, result) => sum + result.failed, 0),
        failures,
      };
    },
    onSuccess: async (result, accountIds) => {
      const failed = new Set(result.failures.map((failure) => failure.accountId));
      const refreshed = accountIds.filter((accountId) => !failed.has(accountId));
      await Promise.all([
        ...refreshed.map((accountId) =>
          queryClient.invalidateQueries({
            queryKey: queryKeys.quota.account(accountId),
            exact: true,
          }),
        ),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
      ]);
    },
  });
}

/** Enables or disables a single quota-tracked account. */
export function useUpdateAccountActive() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, ApiErrorShape, { id: string; active: boolean }>({
    mutationFn: ({ id, active }) =>
      consoleRequest<{ ok: boolean }>(`/accounts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Enables or disables a batch of quota-tracked accounts in one request. */
export function useSetAccountsActiveBatch() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiErrorShape, { ids: string[]; active: boolean }>({
    mutationFn: async ({ ids, active }) => {
      if (ids.length === 0) return;
      await consoleRequest("/accounts/batch", {
        method: "PATCH",
        body: JSON.stringify({ ids, active }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Deletes a quota-tracked account. */
export function useDeleteQuotaAccount() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiErrorShape, string>({
    mutationFn: async (accountId) => {
      await consoleRequest(`/accounts/${encodeURIComponent(accountId)}`, {
        method: "DELETE",
      });
    },
    onSuccess: async (_result, accountId) => {
      queryClient.removeQueries({ queryKey: queryKeys.quota.account(accountId), exact: true });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Result of one manual daily check-in trigger (`POST /accounts/:id/checkin`). */
export interface AccountCheckinResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly data?: {
    readonly id: string;
    readonly state: string;
    readonly credit: number | null;
    readonly streakDays: number | null;
  };
}

/** Provider ids whose billing facade exposes the daily check-in routes. */
const CHECKIN_PROVIDER_IDS = new Set(["workbuddy", "cb", "cbcn", "autoclaw"]);

/** True when the account can show a daily check-in action on its card. */
export function supportsAccountCheckin(providerId: string): boolean {
  return CHECKIN_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

/** Triggers one account's daily check-in against its upstream provider. */
export function useTriggerAccountCheckin(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AccountCheckinResult, ApiErrorShape, void>({
    mutationFn: async () => {
      return consoleRequest<AccountCheckinResult>(
        `/accounts/${encodeURIComponent(accountId)}/checkin`,
        {
          method: "POST",
        },
      );
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
      ]);
    },
  });
}

/** Triggers the daily check-in for every supplied account. */
export function useBulkAccountCheckin() {
  const queryClient = useQueryClient();
  return useMutation<BulkCheckinSummary, ApiErrorShape, readonly string[]>({
    mutationFn: (accountIds) =>
      runAccountCheckinBatch(accountIds, (accountId) =>
        consoleRequest<AccountCheckinResult>(
          `/accounts/${encodeURIComponent(accountId)}/checkin`,
          { method: "POST" },
        ),
      ),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
      ]);
    },
  });
}

/** Result of one manual growth-activity report (`POST /accounts/:id/activity-report`). */
export interface AccountActivityReportResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly data?: {
    readonly id: string;
    readonly state: string;
    readonly alreadyToday: boolean;
  };
}

/** Result of one manual growth pass: check-in claim + activity report. */
export interface AccountGrowthPassResult {
  /** Human summary covering both steps, e.g. what happened per step. */
  readonly message: string;
  /** True only when both steps succeeded. */
  readonly ok: boolean;
  readonly checkin: AccountCheckinResult;
  readonly report: AccountActivityReportResult;
}

/**
 * Runs the full daily growth pass for one account: check-in claim first, then
 * the growth-activity report. Sequential — the report only fires when the
 * check-in step does not hard-fail, so one toast tells the whole story.
 */
/** Runs the full daily growth pass for one account: check-in claim first, then
 * the growth-activity report. */
export function useTriggerGrowthPass(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AccountGrowthPassResult, ApiErrorShape, void>({
    mutationFn: async (): Promise<AccountGrowthPassResult> => {
      const checkin = await consoleRequest<AccountCheckinResult>(
        `/accounts/${encodeURIComponent(accountId)}/checkin`,
        { method: "POST" },
      );
      const checkinMsg = checkin.message ?? "Daily check-in done";
      if (!checkin.ok) {
        return {
          ok: false,
          message: `Check-in failed: ${checkinMsg}. Report skipped.`,
          checkin,
          report: { ok: false, message: "Skipped (check-in failed)" },
        };
      }
      const report = await consoleRequest<AccountActivityReportResult>(
        `/accounts/${encodeURIComponent(accountId)}/activity-report`,
        { method: "POST" },
      );
      const reportMsg = report.message ?? "Activity reported";
      return {
        ok: report.ok,
        message: report.ok
          ? `Check-in: ${checkinMsg} · Report: ${reportMsg}`
          : `Check-in: ${checkinMsg} · Report failed: ${reportMsg}`,
        checkin,
        report,
      };
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
      ]);
    },
  });
}

export interface AccountResetCredit {
  readonly id: string;
  readonly status?: string;
  readonly title?: string;
  readonly grantedAt?: string;
  readonly expiresAt?: string;
}

/** Result of `GET /accounts/:id/resets` — the live saved-reset inventory. */
export interface AccountResetList {
  readonly availableCount: number;
  readonly credits: readonly AccountResetCredit[];
}

/** Result of `POST /accounts/:id/reset`. */
export interface AccountResetResult {
  readonly ok: boolean;
  readonly code: string;
  readonly message?: string;
  readonly creditId?: string;
}

const RESET_PROVIDER_IDS = new Set(["codex", "claude", "anthropic"]);

/** True when the account supports rate-limit reset redemption (Codex & Claude). */
export function supportsAccountReset(providerId: string): boolean {
  return RESET_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

/**
 * Reads the account's live saved-reset inventory. Deliberately a separate query
 * from the quota overview: the credit objects live on dedicated provider routes
 * (Codex `/wham/rate-limit-reset-credits`, Claude's probed `cedar_ember` block),
 * and Claude's usage payload leaves that block `null` until asked for it, so a
 * count mirrored onto the quota payload would silently read zero.
 */
export function useAccountResets(accountId: string, enabled: boolean) {
  return useQuery<AccountResetList>({
    queryKey: queryKeys.quota.resets(accountId),
    queryFn: ({ signal }) =>
      consoleRequest<AccountResetList>(
        `/accounts/${encodeURIComponent(accountId)}/resets`,
        signal ? { signal } : undefined,
      ),
    enabled,
    staleTime: 30_000,
  });
}

/** Redeems a saved rate-limit reset for the target account, logged to health_events. */
export function useTriggerAccountReset(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AccountResetResult, ApiErrorShape, { creditId?: string } | void>({
    mutationFn: async (vars) => {
      return consoleRequest<AccountResetResult>(
        `/accounts/${encodeURIComponent(accountId)}/reset`,
        {
          method: "POST",
          body: JSON.stringify(vars ?? {}),
        },
      );
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}


/** One wallet row as the AutoClaw facade reports it. */
export interface AutoClawWallet {
  readonly totalBalance: number | null;
  readonly dailyPoints: number | null;
  /** Login email from the profile route; shown to tell same-named accounts apart. */
  readonly email?: string | null;
  readonly updatedAt: string;
}

/** Credits route result; `ok: false` carries the facade's own refusal. */
export interface AutoClawCreditsResult {
  readonly ok: boolean;
  readonly wallet?: AutoClawWallet;
  /**
   * True when the day's grant is already settled for this account.
   *
   * Read from the same day marker the check-in writes, so the card can show a
   * settled state on first paint instead of only after a click.
   */
  readonly checkedInToday?: boolean;
  readonly error?: string;
  readonly code?: string;
}

/**
 * Reads the account's points.
 *
 * Served from its own route rather than the quota envelope because the number
 * lives on the billing facade, not on the model quota endpoint: folding it into
 * the quota payload would make a wallet read block the quota refresh that every
 * other provider depends on.
 */
export function useAutoClawCredits(accountId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.quota.credits(accountId),
    queryFn: (context) =>
      consoleRequest<AutoClawCreditsResult>(`/accounts/${encodeURIComponent(accountId)}/credits`, {
        signal: querySignal(context),
      }),
    enabled: Boolean(accountId) && enabled,
    // The balance moves whenever the vendor grants points or a routed request
    // charges them; a minute-scale poll keeps the card honest without the
    // operator refreshing. Each read also posts the activity event the
    // vendor's campaign grants require, so the poll doubles as that heartbeat.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: false,
  });
}

/** One movement in an AutoClaw account's points ledger. */
export interface AutoClawLedgerEntry {
  readonly id: string;
  /** Signed points: positive for a grant, negative for a charge. */
  readonly amount: number;
  readonly description: string;
  readonly occurredAt: string;
  readonly walletScope: string | null;
  readonly direction: "credit" | "debit";
}

/** Credits history result; `ok: false` carries the facade's own refusal. */
export interface AutoClawCreditsHistoryResult {
  readonly ok: boolean;
  readonly entries?: readonly AutoClawLedgerEntry[];
  readonly nextCursor?: string | null;
  readonly error?: string;
  readonly code?: string;
}

/** Direction filter the ledger route accepts. */
export type AutoClawCreditsHistoryDirection = "all" | "income" | "expense";

/**
 * Reads the account's points ledger, one page at a time.
 *
 * Paged rather than "latest N": the vendor charges per request, and a
 * long-lived account's ledger is thousands of rows while the card only needs
 * the head until the operator asks for more. `useInfiniteQuery` keeps every
 * page it has already fetched, so "load more" appends instead of refetching the
 * head.
 */
export function useAutoClawCreditsHistory(
  accountId: string,
  direction: AutoClawCreditsHistoryDirection,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: queryKeys.quota.creditsHistory(accountId, direction),
    initialPageParam: null as string | null,
    queryFn: (context) => {
      const cursor = context.pageParam;
      const query = new URLSearchParams({ direction });
      if (typeof cursor === "string" && cursor.length > 0) query.set("cursor", cursor);
      return consoleRequest<AutoClawCreditsHistoryResult>(
        `/accounts/${encodeURIComponent(accountId)}/credits/history?${query.toString()}`,
        { signal: querySignal(context) },
      );
    },
    getNextPageParam: (last) => (last.ok && last.nextCursor ? last.nextCursor : undefined),
    enabled: Boolean(accountId) && enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** Outcome of one AutoClaw check-in, which claims every outstanding task. */
export interface AutoClawCheckinResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly code?: string;
  readonly data?: {
    readonly id: string;
    readonly state: string;
    readonly credit: number | null;
    readonly streakDays: number | null;
    readonly claims?: readonly { readonly task: string; readonly points: number }[];
    readonly already?: readonly string[];
  };
}

/**
 * Claims AutoClaw's outstanding grants.
 *
 * The same `POST /accounts/:id/checkin` the buddy family uses: the route
 * branches on the provider, so the dashboard does not need a second endpoint to
 * learn about a second claim surface.
 */
export function useTriggerAutoClawCheckin(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation<AutoClawCheckinResult, ApiErrorShape, void>({
    mutationFn: () =>
      consoleRequest<AutoClawCheckinResult>(`/accounts/${encodeURIComponent(accountId)}/checkin`, {
        method: "POST",
      }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
      ]);
    },
  });
}

/** One expiry-day bucket of the account's point ledger. */
export interface AutoClawExpiringBucket {
  readonly expiresOn: string;
  readonly expiresAt: number;
  readonly points: number;
  readonly entries: readonly {
    readonly id: string;
    readonly amount: number;
    readonly description: string;
    readonly occurredAt: string;
    readonly walletScope: string | null;
    readonly direction: "credit" | "debit";
    readonly walletExpiresAt: number | null;
  }[];
}

/** The account's lapsed and soon-to-lapse point grants. */
export interface AutoClawExpirySummary {
  readonly ok: boolean;
  readonly expired: readonly AutoClawExpiringBucket[];
  readonly expiringSoon: readonly AutoClawExpiringBucket[];
  readonly expiredPoints: number;
  readonly expiringSoonPoints: number;
  readonly error?: string;
}

/**
 * Reads the account's point-expiry summary: grants the vendor already lapsed,
 * plus the ones lapsing within the next week.
 *
 * `enabled` gates it like the history read — the route is per account and the
 * dialog is the only consumer, so the summary fetches when the operator asks.
 */
export function useAutoClawExpiry(accountId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.quota.creditsExpiring(accountId),
    queryFn: (context) =>
      consoleRequest<AutoClawExpirySummary>(
        `/accounts/${encodeURIComponent(accountId)}/credits/expiring?withinDays=7`,
        { signal: querySignal(context) },
      ),
    enabled: Boolean(accountId) && enabled,
    staleTime: 60_000,
    retry: false,
  });
}
