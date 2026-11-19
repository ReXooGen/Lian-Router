// Drizzle persistence for the growth-activity report control plane.
//
// Two tables, two jobs: `provider_report_hits` is per-account bookkeeping the
// console reads, `provider_report_schedule` is the sweep's cursor. Reads are
// tenant-scoped when a request asks (the routes) and tenant-wide when the sweep
// asks — the sweep is a process-level action with no caller tenant, and a
// per-tenant report schedule would need one timer per tenant to be honest.

import { and, asc, eq, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { LianRouterDatabase } from "../../../persistence/postgres";
import { providerAccounts, providerReportHits, providerReportSchedule } from "../../../persistence/schema";
import type {
  ReportAccountRecord,
  ReportAccountStatus,
  ReportCounts,
  ReportLastState,
  ReportPickRecord,
  ReportScheduleRecord,
  ReportStorePort,
} from "./contracts";

/** Account columns the console needs; the credential is never part of this. */
const accountColumns = {
  id: providerAccounts.id,
  label: providerAccounts.label,
  status: providerAccounts.status,
  hitAt: providerReportHits.hitAt,
  lastState: providerReportHits.lastState,
  lastError: providerReportHits.lastError,
};

function toScheduleRecord(row: {
  providerId: string;
  enabled: boolean;
  accountsPerRun: number;
  intervalMinutes: number;
  lastRunAt: Date | null;
}): ReportScheduleRecord {
  return {
    providerId: row.providerId,
    enabled: row.enabled,
    accountsPerRun: row.accountsPerRun,
    intervalMinutes: row.intervalMinutes,
    lastRunAt: row.lastRunAt,
  };
}

export class DrizzleReportStore implements ReportStorePort {
  constructor(private readonly db: LianRouterDatabase) {}

  async listAccounts(
    tenantId: string,
    providerId: string,
    limit: number,
    status: ReportAccountStatus,
  ): Promise<readonly ReportAccountRecord[]> {
    // Never-hit first, then oldest hit: an account that has waited longest is
    // the one a "top up the backlog" read should surface. `nulls first` is
    // Postgres's own ordering for that split, so no CASE expression is needed.
    //
    // `pending` and `failed` share "no successful hit" and split on the last
    // attempt's state; an untouched account has no hit row at all (left join),
    // so its `last_state` is NULL and it belongs to pending.
    const statusFilter =
      status === "all"
        ? undefined
        : status === "hit"
          ? isNotNull(providerReportHits.hitAt)
          : status === "failed"
            ? and(isNull(providerReportHits.hitAt), eq(providerReportHits.lastState, "error"))
            : and(
                isNull(providerReportHits.hitAt),
                or(isNull(providerReportHits.lastState), ne(providerReportHits.lastState, "error")),
              );
    const rows = await this.db
      .select(accountColumns)
      .from(providerAccounts)
      .leftJoin(providerReportHits, eq(providerReportHits.accountId, providerAccounts.id))
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, tenantId)),
          statusFilter,
        ),
      )
      .orderBy(sql`${providerReportHits.hitAt} asc nulls first`, asc(providerAccounts.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      status: row.status,
      hitAt: row.hitAt,
      lastState: row.lastState ?? null,
      lastError: row.lastError ?? null,
    }));
  }

  async countAccounts(tenantId: string, providerId: string): Promise<ReportCounts> {
    // Counted in SQL over every row rather than derived from the capped page:
    // the page limit is a payload bound, not a fact about the provider.
    const rows = await this.db
      .select({
        total: sql<number>`count(*)`,
        hit: sql<number>`count(*) filter (where ${providerReportHits.hitAt} is not null)`,
        failed: sql<number>`count(*) filter (
          where ${providerReportHits.hitAt} is null and ${providerReportHits.lastState} = 'error'
        )`,
      })
      .from(providerAccounts)
      .leftJoin(providerReportHits, eq(providerReportHits.accountId, providerAccounts.id))
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, tenantId)),
        ),
      );
    const row = rows[0];
    const total = Number(row?.total ?? 0);
    const hit = Number(row?.hit ?? 0);
    const failed = Number(row?.failed ?? 0);
    return { total, hit, failed, pending: Math.max(0, total - hit - failed) };
  }

  async pickUnhitAccounts(args: {
    readonly tenantId: string | null;
    readonly providerId: string;
    readonly limit: number;
    readonly dayStart: Date;
  }): Promise<readonly ReportPickRecord[]> {
    // "Not hit today" is a timestamp comparison, not a calendar day key: a
    // hit at 23:59 local must not let the same account be hit again at 00:01
    // of the *same* upstream day, and the upstream's day is UTC. `hit_at` older
    // than the day start (or absent) is exactly that predicate.
    const tenantFilter =
      args.tenantId === null
        ? undefined
        : or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, args.tenantId));
    const rows = await this.db
      .select({ id: providerAccounts.id, label: providerAccounts.label })
      .from(providerAccounts)
      .leftJoin(providerReportHits, eq(providerReportHits.accountId, providerAccounts.id))
      .where(
        and(
          eq(providerAccounts.providerId, args.providerId),
          tenantFilter,
          or(isNull(providerReportHits.hitAt), lt(providerReportHits.hitAt, args.dayStart)),
        ),
      )
      .orderBy(sql`${providerReportHits.hitAt} asc nulls first`, asc(providerAccounts.id))
      .limit(args.limit);
    return rows;
  }

  async recordHit(args: {
    readonly accountId: string;
    readonly providerId: string;
    readonly state: ReportLastState;
    readonly error: string | null;
    readonly at: Date;
  }): Promise<void> {
    const succeeded = args.state === "reported";
    await this.db
      .insert(providerReportHits)
      .values({
        accountId: args.accountId,
        providerId: args.providerId,
        hitAt: succeeded ? args.at : null,
        hitCount: succeeded ? 1 : 0,
        lastState: args.state,
        lastError: args.error,
        updatedAt: args.at,
      })
      .onConflictDoUpdate({
        target: providerReportHits.accountId,
        set: {
          providerId: args.providerId,
          // A failure leaves the previous success in place: the streak the
          // upstream already scored is still real, and clearing it would make
          // the console offer the account again for a day it was credited.
          ...(succeeded ? { hitAt: args.at } : {}),
          hitCount: succeeded
            ? sql`${providerReportHits.hitCount} + 1`
            : sql`${providerReportHits.hitCount}`,
          lastState: args.state,
          lastError: args.error,
          updatedAt: args.at,
        },
      });
  }

  async readSchedule(providerId: string): Promise<ReportScheduleRecord> {
    const rows = await this.db
      .select()
      .from(providerReportSchedule)
      .where(eq(providerReportSchedule.providerId, providerId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      // Defaults match the column defaults so a never-configured provider and a
      // freshly saved one answer identically instead of 404ing a settings page.
      return {
        providerId,
        enabled: false,
        accountsPerRun: 5,
        intervalMinutes: 60,
        lastRunAt: null,
      };
    }
    return toScheduleRecord(row);
  }

  async saveSchedule(args: {
    readonly providerId: string;
    readonly enabled: boolean;
    readonly accountsPerRun: number;
    readonly intervalMinutes: number;
    readonly at: Date;
  }): Promise<ReportScheduleRecord> {
    const rows = await this.db
      .insert(providerReportSchedule)
      .values({
        providerId: args.providerId,
        enabled: args.enabled,
        accountsPerRun: args.accountsPerRun,
        intervalMinutes: args.intervalMinutes,
        updatedAt: args.at,
      })
      .onConflictDoUpdate({
        target: providerReportSchedule.providerId,
        set: {
          enabled: args.enabled,
          accountsPerRun: args.accountsPerRun,
          intervalMinutes: args.intervalMinutes,
          updatedAt: args.at,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Failed to persist report schedule for provider ${args.providerId}`);
    }
    return toScheduleRecord(row);
  }

  async listDueSchedules(now: Date): Promise<readonly ReportScheduleRecord[]> {
    const rows = await this.db
      .select()
      .from(providerReportSchedule)
      .where(
        and(
          eq(providerReportSchedule.enabled, true),
          or(
            isNull(providerReportSchedule.lastRunAt),
            // The interval is per row, so the comparison has to be expressed in
            // SQL against that row's own column instead of a fixed cutoff.
            sql`${providerReportSchedule.lastRunAt} + (${providerReportSchedule.intervalMinutes} * interval '1 minute') <= ${now}`,
          ),
        ),
      );
    return rows.map(toScheduleRecord);
  }

  async markScheduleRun(providerId: string, at: Date): Promise<void> {
    await this.db
      .update(providerReportSchedule)
      .set({ lastRunAt: at, updatedAt: at })
      .where(eq(providerReportSchedule.providerId, providerId));
  }
}
