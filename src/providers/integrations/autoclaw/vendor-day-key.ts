/**
 * The vendor's own day for the AutoClaw check-in ledger.
 *
 * Measured 2026-11-15 ~05:00 WIB: the facade's `daily_signin` flipped back to
 * claimable before 05:00 WIB while the previous UTC-day marker still read done
 * — the vendor resets its daily tasks on its local day (UTC+8), not on UTC.
 * The ledger keyed on `checkinDayKey()` (UTC) therefore kept saying "claimed
 * today" for up to seven hours after the real reset, and the Credits card's
 * button sat disabled while the claim was live.
 *
 * `en-CA` formats as strict YYYY-MM-DD and `timeZone` does the day arithmetic,
 * so there is no hand-rolled offset table to rot when DST rules change.
 */
export const CHECKIN_DAY_TIMEZONE = "Asia/Jakarta";

export function vendorDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CHECKIN_DAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
