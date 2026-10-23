import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import type { TunnelStatus } from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, querySignal } from "./common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Loads the tunnel state of this gateway process.
 *
 * The state is process-local, so it never benefits from a long cache: a
 * gateway restart mints a new host and this read is what discovers it.
 */
export function useTunnelStatus() {
  return useQuery<TunnelStatus, ApiErrorShape>({
    queryKey: queryKeys.tunnel.status,
    queryFn: (context) =>
      consoleRequest<TunnelStatus>("/tunnel", { signal: querySignal(context) }),
    ...QUERY_OPTIONS,
    staleTime: 0,
  });
}

/** Starts the quick tunnel; the request stays open until the host is published. */
export function useStartTunnel() {
  const queryClient = useQueryClient();
  return useMutation<TunnelStatus, ApiErrorShape, void>({
    mutationFn: () => consoleRequest<TunnelStatus>("/tunnel/start", { method: "POST" }),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.tunnel.status, status);
    },
    onError: async () => {
      // A failed start still changes the status the server holds (`error`), so
      // re-read it rather than leaving the card on the pre-attempt snapshot.
      await queryClient.invalidateQueries({ queryKey: queryKeys.tunnel.status });
    },
  });
}

/** Stops the tunnel and clears the advertised public host. */
export function useStopTunnel() {
  const queryClient = useQueryClient();
  return useMutation<TunnelStatus, ApiErrorShape, void>({
    mutationFn: () => consoleRequest<TunnelStatus>("/tunnel/stop", { method: "POST" }),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.tunnel.status, status);
    },
  });
}
