// CodeBuddy appeal control plane: DTOs, validation, and the persistence port.
//
// The health classifier already answers "is this account banned?" —
// `provider_accounts.last_error_category = 'policy_blocked_banned'`, status
// `disabled`. What this domain adds is *bookkeeping and action*: which bans
// have been appealed, the upstream POST itself (`POST {cb base}/v2/feedback`,
// multipart `content=<message>` under the account's own OAuth token, proven
// against the live upstream: 200 `{"code":0,…,"data":{"feedback_id":N}}`), and
// a batch sender so an operator does not click 89 times.
//
// One row per account in `cb_appeals`, mirroring `provider_report_hits`: the
// upstream gives one `feedback_id` per accepted appeal, so the only durable
// facts worth keeping are "appealed when, acknowledged as what". A failure
// overwrites `last_state`/`last_error` but never an existing `appealed_at`.

import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../domains/audit/contracts";
import { ConsoleDomainError } from "../../shared/errors";
import { BUDDY_PROVIDER_IDS } from "../../../providers/provider-metadata";

/** Default provider when the body omits one: appeals are a buddy-family feature. */
export const APPEAL_DEFAULT_PROVIDER_ID = "cb";

/** How many banned account rows one list read returns; counts cover every row. */
export const APPEAL_ACCOUNT_PAGE_LIMIT = 500;

/** Batch re-appeal ceiling per request: bounded blast radius, sequential send. */
export const APPEAL_MAX_BATCH = 100;

/** Account-list filter, in the console's display order. */
export type AppealAccountStatus =
  | "all"
  | "pending"
  | "appealed"
  | "failed"
  | "accepted"
  | "declined";

const APPEAL_ACCOUNT_STATUSES: Readonly<Record<AppealAccountStatus, true>> = {
  all: true,
  pending: true,
  appealed: true,
  failed: true,
  accepted: true,
  declined: true,
};

/**
 * Derived appeal outcome. The upstream reports nothing but a `feedback_id`, so
 * the console infers the verdict from whether the account works again; NULL on
 * the row means "not decided yet", not "no".
 */
export type AppealVerdict = "accepted" | "declined";

/**
 * How long an acknowledged appeal stays undecided while the account is still
 * restricted. Below this the appeal may simply not have been reviewed yet; at
 * or above it a still-restricted probe is the verdict. A constant, not env: it
 * describes the upstream's review latency, not a deployment knob.
 */
export const APPEAL_DECLINE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Last recorded outcome for one account's latest appeal attempt. */
export type AppealLastState = "appealed" | "error";

export interface AppealCounts {
  readonly total: number;
  readonly appealed: number;
  readonly failed: number;
  readonly pending: number;
  readonly accepted: number;
  readonly declined: number;
}

export interface AppealAccountRow {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly appealedAt: string | null;
  readonly appealCount: number;
  readonly feedbackId: number | null;
  readonly lastState: AppealLastState | null;
  readonly lastAppealError: string | null;
  readonly verdict: AppealVerdict | null;
  readonly verdictCheckedAt: string | null;
}

export interface AppealAccountsResponse {
  readonly providerId: string;
  readonly counts: AppealCounts;
  readonly accounts: readonly AppealAccountRow[];
}

export interface AppealSendResult {
  readonly accountId: string;
  readonly label: string;
  readonly state: "appealed" | "error";
  readonly feedbackId: number | null;
  readonly error: string | null;
}

export interface AppealSendResponse {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly AppealSendResult[];
}

/** One account as the store hands it to the routes (dates as ISO strings). */
export interface AppealAccountRecord {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly lastError: string | null;
  readonly lastErrorAt: Date | null;
  readonly appealedAt: Date | null;
  readonly appealCount: number;
  readonly feedbackId: number | null;
  readonly lastState: AppealLastState | null;
  readonly lastAppealError: string | null;
  readonly verdict: AppealVerdict | null;
  readonly verdictCheckedAt: Date | null;
}

/** The minimum an account needs to be appealed: identity plus a display label. */
export interface AppealPickRecord {
  readonly id: string;
  readonly label: string;
}

/** One acknowledged appeal awaiting a derived verdict. */
export interface AppealVerdictCandidate {
  readonly id: string;
  readonly label: string;
  readonly appealedAt: Date;
}

/** One account's recheck outcome, as the console renders it. */
export interface AppealRecheckResult {
  readonly accountId: string;
  readonly label: string;
  readonly verdict: AppealVerdict | "pending";
  readonly error: string | null;
}

export interface AppealRecheckResponse {
  readonly providerId: string;
  readonly attempted: number;
  readonly accepted: number;
  readonly declined: number;
  readonly pending: number;
  readonly results: readonly AppealRecheckResult[];
}

/**
 * The probe's answer, narrowed to what a verdict needs. `ok` mirrors
 * `ProviderProbingService.probeModel`; `statusCode` is the upstream HTTP status
 * when the failure came from upstream (403 is how this family refuses a banned
 * account).
 */
export interface AppealProbeOutcome {
  readonly ok: boolean;
  readonly statusCode?: number;
  readonly error?: string;
}

/** Message bounds mirrored from the manual probe: short, plain-text appeal. */
export const APPEAL_MESSAGE_MAX_LENGTH = 2000;

export interface AppealRoutesConfig {
  readonly store: AppealStorePort;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
  /** Decrypts/refreshes one account's credential, exactly as the report surface uses. */
  readonly resolveCredential: (providerId: string, accountId: string) => Promise<string>;
  /**
   * Runs one account through the shipped probe pipeline. Injected as a single
   * function so the pass never hand-rolls an upstream call and tests can stub
   * the outcome without a provider.
   */
  readonly probeAccount: (args: {
    readonly tenantId: string;
    readonly providerId: string;
    readonly accountId: string;
    readonly modelId: string;
  }) => Promise<AppealProbeOutcome>;
  /** Puts a working account back in rotation (`recoverAccount` in account-health). */
  readonly recoverAccount: (accountId: string) => Promise<void>;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}

/**
 * Persistence boundary for the appeal domain. The Drizzle store implements it;
 * tests can double it in memory.
 */
export interface AppealStorePort {
  listAccounts(args: {
    readonly tenantId: string;
    readonly providerId: string;
    readonly limit: number;
    readonly status: AppealAccountStatus;
  }): Promise<readonly AppealAccountRecord[]>;

  countAccounts(args: {
    readonly tenantId: string;
    readonly providerId: string;
  }): Promise<AppealCounts>;

  /** Banned accounts (any status filter the sweep respects), unappealed first. */
  pickBannedAccounts(args: {
    readonly tenantId: string;
    readonly providerId: string;
    readonly limit: number;
    readonly onlyUnappealed: boolean;
  }): Promise<readonly AppealPickRecord[]>;

  recordAppeal(args: {
    readonly accountId: string;
    readonly providerId: string;
    readonly succeeded: boolean;
    readonly feedbackId: number | null;
    readonly error: string | null;
    readonly message: string;
    readonly at: Date;
  }): Promise<void>;

  /** For rate limiting re-sends: the last acknowledged appeal timestamp. */
  readLastAppealedAt(accountId: string): Promise<Date | null>;

  /** Acknowledged appeals with no verdict yet, oldest appeal first. */
  pickAwaitingVerdict(args: {
    readonly tenantId: string;
    readonly providerId: string;
    readonly limit: number;
  }): Promise<readonly AppealVerdictCandidate[]>;

  /** Writes the derived outcome; the acceptance path also recovers the account. */
  recordVerdict(args: {
    readonly accountId: string;
    readonly verdict: AppealVerdict;
    readonly at: Date;
  }): Promise<void>;

  /** First enabled model of the provider, used when the body omits `modelId`. */
  defaultProbeModelId(providerId: string): Promise<string | null>;
}

/**
 * Normalizes the provider selector. Omitted means the default; unknown ids are
 * a request error rather than an empty list, so a dashboard typo cannot read as
 * "no banned accounts".
 */
export function normalizeAppealProviderId(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return APPEAL_DEFAULT_PROVIDER_ID;
  if (typeof raw !== "string") return invalid("providerId must be a string");
  const normalized = raw.trim().toLowerCase();
  if (!BUDDY_PROVIDER_IDS.has(normalized)) return invalid(`Unknown provider "${raw}"`);
  return normalized;
}

/**
 * Normalizes the account-list filter. Omitted/blank means `all`; anything
 * outside the four states is a request error rather than a silent `all`.
 */
export function normalizeAppealStatus(raw: unknown): AppealAccountStatus {
  if (raw === undefined || raw === null || raw === "") return "all";
  if (typeof raw !== "string") return invalid("status must be a string");
  const normalized = raw.trim().toLowerCase();
  if (normalized in APPEAL_ACCOUNT_STATUSES) return normalized as AppealAccountStatus;
  return invalid(`Unknown status filter "${raw}"`);
}

function integerInRange(raw: unknown, label: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return invalid(`${label} must be a number`);
  const truncated = Math.trunc(raw);
  if (truncated < min || truncated > max) return invalid(`${label} must be ${min}..${max}`);
  return truncated;
}

/** How many accounts one batch appeal may touch: 1..100. */
export function normalizeAppealLimit(raw: unknown): number {
  return integerInRange(raw, "limit", 1, APPEAL_MAX_BATCH);
}

/**
 * Probe model for a recheck. Optional: blank means "use the provider's first
 * enabled model", so the operator does not have to name one for the common case.
 */
export function normalizeAppealModelId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return invalid("modelId must be a string");
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > 200) return invalid("modelId must be at most 200 characters");
  return trimmed;
}

/**
 * The appeal message: optional (the sender substitutes the default), length
 * bounded, control characters stripped. Plain text only — the endpoint takes a
 * multipart `content` field, not markup.
 */
export function normalizeAppealMessage(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return invalid("message must be a string");
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (cleaned.length > APPEAL_MESSAGE_MAX_LENGTH) {
    return invalid(`message must be at most ${APPEAL_MESSAGE_MAX_LENGTH} characters`);
  }
  return cleaned;
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toAppealAccountRow(record: AppealAccountRecord): AppealAccountRow {
  return {
    id: record.id,
    label: record.label,
    status: record.status,
    lastError: record.lastError,
    lastErrorAt: isoOrNull(record.lastErrorAt),
    appealedAt: isoOrNull(record.appealedAt),
    appealCount: record.appealCount,
    feedbackId: record.feedbackId,
    lastState: record.lastState,
    lastAppealError: record.lastAppealError,
    verdict: record.verdict,
    verdictCheckedAt: isoOrNull(record.verdictCheckedAt),
  };
}

function invalid(message: string): never {
  throw new ConsoleDomainError("invalid_request", 400, message);
}
