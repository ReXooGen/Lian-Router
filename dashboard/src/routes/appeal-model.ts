import type { AppealAccountRow, AppealStatusFilter } from "../lib/contracts";

/** Backend accepts 1..100 accounts per batch send (mirrors the report hit cap). */
export const APPEAL_SEND_MIN = 1;
export const APPEAL_SEND_MAX = 100;
export const APPEAL_SEND_DEFAULT = 5;

/** The verdict re-check has its own bounded batch and default. */
export const APPEAL_RECHECK_MIN = 1;
export const APPEAL_RECHECK_MAX = 100;
export const APPEAL_RECHECK_DEFAULT = 20;

/** Client-side page size for the banned-account table (backend caps at 500). */
export const APPEAL_PAGE_SIZE = 25;

/** At most this many per-run result rows render; totals still report the run. */
export const APPEAL_RESULT_RENDER_CAP = 50;

/** Message textarea ceiling — mirrored and enforced by the backend contract. */
export const APPEAL_MESSAGE_MAX_LENGTH = 2000;

/** The status filter options, in display order. Labels are operator-facing copy. */
export const APPEAL_STATUS_OPTIONS: readonly {
  readonly value: AppealStatusFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Belum di-appeal" },
  { value: "appealed", label: "Sudah di-appeal" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
  { value: "failed", label: "Gagal" },
];

/**
 * The filter control's whole decision: switch the server-side filter and drop
 * the table back to page 1, because the row set behind the pages is gone.
 * Mirrors the report page's `applyStatusFilter` (kept separate: the two pages
 * must not couple their state machines).
 */
export function applyAppealFilter(
  next: AppealStatusFilter,
  apply: {
    setStatus: (status: AppealStatusFilter) => void;
    setPage: (page: number) => void;
  },
): void {
  apply.setStatus(next);
  apply.setPage(1);
}

/** Coerces the batch input to an integer inside the backend's accepted range. */
export function clampAppealLimit(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return APPEAL_SEND_DEFAULT;
  return Math.min(APPEAL_SEND_MAX, Math.max(APPEAL_SEND_MIN, Math.trunc(parsed)));
}

export type AppealRowState = "accepted" | "declined" | "appealed" | "failed" | "pending";

/**
 * A recorded verdict outranks the appeal acknowledgement: an accepted appeal is
 * `accepted`, a declined one is `declined`. Without a verdict the old order
 * holds — `failed` when it has an unanswered error and no acknowledgement,
 * `appealed` when the upstream returned a feedback_id at some point, and
 * `pending` otherwise.
 */
export function appealStateOf(row: AppealAccountRow): AppealRowState {
  if (row.verdict === "accepted") return "accepted";
  if (row.verdict === "declined") return "declined";
  if (row.appealedAt || row.feedbackId !== null) return "appealed";
  if (row.lastState === "error" || row.lastAppealError) return "failed";
  return "pending";
}

/** Coerces the re-check input to an integer inside the backend's accepted range. */
export function clampAppealRecheckLimit(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return APPEAL_RECHECK_DEFAULT;
  return Math.min(APPEAL_RECHECK_MAX, Math.max(APPEAL_RECHECK_MIN, Math.trunc(parsed)));
}

/**
 * The Re-check button's whole decision: clamp what the operator typed, then
 * hand the bounded batch to the mutation. No model is sent from this page, so
 * the backend picks its default.
 */
export function beginAppealRecheck(
  input: number | string,
  mutate: (input: { limit: number }) => void,
): void {
  mutate({ limit: clampAppealRecheckLimit(input) });
}

/**
 * Slices the ordered account list into the requested page (1-based).
 */
export function appealPageSlice<T>(rows: readonly T[], page: number, size = APPEAL_PAGE_SIZE): readonly T[] {
  const start = Math.max(0, (page - 1) * size);
  return rows.slice(start, start + size);
}

/** Total page count for a row set, never below 1 so "Page 1 of 1" reads right. */
export function appealPageCount(total: number, size = APPEAL_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/**
 * The Send button's whole decision: clamp what the operator typed, then hand
 * the clamped batch to the mutation together with the trimmed message and the
 * explicit re-send flag.
 */
export function beginAppealSend(
  input: number | string,
  message: string,
  resend: boolean,
  mutate: (input: { limit: number; message: string; resend: boolean }) => void,
): void {
  mutate({ limit: clampAppealLimit(input), message: message.trim(), resend });
}
