import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import type {
  AppealAccountsResponse,
  AppealRecheckRequest,
  AppealRecheckResponse,
  AppealSendRequest,
  AppealSendResponse,
  AppealStatusFilter,
} from "../contracts";
import { queryKeys } from "../query-keys";
import { querySignal } from "./common";

/**
 * The appeal surface is buddy-family on the backend but the dashboard only
 * exposes the CodeBuddy pool today, same as the growth-report page. The id is
 * a parameter so a second provider needs no hook-layer change.
 */
export const APPEAL_PROVIDER_ID = "cb";

/** Path for the banned-account projection, with the server-side status filter. */
export function appealAccountsPath(
  providerId: string,
  status: AppealStatusFilter = "all",
): string {
  return `/automation/appeal/accounts?providerId=${encodeURIComponent(providerId)}&status=${status}`;
}

/** Loads the appeal projection: counts and the ordered banned-account list. */
export async function fetchAppealAccounts(
  providerId: string,
  status: AppealStatusFilter,
  signal?: AbortSignal,
): Promise<AppealAccountsResponse> {
  return consoleRequest<AppealAccountsResponse>(
    appealAccountsPath(providerId, status),
    signal ? { signal } : undefined,
  );
}

/**
 * The banned-account projection is the page's source of truth: counts plus the
 * ordered list in one response. `staleTime: 0` keeps Refresh honest; the page
 * does not poll — an appeal is a deliberate, operator-visible upstream post.
 */
export function useAppealAccounts(
  status: AppealStatusFilter = "all",
  providerId: string = APPEAL_PROVIDER_ID,
) {
  return useQuery<AppealAccountsResponse>({
    queryKey: queryKeys.automation.appealAccounts(providerId, status),
    queryFn: (context) => fetchAppealAccounts(providerId, status, querySignal(context)),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

/** The wire body for one send. Exported so the contract stays testable. */
export function appealSendRequest(input: Omit<AppealSendRequest, "providerId">): AppealSendRequest {
  return { providerId: APPEAL_PROVIDER_ID, ...input };
}

/**
 * Fires one batch appeal and returns per-account results, so the page renders
 * this run's outcome instead of guessing from refreshed counts.
 */
export async function postAppealSend(input: Omit<AppealSendRequest, "providerId">): Promise<AppealSendResponse> {
  return consoleRequest<AppealSendResponse>("/automation/appeal/send", {
    method: "POST",
    body: JSON.stringify(appealSendRequest(input)),
  });
}

/** Fires a batch appeal and invalidates every filtered account list. */
export function useAppealSend(providerId: string = APPEAL_PROVIDER_ID) {
  const queryClient = useQueryClient();
  return useMutation<AppealSendResponse, ApiErrorShape, Omit<AppealSendRequest, "providerId">>({
    mutationFn: postAppealSend,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.automation.appealAccountsAll(providerId),
      });
    },
  });
}

/** The wire body for one verdict re-check. Exported so the contract stays testable. */
export function appealRecheckRequest(
  input: Omit<AppealRecheckRequest, "providerId">,
): AppealRecheckRequest {
  return { providerId: APPEAL_PROVIDER_ID, ...input };
}

/** Asks the backend to re-read the upstream verdict for already-appealed accounts. */
export async function postAppealRecheck(
  input: Omit<AppealRecheckRequest, "providerId">,
): Promise<AppealRecheckResponse> {
  return consoleRequest<AppealRecheckResponse>("/automation/appeal/recheck", {
    method: "POST",
    body: JSON.stringify(appealRecheckRequest(input)),
  });
}

/** Re-checks appeal verdicts and invalidates every filtered account list. */
export function useAppealRecheck(providerId: string = APPEAL_PROVIDER_ID) {
  const queryClient = useQueryClient();
  return useMutation<
    AppealRecheckResponse,
    ApiErrorShape,
    Omit<AppealRecheckRequest, "providerId">
  >({
    mutationFn: postAppealRecheck,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.automation.appealAccountsAll(providerId),
      });
    },
  });
}
