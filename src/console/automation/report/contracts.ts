// CodeBuddy growth-activity report control plane: DTOs, validation, and the
// persistence port the routes and the sweep both read through.
//
// The report itself is `POST {base}/v2/report` (`fetchBuddyActivityReport`),
// already used by the single-account route and the daily check-in ride-along.
// What this domain adds is *bookkeeping*: which accounts have been reported,
// which failed, and a recurring schedule that fires N of them per interval.
//
// One row per account in `provider_report_hits`, not a log of every attempt:
// the upstream scores a login streak, so the only durable fact worth keeping is
// "when was this account last successfully reported". A failure overwrites
// `last_state`/`last_error` but never `hit_at`, because an error must not make
// an already-credited account look uncredited.

import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../domains/audit/contracts";
import { ConsoleDomainError } from "../../shared/errors";
import { BUDDY_PROVIDER_IDS } from "../../../providers/provider-metadata";
import type { ProviderId } from "../../../providers/provider-registry";

/** Default provider when the query omits one: the report surface is a cb feature. */
export const REPORT_DEFAULT_PROVIDER_ID = "cb";

/** How many account rows one page returns; `counts` still covers every row. */
export const REPORT_ACCOUNT_PAGE_LIMIT = 300;

/**
 * Account-list filter. `counts` deliberately ignores it: the four stat tiles
 * describe the provider, not the current view of the table.
 */
export type ReportAccountStatus = "all" | "pending" | "hit" | "failed";

const REPORT_ACCOUNT_STATUSES: Readonly<Record<ReportAccountStatus, true>> = {
  all: true,
  pending: true,
  hit: true,
  failed: true,
};

export const REPORT_MIN_ACCOUNTS_PER_RUN = 1;
export const REPORT_MAX_ACCOUNTS_PER_RUN = 100;
export const REPORT_MIN_INTERVAL_MINUTES = 15;
export const REPORT_MAX_INTERVAL_MINUTES = 1440;

/**
 * Last state recorded for one account. `null` means the account has never been
 * attempted, which is what separates "pending" from "failed" in the counts.
 */
export type ReportLastState = "reported" | "error";

export interface ReportCounts {
  readonly total: number;
  /** Accounts with a successful report on record (`hit_at` set). */
  readonly hit: number;
  /** Accounts never attempted at all. */
  readonly pending: number;
  /** Accounts attempted and never successfully reported. */
  readonly failed: number;
}

export interface ReportAccountRow {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  /** ISO of the last successful hit; `null` = never reported. */
  readonly hitAt: string | null;
  readonly lastState: ReportLastState | null;
  readonly lastError: string | null;
}

export interface ReportSchedule {
  readonly enabled: boolean;
  readonly accountsPerRun: number;
  readonly intervalMinutes: number;
}

export interface ReportAccountsResponse {
  readonly providerId: string;
  /** Counts over every account of the provider, not just the capped page. */
  readonly counts: ReportCounts;
  readonly accounts: readonly ReportAccountRow[];
  readonly schedule: ReportSchedule;
}

export interface ReportHitResult {
  readonly accountId: string;
  readonly label: string;
  readonly state: ReportLastState;
  readonly error: string | null;
}

export interface ReportHitResponse {
  readonly ok: boolean;
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly ReportHitResult[];
}

export interface ReportScheduleResponse extends ReportSchedule {
  readonly providerId: string;
}

/** One account as the store hands it to the routes (dates, not ISO strings). */
export interface ReportAccountRecord {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly hitAt: Date | null;
  readonly lastState: ReportLastState | null;
  readonly lastError: string | null;
}

/** The minimum an account needs to be reported: identity plus a display label. */
export interface ReportPickRecord {
  readonly id: string;
  readonly label: string;
}

export interface ReportScheduleRecord extends ReportSchedule {
  readonly providerId: string;
  readonly lastRunAt: Date | null;
}

/**
 * Persistence boundary for the domain. `DrizzleReportStore` implements it; the
 * tests use an in-memory double so the route/service contract is provable
 * without a database.
 */
export interface ReportStorePort {
  /**
   * Accounts of one provider in one tenant, never-hit first then oldest hit.
   * `status` narrows the page; `countAccounts` stays unfiltered on purpose.
   */
  listAccounts(
    tenantId: string,
    providerId: string,
    limit: number,
    status: ReportAccountStatus,
  ): Promise<readonly ReportAccountRecord[]>;
  /** The same split as {@link listAccounts}, counted over every row. */
  countAccounts(tenantId: string, providerId: string): Promise<ReportCounts>;
  /**
   * Accounts whose last successful hit is older than `dayStart` (or absent),
   * oldest first. `tenantId: null` spans every tenant — the sweep is not a
   * request and has no caller tenant to narrow to.
   */
  pickUnhitAccounts(args: {
    readonly tenantId: string | null;
    readonly providerId: string;
    readonly limit: number;
    readonly dayStart: Date;
  }): Promise<readonly ReportPickRecord[]>;
  /** Records one attempt; success stamps `hitAt`, failure only the state. */
  recordHit(args: {
    readonly accountId: string;
    readonly providerId: string;
    readonly state: ReportLastState;
    readonly error: string | null;
    readonly at: Date;
  }): Promise<void>;
  readSchedule(providerId: string): Promise<ReportScheduleRecord>;
  saveSchedule(args: {
    readonly providerId: string;
    readonly enabled: boolean;
    readonly accountsPerRun: number;
    readonly intervalMinutes: number;
    readonly at: Date;
  }): Promise<ReportScheduleRecord>;
  /** Enabled schedules whose interval has elapsed since `lastRunAt`. */
  listDueSchedules(now: Date): Promise<readonly ReportScheduleRecord[]>;
  markScheduleRun(providerId: string, at: Date): Promise<void>;
}

/**
 * Everything one report pass needs. Shared by the route and the quota sweep so
 * the "pick N unhit accounts, hit them sequentially" loop exists once.
 */
export interface ReportRunDeps {
  readonly store: ReportStorePort;
  readonly resolveCredential: (providerId: ProviderId, accountId: string) => Promise<string>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  /** Injectable delay so tests do not pay the real inter-account gap. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Caller cancellation: the pass stops between accounts, never mid-request. */
  readonly signal?: AbortSignal;
}

export interface ReportRoutesConfig extends ReportRunDeps {
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
}

function invalid(message: string): never {
  throw new ConsoleDomainError("invalid_request", 400, message);
}

/**
 * Normalizes the provider selector.
 *
 * Restricted to the buddy family because the report route exists nowhere else:
 * a provider without `/v2/report` would answer 404 upstream and burn a hit row
 * recording a failure that means nothing. An omitted value defaults to `cb`
 * rather than erroring — the dashboard always asks about one provider.
 */
export function normalizeReportProviderId(raw: unknown): string {
  if (raw === undefined || raw === null) return REPORT_DEFAULT_PROVIDER_ID;
  if (typeof raw !== "string") invalid("providerId must be a string");
  const providerId = raw.trim();
  if (providerId.length === 0) return REPORT_DEFAULT_PROVIDER_ID;
  if (!BUDDY_PROVIDER_IDS.has(providerId)) {
    invalid(`providerId must be one of ${[...BUDDY_PROVIDER_IDS].join(", ")}`);
  }
  return providerId;
}

function integerInRange(raw: unknown, label: string, min: number, max: number): number {
  const value = typeof raw === "string" && raw.trim().length > 0 ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalid(`${label} must be an integer`);
  }
  if (value < min || value > max) invalid(`${label} must be between ${min} and ${max}`);
  return value;
}

/** How many accounts one manual hit run may touch: 1..100. */
export function normalizeReportLimit(raw: unknown): number {
  if (raw === undefined || raw === null) invalid("limit is required");
  return integerInRange(raw, "limit", REPORT_MIN_ACCOUNTS_PER_RUN, REPORT_MAX_ACCOUNTS_PER_RUN);
}

/**
 * Normalizes the account-list filter. Omitted/blank means `all`; anything
 * outside the four states is a request error rather than a silent `all`, so a
 * dashboard typo cannot quietly show the unfiltered list.
 */
export function normalizeReportStatus(raw: unknown): ReportAccountStatus {
  if (raw === undefined || raw === null) return "all";
  if (typeof raw !== "string") invalid("status must be a string");
  const status = raw.trim();
  if (status.length === 0) return "all";
  if (REPORT_ACCOUNT_STATUSES[status as ReportAccountStatus] !== true) {
    invalid("status must be one of all, pending, hit, failed");
  }
  return status as ReportAccountStatus;
}

/** Validates one schedule write; every field is required so a PUT is a replace. */
export function normalizeReportScheduleInput(raw: unknown): ReportSchedule {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    invalid("schedule body must be an object");
  }
  const record = raw as Record<string, unknown>;
  const enabled = record["enabled"];
  if (typeof enabled !== "boolean") invalid("enabled must be a boolean");
  return {
    enabled,
    accountsPerRun: integerInRange(
      record["accountsPerRun"],
      "accountsPerRun",
      REPORT_MIN_ACCOUNTS_PER_RUN,
      REPORT_MAX_ACCOUNTS_PER_RUN,
    ),
    intervalMinutes: integerInRange(
      record["intervalMinutes"],
      "intervalMinutes",
      REPORT_MIN_INTERVAL_MINUTES,
      REPORT_MAX_INTERVAL_MINUTES,
    ),
  };
}

export function toReportAccountRow(record: ReportAccountRecord): ReportAccountRow {
  return {
    id: record.id,
    label: record.label,
    status: record.status,
    hitAt: record.hitAt === null ? null : record.hitAt.toISOString(),
    lastState: record.lastState,
    lastError: record.lastError,
  };
}

export function toReportSchedule(record: ReportScheduleRecord): ReportSchedule {
  return {
    enabled: record.enabled,
    accountsPerRun: record.accountsPerRun,
    intervalMinutes: record.intervalMinutes,
  };
}
