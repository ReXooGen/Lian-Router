import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { consoleRequest, type ApiErrorShape } from "../api";
import type { ModelAbuseBan } from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, querySignal } from "./common";

/**
 * Active model-abuse bans.
 *
 * `enabled` gates the read on platform-admin status: the route is admin-only,
 * so a tenant operator who opened the panel would otherwise get a 403 that the
 * shell turns into a session-expiry signal.
 */
export function useModelBans(enabled: boolean) {
  return useQuery<readonly ModelAbuseBan[]>({
    queryKey: queryKeys.modelBans.all,
    queryFn: async (context) => {
      const result = await consoleRequest<{ bans: readonly ModelAbuseBan[] }>("/model-bans", {
        signal: querySignal(context),
      });
      return result.bans;
    },
    enabled,
    ...QUERY_OPTIONS,
  });
}

/** Lifts one ban. The address can reach the gateway again immediately. */
export function useUnbanModel() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string>({
    mutationFn: (ip) =>
      consoleRequest<{ success: boolean }>("/model-bans", {
        method: "DELETE",
        body: JSON.stringify({ ip }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelBans.all });
    },
  });
}

/**
 * Lifts a network-layer IP ban (`POST /security/ip-unban`).
 *
 * Clears every store that may hold the address — the gateway admission layer's
 * Redis ban and the console login lockout row — so one action unblocks a
 * client regardless of which layer locked it. A store reporting "not banned"
 * is fine: the other store's lift is what counts.
 */
export function useIpUnban() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean; lifted: readonly string[] },
    ApiErrorShape,
    string
  >({
    mutationFn: (ip) =>
      consoleRequest<{ success: boolean; lifted: readonly string[] }>("/security/ip-unban", {
        method: "POST",
        body: JSON.stringify({ ip }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelBans.all });
    },
  });
}
