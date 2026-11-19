import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  REPORT_ACCOUNT_PAGE_LIMIT,
  REPORT_DEFAULT_PROVIDER_ID,
  REPORT_MAX_ACCOUNTS_PER_RUN,
  REPORT_MAX_INTERVAL_MINUTES,
  REPORT_MIN_ACCOUNTS_PER_RUN,
  REPORT_MIN_INTERVAL_MINUTES,
  type ReportAccountRow as BackendAccountRow,
  type ReportAccountsResponse as BackendAccountsResponse,
  type ReportCounts as BackendCounts,
  type ReportHitResponse as BackendHitResponse,
  type ReportHitResult as BackendHitResult,
  type ReportLastState as BackendLastState,
  type ReportSchedule as BackendSchedule,
  type ReportScheduleResponse as BackendScheduleResponse,
} from "../../src/console/automation/report/contracts";
import type {
  ReportAccountRow,
  ReportAccountsResponse,
  ReportCounts,
  ReportHitResponse,
  ReportHitResult,
  ReportLastState,
  ReportSchedule,
  ReportScheduleResponse,
} from "./lib/contracts";
import {
  REPORT_HIT_DEFAULT,
  REPORT_HIT_MAX,
  REPORT_HIT_MIN,
  REPORT_INTERVAL_DEFAULT,
  REPORT_INTERVAL_MAX,
  REPORT_INTERVAL_MIN,
  REPORT_PAGE_SIZE,
  REPORT_RESULT_RENDER_CAP,
} from "./routes/automation-model";

/**
 * The dashboard mirrors the automation report DTOs and re-derives the bounds
 * the inputs clamp against. `contracts.ts` re-exports the backend types, so the
 * static half of this test would fail to compile on any drift; the value half
 * pins the numeric bounds the page enforces client-side against the backend's
 * own validation window. If the backend widens or narrows a bound, this fails
 * here instead of the page silently rejecting a legal save.
 */
describe("dashboard/backend parity — automation report", () => {
  test("the mirrored DTOs are the backend DTOs, field for field", () => {
    expectTypeOf<ReportCounts>().toEqualTypeOf<BackendCounts>();
    expectTypeOf<ReportAccountRow>().toEqualTypeOf<BackendAccountRow>();
    expectTypeOf<ReportSchedule>().toEqualTypeOf<BackendSchedule>();
    expectTypeOf<ReportScheduleResponse>().toEqualTypeOf<BackendScheduleResponse>();
    expectTypeOf<ReportAccountsResponse>().toEqualTypeOf<BackendAccountsResponse>();
    expectTypeOf<ReportHitResult>().toEqualTypeOf<BackendHitResult>();
    expectTypeOf<ReportHitResponse>().toEqualTypeOf<BackendHitResponse>();
    expectTypeOf<ReportLastState>().toEqualTypeOf<BackendLastState>();
  });

  test("the report provider is the backend default provider", () => {
    expect(REPORT_DEFAULT_PROVIDER_ID).toBe("cb");
  });

  test("the hit bounds match the backend's accepted window", () => {
    expect(REPORT_HIT_MIN).toBe(REPORT_MIN_ACCOUNTS_PER_RUN);
    expect(REPORT_HIT_MAX).toBe(REPORT_MAX_ACCOUNTS_PER_RUN);
    expect(REPORT_HIT_DEFAULT).toBeGreaterThanOrEqual(REPORT_MIN_ACCOUNTS_PER_RUN);
    expect(REPORT_HIT_DEFAULT).toBeLessThanOrEqual(REPORT_MAX_ACCOUNTS_PER_RUN);
  });

  test("the schedule interval bounds match the backend's accepted window", () => {
    expect(REPORT_INTERVAL_MIN).toBe(REPORT_MIN_INTERVAL_MINUTES);
    expect(REPORT_INTERVAL_MAX).toBe(REPORT_MAX_INTERVAL_MINUTES);
    expect(REPORT_INTERVAL_DEFAULT).toBeGreaterThanOrEqual(REPORT_MIN_INTERVAL_MINUTES);
    expect(REPORT_INTERVAL_DEFAULT).toBeLessThanOrEqual(REPORT_MAX_INTERVAL_MINUTES);
  });

  test("the client page size stays under the backend's row cap", () => {
    // The backend returns at most REPORT_ACCOUNT_PAGE_LIMIT rows; paging at a
    // size that exceeded it would render empty pages on a full response.
    expect(REPORT_PAGE_SIZE).toBeLessThanOrEqual(REPORT_ACCOUNT_PAGE_LIMIT);
    expect(REPORT_RESULT_RENDER_CAP).toBeLessThanOrEqual(REPORT_MAX_ACCOUNTS_PER_RUN);
  });
});
