import { t } from "elysia";
import type { Elysia } from "elysia";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { providerAccounts, providers } from "../../persistence/schema";
import { providerDisplayName } from "../../providers/provider-metadata";
import { requireTenantScope } from "../shared/errors";
// AutoClaw's facade resets its daily tasks on the vendor's local day, not UTC:
// measured 2026-11-15, a claim landed 04:58 WIB while the UTC marker still read
// done. The autoclaw branches key the ledger on the vendor's day instead.
import {
  claimAutoClawCheckin,
  fetchAutoClawExpirySummary,
  fetchAutoClawLedger,
  fetchAutoClawWallet,
  reportAutoClawActivity,
  type AutoClawLedgerDirection,
} from "../../providers/integrations/autoclaw/autoclaw-credits";
import {
  GLOBAL_QUOTA_LENS,
  getCachedQuotaEntries,
  getCachedQuotaEntry,
  invalidateQuotaCache,
} from "./quota-cache";
import {
  QUOTA_REFRESH_TIMEOUT_MS,
  refreshAccountQuota,
  signalFetch,
  timeoutSignal,
  type QuotaRefreshDeps,
  type QuotaRefreshFailureCode,
} from "./quota-refresh";
import type { ProviderId } from "../../providers/provider-registry";
import {
  DAILY_CHECKIN_PROVIDER_IDS,
  checkinDayKeyFor,
  ledgerKey,
} from "../../workers/daily-checkin";
import {
  fetchBuddyActivityReport,
  fetchDailyCheckin,
  type BuddyActivityReportResult,
  type DailyCheckinResult,
} from "../../providers/integrations/buddy/buddy-checkin";
import { buddyAccountUid } from "../../providers/integrations/buddy/buddy-oauth-shared";
import {
  claimZcodePlan,
  fetchZcodeClaimVerificationConfig,
  listZcodeClaims,
} from "../../providers/integrations/zcode/zcode-claim";
import {
  supportsAccountReset,
  consumeAccountResetCredit,
  listAccountResetCredits,
} from "../../providers/operations/account-reset-service";
import {
  enqueueBackgroundQuotaRefresh,
  pendingQuotaRefreshes,
  toQuotaView,
} from "./account-quota-view";
import {
  ACCOUNT_STATUSES,
  type AccountQuotaRoutesDeps,
  type AccountStatus,
} from "./account-quota-shared";
import { notificationCacheKey, recordCheckinEvidence, recordClaimedPlan } from "../notifications/store";

/** Daily check-in only exists on the buddy billing facade; everything else 400s with intent. */
/**
 * Providers whose daily check-in this route can drive.
 *
 * The buddy family answers through its own billing facade and AutoClaw through
 * its task proxy; both are claimed by the same `POST /accounts/:id/checkin`, so
 * the route branches on the provider rather than exposing a second path. Any
 * other provider still 400s with intent instead of pretending.
 */
function supportsAccountCheckin(providerId: string): boolean {
  return providerId === "autoclaw"
    || (DAILY_CHECKIN_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/** One account's check-in through the buddy billing facade. */
async function runAccountCheckin(
  account: { id: string; providerId: string },
  credential: string,
  forceClaim: boolean,
): Promise<DailyCheckinResult> {
  return fetchDailyCheckin({
    providerId: account.providerId,
    accountId: account.id,
    credential,
    fetcher: globalThis.fetch,
    ...(forceClaim ? { forceClaim } : {}),
  });
}

/**
 * Reads the sweep ledger for today's check-in slot: a present marker means the
 * sweep already attempted this account today, so the card can show the state
 * without spending an upstream request. Absent (or unreadable) means unknown —
 * never "not claimed", since the sweep may simply not have reached it yet.
 */
async function todayCheckinAttempted(
  redis: AccountQuotaRoutesDeps["redis"],
  accountId: string,
  providerId?: string,
): Promise<boolean> {
  try {
    // The day key is the vendor's own, resolved in one place: buddy resets on
    // UTC while AutoClaw resets on its local day, and a mismatch here would
    // read a marker the sweep never wrote.
    const marker = await redis.get(ledgerKey(checkinDayKeyFor(providerId ?? ""), accountId));
    return marker !== null;
  } catch {
    return false;
  }
}

function checkinStateMessage(result: DailyCheckinResult): string {
  switch (result.state) {
    case "claimed":
      return result.credit !== null
        ? `Daily check-in claimed (+${result.credit} credits${result.streakDays !== null ? `, ${result.streakDays}-day streak` : ""})`
        : "Daily check-in claimed";
    case "already_claimed":
      return "Already checked in today";
    case "not_eligible":
      return "Account is not eligible for daily check-in";
    case "event_ended":
      return "Daily check-in event has ended";
    case "unavailable":
      return result.error ?? "Daily check-in is unavailable";
    case "error":
      return result.error ?? "Daily check-in failed";
  }
}

const QUOTA_REFRESH_CONCURRENCY = 5;
const QUOTA_REFRESH_MAX_IDS = 100;

/**
 * How stale a cached value may be before the overview asks for a refresh.
 *
 * The cache TTL is 300 s, so a value older than this is close enough to expiry
 * that re-fetching now avoids the page ever rendering an expired entry. The
 * background queue dedupes, so a page that polls every couple of seconds still
 * produces at most one upstream fetch per account per window.
 */
const QUOTA_STALE_AFTER_MS = 240_000;

/** Where a relay-stored desktop reading lives, one per account. */
function observedCreditsKey(accountId: string): string {
  return `lianrouter:autoclaw:observed:${accountId}`;
}

/**
 * How long an observed reading stays authoritative.
 *
 * The desktop app refreshes its own card on open and after a claim, so a relay
 * that posts every minute keeps this warm. Ten minutes is comfortably longer
 * than that beat and short enough that a relay which died over lunch cannot
 * leave the card showing a balance the account has since spent down.
 */
const OBSERVED_CREDITS_TTL_SECONDS = 10 * 60;

/** Shape the relay writes and the credits read consumes. */
interface ObservedCredits {
  readonly observedAt: string;
  readonly totalPoints: number;
  readonly dailyPoints: number | null;
  readonly checkinDate: string | null;
  readonly claimStatus: string | null;
  readonly claimedAmount: number | null;
  readonly streakDays: number | null;
}

/** One account's recent desktop reading, or `null` when there is none or it is unreadable. */
async function readObservedCredits(
  redis: AccountQuotaRoutesDeps["redis"],
  accountId: string,
): Promise<ObservedCredits | null> {
  try {
    const raw = await redis.get(observedCreditsKey(accountId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const total = parsed["totalPoints"];
    if (typeof total !== "number" || !Number.isFinite(total)) return null;
    return {
      observedAt: String(parsed["observedAt"] ?? ""),
      totalPoints: total,
      dailyPoints: typeof parsed["dailyPoints"] === "number" ? parsed["dailyPoints"] : null,
      checkinDate: typeof parsed["checkinDate"] === "string" ? parsed["checkinDate"] : null,
      claimStatus: typeof parsed["claimStatus"] === "string" ? parsed["claimStatus"] : null,
      claimedAmount: typeof parsed["claimedAmount"] === "number" ? parsed["claimedAmount"] : null,
      streakDays: typeof parsed["streakDays"] === "number" ? parsed["streakDays"] : null,
    };
  } catch {
    return null;
  }
}

/**
 * Registers the tenant-scoped account/quota routes onto `app`. Every route here
 * authorises through `requireTenantScope`, so the caller only ever touches its
 * own tenant's accounts.
 */
export function registerAccountQuotaTenantRoutes(
  app: Elysia,
  deps: AccountQuotaRoutesDeps,
  refreshDeps: QuotaRefreshDeps,
): void {
  const { db, accessResolver, redis, snapshotInvalidator, auditRecorder, providerRegistry } = deps;
  app
    .get("/quota/overview", async ({ request }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const rows = await db
        .select({
          id: providerAccounts.id,
          providerId: providerAccounts.providerId,
          tenantId: providerAccounts.tenantId,
          label: providerAccounts.label,
          credentialKind: providerAccounts.credentialKind,
          status: providerAccounts.status,
          lastError: providerAccounts.lastError,
          lastErrorCategory: providerAccounts.lastErrorCategory,
          lastSuccessAt: providerAccounts.lastSuccessAt,
        })
        .from(providerAccounts)
        .innerJoin(providers, eq(providerAccounts.providerId, providers.id))
        .where(
          and(
            or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, access.tenantId)),
            or(isNull(providers.tenantId), eq(providers.tenantId, access.tenantId)),
          ),
        );

      // One batch read per lens instead of one round trip per account: the page
      // renders every account at once, so per-account reads would make opening
      // it scale with the account count.
      const ownedIds: string[] = [];
      const globalIds: string[] = [];
      for (const row of rows) {
        if (row.tenantId === null) globalIds.push(row.id);
        else ownedIds.push(row.id);
      }
      const [ownedCache, globalCache] = await Promise.all([
        getCachedQuotaEntries(access.tenantId, ownedIds, redis),
        getCachedQuotaEntries(GLOBAL_QUOTA_LENS, globalIds, redis),
      ]);

      const now = Date.now();
      const pending = pendingQuotaRefreshes();
      const providerIds = [...new Set(rows.map((row) => row.providerId))];
      // The dropdown is a quota-page control, not a provider directory: only
      // providers whose registry entry can actually answer a quota fetch
      // appear, so key-only providers with no quota endpoint never show up.
      const quotaProviders = providerIds.filter((providerId) =>
        providerRegistry.hasQuotaCollector(providerId),
      );
      const providersSummary = quotaProviders
        .sort((left, right) => left.localeCompare(right))
        .map((providerId) => ({
          id: providerId,
          name: providerDisplayName(providerId),
          icon: providerId,
        }));
      let refreshing = 0;
      // The sweep's day markers answer "attempted today" without an upstream
      // request; only check-in-capable accounts can carry one, so only they
      // are read.
      const checkinCandidates = rows.filter((row) => supportsAccountCheckin(row.providerId));
      const checkinAttempted = new Map<string, boolean>();
      await Promise.all(
        checkinCandidates.map(async (row) => {
          checkinAttempted.set(row.id, await todayCheckinAttempted(redis, row.id, row.providerId));
        }),
      );
      const accounts = rows.map((row) => {
        const entry =
          row.tenantId === null ? globalCache.get(row.id) : ownedCache.get(row.id);
        const ageMs = entry?.fetchedAt ? now - new Date(entry.fetchedAt).getTime() : Number.POSITIVE_INFINITY;
        // Providers with no quota collector (custom BYOK endpoints, key-only
        // providers) intentionally never refresh: there is no upstream quota
        // endpoint to ask, so enqueueing would only manufacture the
        // "not available" error the page would then have to explain away.
        const canRefresh = providerRegistry.hasQuotaCollector(row.providerId);
        const wantsRefresh = canRefresh && ageMs >= QUOTA_STALE_AFTER_MS;
        if (wantsRefresh) {
          enqueueBackgroundQuotaRefresh(refreshDeps, {
            accountId: row.id,
            providerId: row.providerId,
            tenantId: row.tenantId,
            credentialKind: row.credentialKind,
          });
        }
        const isRefreshing = canRefresh && (pending.has(row.id) || entry === undefined);
        return {
          id: row.id,
          provider: row.providerId,
          name: row.label || row.id,
          credentialHint: row.credentialKind,
          active: row.status === "active",
          quota: entry
            ? toQuotaView(entry.quota, row, {
                fetchedAt: entry.fetchedAt,
                ...(isRefreshing ? { status: "refreshing" as const } : {}),
              })
            : null,
          pending: isRefreshing,
          health: {
            status: row.status,
            sanitizedMessage: row.lastError ?? null,
            lastErrorCategory: row.lastErrorCategory ?? null,
          },
          providerName: providerDisplayName(row.providerId),
          providerIcon: row.providerId,
          // Present only on buddy accounts. `attemptedToday` is the sweep
          // ledger (no upstream cost); the card combines it with the manual
          // trigger result to render claimed / already / due / unknown.
          ...(supportsAccountCheckin(row.providerId)
            ? { checkin: { attemptedToday: checkinAttempted.get(row.id) ?? false } }
            : {}),
        };
      });

      // `refreshing > 0` tells the client to poll quickly; once the worker has
      // filled everything this drops to 0 and the client falls back to its slow
      // cadence without a manual reload.
      return { providers: providersSummary, accounts, refreshing };
    })
    .get("/accounts/:id/quota", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const accountId = params.id;
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${accountId} not found`, code: "not_found" };
      }
      // No quota collector means no upstream surface to ask: answer the
      // untracked state directly instead of caching a manufactured error.
      if (!providerRegistry.hasQuotaCollector(account.providerId)) {
        return {
          accountId,
          quota: null,
          health: {
            status: account.status,
            sanitizedMessage: account.lastError ?? null,
            lastErrorCategory: account.lastErrorCategory ?? null,
          },
        };
      }
      const cached = await getCachedQuotaEntry(access.tenantId, accountId, redis);
      if (cached) {
        return {
          accountId,
          quota: toQuotaView(cached.quota, account, { fetchedAt: cached.fetchedAt }),
          health: {
            status: account.status,
            sanitizedMessage: account.lastError ?? null,
            lastErrorCategory: account.lastErrorCategory ?? null,
          },
        };
      }

      // Cold read: this is the one path that legitimately waits on upstream, and
      // it shares the in-flight fetch with any queued background fill so a cold
      // page open never issues two requests for the same account.
      const outcome = await refreshAccountQuota(
        refreshDeps,
        { accountId, providerId: account.providerId, tenantId: account.tenantId, credentialKind: account.credentialKind },
        signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
      );
      const fresh = await getCachedQuotaEntry(access.tenantId, accountId, redis);
      return {
        accountId,
        quota: toQuotaView(outcome.quota, account, {
          fetchedAt: fresh?.fetchedAt ?? new Date().toISOString(),
          lastAttemptAt: new Date().toISOString(),
          lastSuccessAt: outcome.quota.error === null ? new Date().toISOString() : null,
        }),
        health: {
          status: account.status,
          sanitizedMessage: account.lastError ?? null,
          lastErrorCategory: account.lastErrorCategory ?? null,
        },
      };
    })
    .post("/accounts/:id/quota/refresh", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const accountId = params.id;
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${accountId} not found`, code: "not_found" };
      }
      // Manual refresh on a collectorless provider is a no-op by design, not
      // a 502: there is nothing upstream to probe.
      if (!providerRegistry.hasQuotaCollector(account.providerId)) {
        return { ok: true, status: 200, data: { id: accountId, quota: null } };
      }

      const attemptedAt = new Date().toISOString();
      const outcome = await refreshAccountQuota(
        refreshDeps,
        { accountId, providerId: account.providerId, tenantId: account.tenantId, credentialKind: account.credentialKind },
        signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
      );
      const httpStatus = outcome.quota.error === null ? 200 : 502;
      set.status = httpStatus;
      return {
        ok: outcome.quota.error === null,
        status: httpStatus,
        data: {
          id: accountId,
          quota: toQuotaView(outcome.quota, account, {
            fetchedAt: attemptedAt,
            lastAttemptAt: attemptedAt,
            lastSuccessAt: outcome.quota.error === null ? attemptedAt : null,
          }),
        },
        message: outcome.quota.error ?? undefined,
      };
    })
    .post(
      "/quota/refresh",
      {
        body: t.Optional(
          t.Object({
            accountIds: t.Optional(t.Array(t.String())),
            ids: t.Optional(t.Array(t.String())),
          }),
        ),
      },
      async ({ request, body, set }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        const ids = body?.accountIds ?? body?.ids ?? [];
        if (ids.length === 0) {
          set.status = 400;
          return { error: "accountIds must be a non-empty array", code: "invalid_request" };
        }
        if (ids.length > QUOTA_REFRESH_MAX_IDS) {
          set.status = 400;
          return {
            error: `accountIds exceeds the limit of ${QUOTA_REFRESH_MAX_IDS}`,
            code: "invalid_request",
          };
        }
        const accounts = await db
          .select({
            accountId: providerAccounts.id,
            providerId: providerAccounts.providerId,
            tenantId: providerAccounts.tenantId,
            credentialKind: providerAccounts.credentialKind,
          })
          .from(providerAccounts)
          .where(
            and(
              inArray(providerAccounts.id, ids),
              or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, access.tenantId)),
            ),
          );
        // Collectorless accounts are done without a fetch: counted as
        // succeeded with no quota, never as failures.
        const refreshable = accounts.filter((account) => providerRegistry.hasQuotaCollector(account.providerId));

        const timedFetch = signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS));
        const failures: Array<{
          accountId: string;
          code: QuotaRefreshFailureCode;
          message: string;
        }> = [];
        let succeeded = accounts.length - refreshable.length;
        let cursor = 0;
        await Promise.all(
          Array.from(
            { length: Math.min(QUOTA_REFRESH_CONCURRENCY, refreshable.length) },
            async () => {
              while (cursor < refreshable.length) {
                const target = refreshable[cursor++]!;
                const outcome = await refreshAccountQuota(refreshDeps, target, timedFetch);
                if (outcome.failure !== null) {
                  failures.push({
                    accountId: target.accountId,
                    code: outcome.failure,
                    message: outcome.quota.error ?? "Failed to refresh quota",
                  });
                  continue;
                }
                succeeded += 1;
              }
            },
          ),
        );

        return {
          ok: failures.length === 0,
          queued: accounts.length,
          succeeded,
          failed: failures.length,
          failures,
          accountIds: accounts.map((a) => a.accountId),
        };
      },
    )
    .patch(
      "/accounts/:id",
      {
        body: t.Object({
          active: t.Optional(t.Boolean()),
          status: t.Optional(t.String()),
        }),
      },
      async ({ request, params, body, set }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        if (body.status !== undefined && !ACCOUNT_STATUSES.includes(body.status as AccountStatus)) {
          set.status = 400;
          return {
            error: `status must be one of: ${ACCOUNT_STATUSES.join(", ")}`,
            code: "invalid_status",
          };
        }
        const nextStatus: AccountStatus | undefined =
          body.active !== undefined
            ? body.active
              ? "active"
              : "disabled"
            : (body.status as AccountStatus | undefined);
        if (!nextStatus) {
          set.status = 400;
          return { error: "active or status is required", code: "invalid_request" };
        }
        const updated = await db
          .update(providerAccounts)
          .set({ status: nextStatus })
          .where(
            and(
              eq(providerAccounts.id, params.id),
              eq(providerAccounts.tenantId, access.tenantId),
            ),
          )
          .returning({ id: providerAccounts.id });
        if (updated.length === 0) {
          set.status = 404;
          return { error: `Account ${params.id} not found`, code: "not_found" };
        }
        // A status flip must not drop a good cached quota: the value is an
        // upstream fact that the flip does not change, and clearing it would
        // blank the card the user is looking at. Only the route snapshot
        // (dispatch eligibility) needs to change.
        await snapshotInvalidator?.invalidate();
        return { ok: true, status: 200 };
      },
    )
    .patch(
      "/accounts/batch",
      {
        body: t.Object({
          ids: t.Array(t.String()),
          active: t.Boolean(),
        }),
      },
      async ({ request, body, set }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        if (body.ids.length === 0) return { ok: true, updated: 0 };
        if (body.ids.length > QUOTA_REFRESH_MAX_IDS) {
          set.status = 400;
          return {
            error: `ids exceeds the limit of ${QUOTA_REFRESH_MAX_IDS}`,
            code: "invalid_request",
          };
        }
        const status = body.active ? ("active" as const) : ("disabled" as const);
        const updated = await db
          .update(providerAccounts)
          .set({ status })
          .where(
            and(
              inArray(providerAccounts.id, body.ids),
              eq(providerAccounts.tenantId, access.tenantId),
            ),
          )
          .returning({ id: providerAccounts.id });
        await snapshotInvalidator?.invalidate();
        return {
          ok: true,
          status: 200,
          data: {
            updated: updated.length,
            ids: updated.map((row) => row.id),
          },
        };
      },
    )
    .delete("/accounts/:id", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const accountId = params.id;
      const deleted = await db
        .delete(providerAccounts)
        .where(
          and(eq(providerAccounts.id, accountId), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .returning({ id: providerAccounts.id });
      if (deleted.length === 0) {
        set.status = 404;
        return { error: `Account ${accountId} not found`, code: "not_found" };
      }
      // The account is gone, so its cached quota must go with it — unlike a
      // status flip, nothing can make this value meaningful again.
      await invalidateQuotaCache(access.tenantId, accountId, redis);
      await snapshotInvalidator?.invalidate();
      await auditRecorder?.record({
        access,
        action: "provider_account.deleted",
        target: accountId,
      });
      return { success: true };
    })
    .post("/accounts/:id/checkin", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountCheckin(account.providerId)) {
        set.status = 400;
        return {
          error: `Daily check-in is not supported for provider ${account.providerId}`,
          code: "checkin_unsupported",
        };
      }
      // A manual trigger is the operator asserting "try now", so it bypasses
      // the sweep's once-per-day ledger and forces the status probe. The
      // upstream itself stays idempotent: a duplicate claim answers
      // `already_claimed`, never a double grant.
      if (account.providerId === "autoclaw") {
        // AutoClaw grants through its task proxy, so its result shape is its
        // own: several tasks in one pass, and the points come from each claim.
        try {
          const credential = await refreshDeps.resolveCredential(
            account.providerId as ProviderId,
            account.id,
          );
          // The campaign engine reads activity, not claims: report before the
          // claim so a period whose reward is still unpaid can settle in the
          // same pass the operator asked for.
          await reportAutoClawActivity(credential);
          const outcome = await claimAutoClawCheckin(credential);
          // Record the day the sweep's ledger also reads, so the card can show
          // "checked in today" without a second upstream round trip. A failed
          // pass is not recorded: the day slot must stay open for a retry.
          if (outcome.state === "claimed" || outcome.state === "already_claimed") {
            // Keyed on the vendor's own day, through the same helper the sweep
            // reserves with — a second spelling of this key is a second source.
            await redis
              .set(ledgerKey(checkinDayKeyFor("autoclaw"), account.id), "1", "EX", 3 * 24 * 60 * 60)
              .catch(() => undefined);
          }
          if (outcome.state === "error") {
            set.status = 502;
            return {
              ok: false,
              status: 502,
              data: { id: account.id, state: outcome.state },
              message: outcome.error ?? "Daily check-in failed",
              code: "checkin_failed",
            };
          }
          return {
            ok: true,
            status: 200,
            data: {
              id: account.id,
              state: outcome.state,
              credit: outcome.credit,
              streakDays: null,
              claims: outcome.claims,
              already: outcome.already,
            },
            message:
              outcome.state === "claimed"
                ? `Claimed ${outcome.claims.length} task(s)${outcome.credit !== null && outcome.credit > 0 ? ` (+${outcome.credit} points)` : ""}`
                : outcome.state === "already_claimed"
                  ? "Already checked in today"
                  : (outcome.error ?? "Nothing to claim"),
          };
        } catch (error) {
          set.status = 502;
          return {
            ok: false,
            status: 502,
            data: { id: account.id, state: "error" },
            message: error instanceof Error ? error.message : "Daily check-in failed",
            code: "checkin_failed",
          };
        }
      }
      let result: DailyCheckinResult;
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        result = await runAccountCheckin(account, credential, true);
      } catch (error) {
        result = {
          providerId: account.providerId,
          accountId: account.id,
          state: "error",
          credit: null,
          streakDays: null,
          error: error instanceof Error ? error.message : "Daily check-in failed.",
        };
      }
      if (result.state === "error") {
        set.status = 502;
        return {
          ok: false,
          status: 502,
          data: { id: account.id, state: result.state },
          message: result.error ?? "Daily check-in failed",
          code: "checkin_failed",
        };
      }
      if (result.state === "claimed" || result.state === "already_claimed") {
        await recordCheckinEvidence(redis, account.providerId, account.id, {
          state: "completed",
          dayKey: checkinDayKeyFor(account.providerId),
          observedAt: new Date().toISOString(),
          credit: result.credit,
          streakDays: result.streakDays,
        });
      }
      return {
        ok: true,
        status: 200,
        data: {
          id: account.id,
          state: result.state,
          credit: result.credit,
          streakDays: result.streakDays,
        },
        message: checkinStateMessage(result),
      };
    })
    .post("/accounts/:id/activity-report", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountCheckin(account.providerId)) {
        set.status = 400;
        return {
          error: `Activity report is not supported for provider ${account.providerId}`,
          code: "report_unsupported",
        };
      }
      // One report per account per day lights the login streak; more is
      // rate-limit bait, so the sweep's check-in day marker gates this too.
      // The marker only proves an attempt happened today — the growth event is
      // a different upstream call, but sharing the marker keeps the "one
      // growth action per day" budget honest across both buttons.
      let alreadyReported = false;
      try {
        alreadyReported =
          (await redis.get(ledgerKey(checkinDayKeyFor(account.providerId), account.id))) !== null;
      } catch {
        alreadyReported = false;
      }
      if (alreadyReported) {
        return {
          ok: true,
          status: 200,
          data: { id: account.id, state: "reported", alreadyToday: true },
          message: "Activity already reported today",
        };
      }
      let result: BuddyActivityReportResult;
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        // The growth event scores by uid, and only a JWT carries one. An
        // opaque API key must fail closed here — reporting it under another
        // account's uid would poison someone else's streak.
        const userId = buddyAccountUid(credential);
        if (!userId) {
          set.status = 400;
          return {
            error: "Activity report needs an OAuth account (no uid in this credential)",
            code: "report_requires_oauth",
          };
        }
        result = await fetchBuddyActivityReport({
          providerId: account.providerId,
          accountId: account.id,
          credential,
          userId,
          fetcher: globalThis.fetch,
        });
      } catch (error) {
        result = {
          providerId: account.providerId,
          accountId: account.id,
          state: "error",
          error: error instanceof Error ? error.message : "Activity report failed.",
        };
      }
      if (result.state === "error") {
        set.status = 502;
        return {
          ok: false,
          status: 502,
          data: { id: account.id, state: result.state },
          message: result.error ?? "Activity report failed",
          code: "report_failed",
        };
      }
      return {
        ok: true,
        status: 200,
        data: { id: account.id, state: result.state, alreadyToday: false },
        message: "Activity reported — login streak lit for today",
      };
    })
    .get("/accounts/:id/resets", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountReset(account.providerId)) {
        return { availableCount: 0, credits: [] };
      }
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        const list = await listAccountResetCredits(account.providerId, credential);
        return list ?? { availableCount: 0, credits: [] };
      } catch (err) {
        return { availableCount: 0, credits: [] };
      }
    })
    .post("/accounts/:id/reset", async ({ request, params, set, body }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (!supportsAccountReset(account.providerId)) {
        set.status = 400;
        return {
          error: `Reset is not supported for provider ${account.providerId}`,
          code: "reset_unsupported",
        };
      }
      const reqBody = (body && typeof body === "object" ? body : {}) as { creditId?: string };
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        const outcome = await consumeAccountResetCredit({
          db,
          accountId: account.id,
          providerId: account.providerId,
          credentialRaw: credential,
          creditId: reqBody.creditId,
          snapshotInvalidator,
        });
        if (!outcome.ok) {
          // A business no-op ("nothing_to_reset", "already_redeemed") is not a
          // client error: the request was well-formed and the provider answered.
          // Only a provider-side failure (4xx/5xx) carries a failure status.
          set.status = outcome.status >= 400 ? outcome.status : 200;
          return {
            ok: false,
            code: outcome.code,
            message: outcome.message ?? `Reset failed: ${outcome.code}`,
          };
        }
        if (auditRecorder) {
          await auditRecorder.record({
            access,
            action: "provider_account.recovered",
            target: account.id,
            detail: { reason: "rate_limit_reset_consumed", provider: account.providerId },
          });
        }
        return {
          ok: true,
          code: outcome.code,
          message: outcome.message ?? "Rate limit reset applied successfully",
          creditId: outcome.creditId,
        };
      } catch (err) {
        set.status = 502;
        return {
          ok: false,
          code: "reset_failed",
          message: err instanceof Error ? err.message : "Reset operation failed",
        };
      }
    })
    // ---------------------------------------------------------------------
    // Claimable campaigns (ZCODE start-plan)
    // ---------------------------------------------------------------------
    //
    // A start-plan account can hold time-boxed campaigns that are claimed rather
    // than bought. Listing reads both surfaces that advertise them (billing
    // preview and marketing deliveries); claiming posts one plan id. Claiming is
    // captcha-gated upstream for the campaigns that matter, and that gate is
    // reported as its own outcome so the operator is told to finish in the
    // desktop app instead of retrying a request that can never succeed here.
    .get("/accounts/:id/claims", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (account.providerId !== "zcode") {
        return { plans: [], errors: [], supported: false };
      }
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        const listing = await listZcodeClaims(credential, signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)));
        return { ...listing, supported: true };
      } catch (err) {
        set.status = 502;
        return {
          plans: [],
          errors: [err instanceof Error ? err.message : "Claim listing failed"],
          supported: true,
        };
      }
    })
    // The captcha the claim endpoint expects, so the dashboard can render the
    // same widget the desktop app does instead of dead-ending the operator with
    // "claim it in the app".
    .get("/accounts/:id/claims/verification", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (account.providerId !== "zcode") {
        set.status = 400;
        return { error: `Claiming is not supported for provider ${account.providerId}`, code: "claim_unsupported" };
      }
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        const config = await fetchZcodeClaimVerificationConfig(
          credential,
          signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
        );
        return { ok: true, config };
      } catch (err) {
        set.status = 502;
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Captcha config read failed",
          code: "claim_verification_failed",
        };
      }
    })
    .post("/accounts/:id/claims", async ({ request, params, set, body }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:write");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(eq(providerAccounts.id, params.id), eq(providerAccounts.tenantId, access.tenantId)),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (account.providerId !== "zcode") {
        set.status = 400;
        return { error: `Claiming is not supported for provider ${account.providerId}`, code: "claim_unsupported" };
      }
      const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const planId = payload["planId"];
      if (typeof planId !== "string" || planId.trim().length === 0) {
        set.status = 400;
        return { error: "planId is required", code: "invalid_request" };
      }
      // The challenge token is supplied by the dashboard widget. Absent, the
      // claim is attempted bare and the gateway answers its own captcha code,
      // which is reported as the captcha state; present, the claim carries it.
      const captchaParam = typeof payload["captchaParam"] === "string" ? payload["captchaParam"] : "";
      const captchaRegion = typeof payload["captchaRegion"] === "string" ? payload["captchaRegion"] : "";
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        const outcome = await claimZcodePlan(
          credential,
          planId,
          signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
          { param: captchaParam, region: captchaRegion },
        );
        if (outcome.kind === "claimed") {
          await recordClaimedPlan(redis, account.id, outcome.planId, outcome.endsAt);
          await invalidateQuotaCache(access.tenantId, account.id, redis);
          await snapshotInvalidator?.invalidate();
          if (auditRecorder) {
            await auditRecorder.record({
              access,
              action: "provider_account.recovered",
              target: account.id,
              detail: { reason: "plan_claimed", provider: account.providerId, planId: outcome.planId },
            });
          }
          return { ok: true, status: "claimed", planId: outcome.planId, startsAt: outcome.startsAt, endsAt: outcome.endsAt };
        }
        if (outcome.kind === "captcha_required") {
          // Not a client error and not a transient failure: the campaign is real
          // and the credential works, but the claim must be finished where a
          // human can solve the challenge.
          set.status = 409;
          return {
            ok: false,
            status: "captcha_required",
            planId: outcome.planId,
            message: outcome.message,
            code: "claim_captcha_required",
          };
        }
        if (outcome.kind === "rate_limited") {
          // 429 rather than 502: the request was valid and the campaign exists,
          // so this is the vendor's own throttle and the operator can retry.
          set.status = 429;
          return {
            ok: false,
            status: "rate_limited",
            planId: outcome.planId,
            message: outcome.message,
            code: "claim_rate_limited",
          };
        }
        set.status = 502;
        return {
          ok: false,
          status: "rejected",
          planId: outcome.planId,
          message: outcome.message,
          code: "claim_rejected",
        };
      } catch (err) {
        set.status = 502;
        return {
          ok: false,
          status: "error",
          message: err instanceof Error ? err.message : "Claim operation failed",
          code: "claim_failed",
        };
      }
    })
    /**
     * AutoClaw: the account's points.
     *
     * The desktop client shows this next to the account, and the number comes
     * from a billing facade that answers a bearer alone — no app signature, so
     * this read keeps working even after the client version ages out of the
     * gateway's accepted range.
     */
    /**
     * AutoClaw: accept a balance the desktop client itself just read.
     *
     * The check-in event surface (`/asset-operation/api/v1/checkin/*`) refuses
     * a credential minted by this gateway — measured across the app signature
     * family, the zai token lane, the desktop device headers, and every
     * first-party origin. The wallet route still answers, so the balance is
     * readable directly; what is not readable is the *event* state, which only
     * the running client can report.
     *
     * Rather than forge that client, this route accepts what it says: a relay
     * posts the numbers the app's own Credits screen is showing, and the credits
     * read prefers them while they are fresh. Stale observations are ignored, so
     * a relay that stops running degrades to the vendor read instead of pinning
     * a number that has since moved.
     */
    .post(
      "/accounts/:id/credits/observed",
      {
        body: t.Object({
          /** Total points across every wallet, as the app's Credits screen shows. */
          totalPoints: t.Number(),
          /** Points in the daily wallet when the app reports it separately. */
          dailyPoints: t.Optional(t.Number()),
          /** Vendor day the app's card was showing, `YYYY-MM-DD`. */
          checkinDate: t.Optional(t.String()),
          /** `claimed` / `processing` / `unclaimed` from the app's card. */
          claimStatus: t.Optional(t.String()),
          /** Points granted by today's check-in, when the app reports them. */
          claimedAmount: t.Optional(t.Number()),
          /** Current streak length, when the app reports it. */
          streakDays: t.Optional(t.Number()),
        }),
      },
      async ({ request, params, body, set }) => {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        const rows = await db
          .select({ id: providerAccounts.id, providerId: providerAccounts.providerId })
          .from(providerAccounts)
          .where(
            and(
              eq(providerAccounts.id, params.id),
              // Same visibility rule the credits read uses. A migrated account
              // carries no tenant, and matching only owned rows answered 404 for
              // the very account the card was rendering — so a relay could never
              // post to it while the read worked.
              or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, access.tenantId)),
            ),
          )
          .limit(1);
        const account = rows[0];
        if (!account) {
          set.status = 404;
          return { error: `Account ${params.id} not found`, code: "not_found" };
        }
        if (account.providerId !== "autoclaw") {
          set.status = 400;
          return {
            error: `Observed credits are only accepted for autoclaw accounts`,
            code: "observed_unsupported",
          };
        }
        const observedAt = new Date();
        const envelope = {
          v: 1,
          observedAt: observedAt.toISOString(),
          totalPoints: body.totalPoints,
          dailyPoints: body.dailyPoints ?? null,
          checkinDate: body.checkinDate ?? null,
          claimStatus: body.claimStatus ?? null,
          claimedAmount: body.claimedAmount ?? null,
          streakDays: body.streakDays ?? null,
        };
        try {
          await redis.set(
            observedCreditsKey(account.id),
            JSON.stringify(envelope),
            "EX",
            OBSERVED_CREDITS_TTL_SECONDS,
          );
        } catch (error) {
          set.status = 503;
          return {
            error: error instanceof Error ? error.message : "Observation store unavailable",
            code: "observed_store_unavailable",
          };
        }
        // A claim the app reports makes the day marker unnecessary: the sweep
        // reads that marker to decide whether the account still needs a pass.
        if (body.claimStatus === "claimed" && typeof body.checkinDate === "string") {
          await redis
            .set(
              ledgerKey(body.checkinDate, account.id),
              "1",
              "EX",
              3 * 24 * 60 * 60,
            )
            .catch(() => undefined);
        }
        await redis.del(notificationCacheKey(account.id)).catch(() => undefined);
        if (body.claimStatus === "claimed" && body.checkinDate === checkinDayKeyFor("autoclaw")) {
          await recordCheckinEvidence(redis, "autoclaw", account.id, {
            state: "completed",
            dayKey: body.checkinDate,
            observedAt: envelope.observedAt,
            credit: body.claimedAmount ?? null,
            streakDays: body.streakDays ?? null,
          });
        }
        return { ok: true, observedAt: envelope.observedAt };
      },
    )
    .get("/accounts/:id/credits", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      // Unowned accounts are visible to every tenant through `/quota/overview`,
      // so the points read has to follow the same rule; scoping it to owned rows
      // alone answered 404 for the account the card was rendering.
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.id, params.id),
            or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, access.tenantId)),
          ),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (account.providerId !== "autoclaw") {
        set.status = 400;
        return {
          ok: false,
          error: `Credits are not exposed for provider ${account.providerId}`,
          code: "credits_unsupported",
        };
      }
      // A fresh reading relayed from the running desktop client is the better
      // answer, and on this provider sometimes the only one: the event surface
      // refuses a credential this gateway mints, so the card's own state is
      // reachable solely through the app. Reading it first also means the vendor
      // path becomes an enrichment rather than a prerequisite — a key that has
      // aged out of the gateway's accepted range still leaves the operator with
      // the number that is on his screen.
      const observed = await readObservedCredits(redis, account.id);
      const checkedInToday =
        (await redis.get(ledgerKey(checkinDayKeyFor("autoclaw"), account.id))) !== null;

      let walletEmail: string | null = null;
      let vendorError: string | null = null;
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        // Campaign grants (the "Limited-time Bonus" family) are paid when the
        // server sees the account active, and the desktop client is what
        // normally supplies that signal. Posting it here means an account that
        // lives only in this gateway still collects the period's reward instead
        // of waiting for someone to open the app on a desktop.
        await reportAutoClawActivity(
          credential,
          signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
        );
        const wallet = await fetchAutoClawWallet(
          credential,
          signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
        );
        walletEmail = wallet.email;
        if (observed === null) {
          return { ok: true, wallet, checkedInToday };
        }
      } catch (err) {
        vendorError = err instanceof Error ? err.message : "Credit read failed";
      }

      if (observed !== null) {
        return {
          ok: true,
          wallet: {
            totalBalance: observed.totalPoints,
            dailyPoints: observed.dailyPoints,
            // The relay does not read the profile route, so email is the
            // vendor's answer when it answered at all — never a fabricated "".
            email: walletEmail,
            updatedAt: observed.observedAt,
          },
          checkedInToday: observed.claimStatus === "claimed" ? true : checkedInToday,
          observed: {
            source: "desktop-relay",
            observedAt: observed.observedAt,
            claimStatus: observed.claimStatus,
            claimDate: observed.checkinDate,
            claimedAmount: observed.claimedAmount,
            streakDays: observed.streakDays,
          },
          ...(vendorError === null ? {} : { vendorError }),
        };
      }
      set.status = 502;
      return {
        ok: false,
        error: vendorError ?? "Credit read failed",
        code: "credits_failed",
      };
    })
    /**
     * AutoClaw: the points ledger, newest first.
     *
     * Grants and model charges are the same stream with a signed amount, so one
     * route serves both the "where did my points go" question and the "what did
     * I earn" one; `direction` narrows it upstream rather than filtering here,
     * because the page the operator sees must match the page the vendor paged.
     */
    .get("/accounts/:id/credits/expiring", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.id, params.id),
            or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, access.tenantId)),
          ),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (account.providerId !== "autoclaw") {
        set.status = 400;
        return {
          ok: false,
          error: `Point expiry is not exposed for provider ${account.providerId}`,
          code: "credits_unsupported",
        };
      }
      const url = new URL(request.url);
      const rawWithin = Number(url.searchParams.get("withinDays") ?? "7");
      const withinDays = Number.isFinite(rawWithin)
        ? Math.min(Math.max(Math.trunc(rawWithin), 1), 60)
        : 7;
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        const summary = await fetchAutoClawExpirySummary(credential, fetch, { withinDays });
        return { ok: true, ...summary };
      } catch (err) {
        set.status = 502;
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Expiry summary read failed",
          code: "credits_expiry_failed",
        };
      }
    })
    .get("/accounts/:id/credits/history", async ({ request, params, set }) => {
      const access = requireTenantScope(accessResolver(request), "dashboard:read");
      const rows = await db
        .select()
        .from(providerAccounts)
        .where(
          and(
            eq(providerAccounts.id, params.id),
            or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, access.tenantId)),
          ),
        )
        .limit(1);
      const account = rows[0];
      if (!account) {
        set.status = 404;
        return { error: `Account ${params.id} not found`, code: "not_found" };
      }
      if (account.providerId !== "autoclaw") {
        set.status = 400;
        return {
          ok: false,
          error: `Credit history is not exposed for provider ${account.providerId}`,
          code: "credits_unsupported",
        };
      }
      const url = new URL(request.url);
      const rawDirection = url.searchParams.get("direction") ?? "all";
      if (rawDirection !== "all" && rawDirection !== "income" && rawDirection !== "expense") {
        set.status = 400;
        return {
          ok: false,
          error: "direction must be one of: all, income, expense",
          code: "invalid_request",
        };
      }
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const rawPageSize = Number(url.searchParams.get("pageSize") ?? "20");
      const pageSize = Number.isFinite(rawPageSize)
        ? Math.min(Math.max(Math.trunc(rawPageSize), 1), 100)
        : 20;
      try {
        const credential = await refreshDeps.resolveCredential(
          account.providerId as ProviderId,
          account.id,
        );
        const page = await fetchAutoClawLedger(
          credential,
          {
            direction: rawDirection as AutoClawLedgerDirection,
            ...(cursor ? { cursor } : {}),
            pageSize,
          },
          signalFetch(timeoutSignal(request.signal, QUOTA_REFRESH_TIMEOUT_MS)),
        );
        return { ok: true, ...page };
      } catch (err) {
        set.status = 502;
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Ledger read failed",
          code: "credits_history_failed",
        };
      }
    });
}
