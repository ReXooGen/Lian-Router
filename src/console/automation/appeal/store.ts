// Drizzle persistence for the appeal control plane.
//
// `cb_appeals` is per-account bookkeeping keyed like `provider_report_hits`
// (one row per account, upsert on write). The banned set is read from
// `provider_accounts` (`last_error_category = 'policy_blocked_banned'`, which
// the health classifier owns) left joined to the appeal rows, so a never-
// appealed account renders from the left-join NULLs and counts need no second
// query shape.

import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { LianRouterDatabase } from "../../../persistence/postgres";
import { models, providerAccountAppeals, providerAccounts } from "../../../persistence/schema";
import type {
  AppealAccountRecord,
  AppealAccountStatus,
  AppealCounts,
  AppealLastState,
  AppealPickRecord,
  AppealStorePort,
  AppealVerdict,
  AppealVerdictCandidate,
} from "./contracts";

/** The exact health-classifier verdict the appeal surface treats as "banned". */
const BANNED_CATEGORY = "policy_blocked_banned";

/** Account columns the console needs; the credential is never part of this. */
const bannedColumns = {
  id: providerAccounts.id,
  label: providerAccounts.label,
  status: providerAccounts.status,
  lastError: providerAccounts.lastError,
  lastErrorAt: providerAccounts.lastErrorAt,
  appealedAt: providerAccountAppeals.appealedAt,
  appealCount: providerAccountAppeals.appealCount,
  feedbackId: providerAccountAppeals.feedbackId,
  lastState: providerAccountAppeals.lastState,
  lastAppealError: providerAccountAppeals.lastError,
  verdict: providerAccountAppeals.verdict,
  verdictCheckedAt: providerAccountAppeals.verdictCheckedAt,
};

export class DrizzleAppealStore implements AppealStorePort {
  constructor(private readonly db: LianRouterDatabase) {}

  async listAccounts(args: {
    readonly tenantId: string;
    readonly providerId: string;
    readonly limit: number;
    readonly status: AppealAccountStatus;
  }): Promise<readonly AppealAccountRecord[]> {
    // Never-appealed first, then oldest appeal: the account an operator can
    // still act on is the one a "work the backlog" read should surface.
    // `pending` and `appealed`/`failed` split on the appeal row's shape:
    // untouched accounts have no row at all (left join ⇒ NULL last_state and
    // NULL last_error ⇒ pending).
    const statusFilter =
      args.status === "all"
        ? undefined
        : args.status === "accepted" || args.status === "declined"
          ? eq(providerAccountAppeals.verdict, args.status)
          : args.status === "appealed"
            ? isNotNull(providerAccountAppeals.appealedAt)
            : args.status === "failed"
              ? and(
                  isNull(providerAccountAppeals.appealedAt),
                  eq(providerAccountAppeals.lastState, "error"),
                )
              : and(
                  isNull(providerAccountAppeals.appealedAt),
                  or(
                    isNull(providerAccountAppeals.lastState),
                    sql`${providerAccountAppeals.lastState} <> 'error'`,
                  ),
                );
    const rows = await this.db
      .select(bannedColumns)
      .from(providerAccounts)
      .leftJoin(providerAccountAppeals, eq(providerAccountAppeals.accountId, providerAccounts.id))
      .where(
        and(
          eq(providerAccounts.providerId, args.providerId),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, args.tenantId)),
          eq(providerAccounts.lastErrorCategory, BANNED_CATEGORY),
          statusFilter,
        ),
      )
      .orderBy(
        sql`${providerAccountAppeals.appealedAt} asc nulls first`,
        asc(providerAccounts.id),
      )
      .limit(args.limit);
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      status: row.status,
      lastError: row.lastError ?? null,
      lastErrorAt: row.lastErrorAt ?? null,
      appealedAt: row.appealedAt ?? null,
      appealCount: row.appealCount ?? 0,
      feedbackId: row.feedbackId ?? null,
      lastState: (row.lastState ?? null) as AppealLastState | null,
      lastAppealError: row.lastAppealError ?? null,
      verdict: row.verdict ?? null,
      verdictCheckedAt: row.verdictCheckedAt ?? null,
    }));
  }

  async countAccounts(args: {
    readonly tenantId: string;
    readonly providerId: string;
  }): Promise<AppealCounts> {
    const rows = await this.db
      .select({
        total: sql<number>`count(*)`,
        appealed: sql<number>`count(*) filter (where ${providerAccountAppeals.appealedAt} is not null)`,
        failed: sql<number>`count(*) filter (
          where ${providerAccountAppeals.appealedAt} is null and ${providerAccountAppeals.lastState} = 'error'
        )`,
        accepted: sql<number>`count(*) filter (where ${providerAccountAppeals.verdict} = 'accepted')`,
        declined: sql<number>`count(*) filter (where ${providerAccountAppeals.verdict} = 'declined')`,
      })
      .from(providerAccounts)
      .leftJoin(providerAccountAppeals, eq(providerAccountAppeals.accountId, providerAccounts.id))
      .where(
        and(
          eq(providerAccounts.providerId, args.providerId),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, args.tenantId)),
          eq(providerAccounts.lastErrorCategory, BANNED_CATEGORY),
        ),
      );
    const row = rows[0];
    const total = Number(row?.total ?? 0);
    const appealed = Number(row?.appealed ?? 0);
    const failed = Number(row?.failed ?? 0);
    return {
      total,
      appealed,
      failed,
      pending: Math.max(0, total - appealed - failed),
      accepted: Number(row?.accepted ?? 0),
      declined: Number(row?.declined ?? 0),
    };
  }

  async pickBannedAccounts(args: {
    readonly tenantId: string;
    readonly providerId: string;
    readonly limit: number;
    readonly onlyUnappealed: boolean;
  }): Promise<readonly AppealPickRecord[]> {
    const rows = await this.db
      .select({ id: providerAccounts.id, label: providerAccounts.label })
      .from(providerAccounts)
      .leftJoin(providerAccountAppeals, eq(providerAccountAppeals.accountId, providerAccounts.id))
      .where(
        and(
          eq(providerAccounts.providerId, args.providerId),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, args.tenantId)),
          eq(providerAccounts.lastErrorCategory, BANNED_CATEGORY),
          args.onlyUnappealed ? isNull(providerAccountAppeals.appealedAt) : undefined,
        ),
      )
      .orderBy(
        sql`${providerAccountAppeals.appealedAt} asc nulls first`,
        asc(providerAccounts.id),
      )
      .limit(args.limit);
    return rows;
  }

  async recordAppeal(args: {
    readonly accountId: string;
    readonly providerId: string;
    readonly succeeded: boolean;
    readonly feedbackId: number | null;
    readonly error: string | null;
    readonly message: string;
    readonly at: Date;
  }): Promise<void> {
    const state: AppealLastState = args.succeeded ? "appealed" : "error";
    await this.db
      .insert(providerAccountAppeals)
      .values({
        accountId: args.accountId,
        providerId: args.providerId,
        appealedAt: args.succeeded ? args.at : null,
        appealCount: args.succeeded ? 1 : 0,
        feedbackId: args.succeeded ? args.feedbackId : null,
        lastState: state,
        lastError: args.error,
        message: args.message,
        updatedAt: args.at,
      })
      .onConflictDoUpdate({
        target: providerAccountAppeals.accountId,
        set: {
          providerId: args.providerId,
          // A failed re-appeal leaves the previous acknowledgement untouched:
          // the upstream already accepted the earlier ticket, and clearing it
          // would make the account look unappealed when it is not.
          ...(args.succeeded
            ? {
                appealedAt: args.at,
                feedbackId: args.feedbackId,
                appealCount: sql`${providerAccountAppeals.appealCount} + 1`,
              }
            : {}),
          lastState: state,
          lastError: args.error,
          message: args.message,
          updatedAt: args.at,
        },
      });
  }

  async readLastAppealedAt(accountId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ appealedAt: providerAccountAppeals.appealedAt })
      .from(providerAccountAppeals)
      .where(eq(providerAccountAppeals.accountId, accountId))
      .limit(1);
    return rows[0]?.appealedAt ?? null;
  }

  async pickAwaitingVerdict(args: {
    readonly tenantId: string;
    readonly providerId: string;
    readonly limit: number;
  }): Promise<readonly AppealVerdictCandidate[]> {
    // Only acknowledged appeals can be judged, and only once: a decided verdict
    // is sticky here so a batch cannot re-probe (and re-mutate) the same rows
    // on every click.
    const rows = await this.db
      .select({
        id: providerAccounts.id,
        label: providerAccounts.label,
        appealedAt: providerAccountAppeals.appealedAt,
      })
      .from(providerAccounts)
      .innerJoin(providerAccountAppeals, eq(providerAccountAppeals.accountId, providerAccounts.id))
      .where(
        and(
          eq(providerAccounts.providerId, args.providerId),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, args.tenantId)),
          isNotNull(providerAccountAppeals.appealedAt),
          isNull(providerAccountAppeals.verdict),
        ),
      )
      .orderBy(asc(providerAccountAppeals.appealedAt), asc(providerAccounts.id))
      .limit(args.limit);
    return rows.flatMap((row) =>
      row.appealedAt === null ? [] : [{ id: row.id, label: row.label, appealedAt: row.appealedAt }],
    );
  }

  async recordVerdict(args: {
    readonly accountId: string;
    readonly verdict: AppealVerdict;
    readonly at: Date;
  }): Promise<void> {
    await this.db
      .update(providerAccountAppeals)
      .set({ verdict: args.verdict, verdictCheckedAt: args.at, updatedAt: args.at })
      .where(eq(providerAccountAppeals.accountId, args.accountId));
  }

  async defaultProbeModelId(providerId: string): Promise<string | null> {
    const rows = await this.db
      .select({ modelId: models.modelId })
      .from(models)
      .where(and(eq(models.providerId, providerId), eq(models.enabled, true)))
      .orderBy(asc(models.modelId))
      .limit(1);
    return rows[0]?.modelId ?? null;
  }
}
