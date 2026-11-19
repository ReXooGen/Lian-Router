import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import type {
  ReportAccountsResponse,
  ReportHitRequest,
  ReportHitResponse,
  ReportScheduleRequest,
  ReportScheduleResponse,
  ReportStatusFilter,
} from "../contracts";
import { queryKeys } from "../query-keys";
import { querySignal } from "./common";

/**
 * The growth-activity report surface is CodeBuddy-only: the backend sweep reads
 * `cb` accounts' activity endpoint. The provider id is a parameter rather than
 * a constant so the page can be pointed at another buddy id later without
 * touching the hook layer.
 */
export const AUTOMATION_REPORT_PROVIDER_ID = "cb";

/** Path for the account projection, with the server-side status filter. */
export function reportAccountsPath(
  providerId: string,
  status: ReportStatusFilter = "all",
): string {
  return `/automation/report/accounts?providerId=${encodeURIComponent(providerId)}&status=${status}`;
}

/** Loads the report account projection: counts, ordered accounts, schedule. */
export async function fetchReportAccounts(
  providerId: string,
  status: ReportStatusFilter,
  signal?: AbortSignal,
): Promise<ReportAccountsResponse> {
  return consoleRequest<ReportAccountsResponse>(
    reportAccountsPath(providerId, status),
    signal ? { signal } : undefined,
  );
}

/** The wire body for one manual run. Exported so the contract is testable. */
export function hitReportRequest(limit: number): ReportHitRequest {
  return { providerId: "cb", limit };
}

/** Fires one manual report run and returns its per-account results. */
export async function postHitReport(limit: number): Promise<ReportHitResponse> {
  return consoleRequest<ReportHitResponse>("/automation/report/hit", {
    method: "POST",
    body: JSON.stringify(hitReportRequest(limit)),
  });
}

/**
 * The account projection is the page's single source of truth: counts, the
 * ordered account list (never-hit first), and the schedule all arrive in one
 * response. `status` filters the list server-side; the counts stay global, so
 * the page's stat tiles never move with the filter. `staleTime: 0` keeps a
 * manual refresh honest; the page does not poll — a hit is a deliberate,
 * expensive upstream call.
 */
export function useReportAccounts(
  status: ReportStatusFilter = "all",
  providerId: string = AUTOMATION_REPORT_PROVIDER_ID,
) {
  return useQuery<ReportAccountsResponse>({
    queryKey: queryKeys.automation.reportAccounts(providerId, status),
    queryFn: (context) => fetchReportAccounts(providerId, status, querySignal(context)),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

/**
 * Fires the growth-activity report for up to `limit` accounts. The response
 * carries per-account results, so the page renders the outcome of this run
 * instead of guessing from the refreshed counts.
 */
export function useHitReport(providerId: string = AUTOMATION_REPORT_PROVIDER_ID) {
  const queryClient = useQueryClient();
  return useMutation<ReportHitResponse, ApiErrorShape, number>({
    mutationFn: postHitReport,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.automation.reportAccountsAll(providerId),
      });
    },
  });
}

/** Reads the saved schedule on its own, for callers that do not need accounts. */
export async function fetchReportSchedule(
  providerId: string,
  signal?: AbortSignal,
): Promise<ReportScheduleResponse> {
  return consoleRequest<ReportScheduleResponse>(
    `/automation/report/schedule?providerId=${encodeURIComponent(providerId)}`,
    signal ? { signal } : undefined,
  );
}

/** The wire body for a schedule save. */
export function scheduleRequest(
  input: Omit<ReportScheduleRequest, "providerId">,
): ReportScheduleRequest {
  return { providerId: "cb", ...input };
}

/** Persists the schedule. */
export async function putReportSchedule(
  input: Omit<ReportScheduleRequest, "providerId">,
): Promise<ReportScheduleResponse> {
  return consoleRequest<ReportScheduleResponse>("/automation/report/schedule", {
    method: "PUT",
    body: JSON.stringify(scheduleRequest(input)),
  });
}

export function useReportSchedule(providerId: string = AUTOMATION_REPORT_PROVIDER_ID) {
  return useQuery<ReportScheduleResponse>({
    queryKey: queryKeys.automation.reportSchedule(providerId),
    queryFn: (context) => fetchReportSchedule(providerId, querySignal(context)),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** Persists the schedule and invalidates both automation reads. */
export function useSaveReportSchedule(providerId: string = AUTOMATION_REPORT_PROVIDER_ID) {
  const queryClient = useQueryClient();
  return useMutation<
    ReportScheduleResponse,
    ApiErrorShape,
    Omit<ReportScheduleRequest, "providerId">
  >({
    mutationFn: putReportSchedule,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.automation.reportAccountsAll(providerId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.automation.reportSchedule(providerId),
        }),
      ]);
    },
  });
}
