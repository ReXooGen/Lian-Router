import type { ReportAccountRow, ReportStatusFilter } from "../lib/contracts";

/** Backend accepts 1..100 accounts per manual run. */
export const REPORT_HIT_MIN = 1;
export const REPORT_HIT_MAX = 100;
export const REPORT_HIT_DEFAULT = 5;

/** Backend schedule bounds (`REPORT_MIN_INTERVAL_MINUTES` / `MAX`). */
export const REPORT_INTERVAL_MIN = 15;
export const REPORT_INTERVAL_MAX = 1440;
export const REPORT_INTERVAL_DEFAULT = 60;

/** Client-side page size for the account table (backend caps the list at 300). */
export const REPORT_PAGE_SIZE = 25;

/**
 * A 100-account run returns 100 rows. Rendering them all as result cards janks
 * the page, so the per-run result list is capped — the totals still report the
 * full run.
 */
export const REPORT_RESULT_RENDER_CAP = 50;

/** At most this many quota windows render per account row (25 rows × 4 = 100 bars). */
export const REPORT_QUOTA_WINDOW_CAP = 4;

/** The hit-state filter options, in display order. Labels are operator-facing copy. */
export const REPORT_STATUS_OPTIONS: readonly {
  readonly value: ReportStatusFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Belum di-hit" },
  { value: "hit", label: "Sudah di-hit" },
  { value: "failed", label: "Gagal" },
];

/**
 * The filter control's whole decision: switch the server-side filter and drop
 * the table back to page 1, because the row set the pages were counted against
 * no longer exists. Exported so the change path is testable without a DOM.
 */
export function applyStatusFilter(
  next: ReportStatusFilter,
  apply: {
    setStatus: (status: ReportStatusFilter) => void;
    setPage: (page: number) => void;
  },
): void {
  apply.setStatus(next);
  apply.setPage(1);
}

/** Coerces the hit input to an integer inside the backend's accepted range. */
export function clampHitLimit(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return REPORT_HIT_DEFAULT;
  return Math.min(REPORT_HIT_MAX, Math.max(REPORT_HIT_MIN, Math.trunc(parsed)));
}

/** Coerces a schedule number to a positive integer, falling back to `fallback`. */
export function clampPositiveInt(value: number | string, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

/**
 * Clamps the interval to the backend's accepted window. The backend rejects an
 * out-of-range PUT with a 400, so the input is bounded here rather than letting
 * a save fail on a number the operator could not have known was invalid.
 */
export function clampIntervalMinutes(value: number | string): number {
  return Math.min(
    REPORT_INTERVAL_MAX,
    Math.max(REPORT_INTERVAL_MIN, clampPositiveInt(value, REPORT_INTERVAL_DEFAULT)),
  );
}

export type HitState = "hit" | "failed" | "never";

/**
 * A row is `failed` when its last attempt errored, `hit` when it has a hit
 * timestamp and no error, and `never` when it has neither. `lastState` alone is
 * not enough: a stale error string can outlive the attempt that produced it.
 */
export function hitStateOf(row: ReportAccountRow): HitState {
  if (row.lastError) return "failed";
  if (row.hitAt) return "hit";
  return "never";
}

/** One-line schedule summary, or "Off" when the schedule is disabled. */
export function scheduleSummary(
  enabled: boolean,
  accountsPerRun: number,
  intervalMinutes: number,
): string {
  if (!enabled) return "Off";
  return `every ${intervalMinutes} min · ${accountsPerRun} accounts`;
}

/** Slices the ordered account list into the requested page (1-based). */
export function pageSlice<T>(rows: readonly T[], page: number, size = REPORT_PAGE_SIZE): readonly T[] {
  const start = Math.max(0, (page - 1) * size);
  return rows.slice(start, start + size);
}

/** Total page count for a row set, never below 1 so "Page 1 of 1" reads right. */
export function pageCount(total: number, size = REPORT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/**
 * The Hit button's whole decision: clamp what the operator typed, then hand the
 * clamped number to the mutation. Exported so the click path is testable
 * without a DOM, and so the page cannot post an out-of-range limit.
 */
export function beginHit(
  input: number | string,
  mutate: (limit: number) => void,
): void {
  mutate(clampHitLimit(input));
}

/**
 * The Save button's decision: clamp both numbers to positive integers, then
 * hand the schedule body to the mutation.
 */
export function beginScheduleSave(
  draft: { enabled: boolean; accountsPerRun: number | string; intervalMinutes: number | string },
  save: (input: { enabled: boolean; accountsPerRun: number; intervalMinutes: number }) => void,
): void {
  save({
    enabled: draft.enabled,
    accountsPerRun: clampHitLimit(draft.accountsPerRun),
    intervalMinutes: clampIntervalMinutes(draft.intervalMinutes),
  });
}

