import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { consoleRequest, isRecord } from "../api";
import type { ApiErrorShape } from "../api";
import type { UpdateProgress, UpdateStatus } from "../contracts";
import { queryKeys } from "../query-keys";
import { toast } from "../toast";
import { QUERY_OPTIONS, querySignal } from "./common";

/** Idle poll: the launcher checks for releases on its own cadence, so a minute
 * is enough. While an install runs the frame changes every few hundred ms. */
const IDLE_POLL_MS = 60_000;
const RUNNING_POLL_MS = 2_000;

function invalidPayload(message: string): never {
  throw { status: 500, code: "invalid_response", message } satisfies ApiErrorShape;
}

/**
 * The launcher streams a frame per step. `phase`, `percent` and `message` are
 * always present in a real frame, so a payload missing them is a launcher bug
 * rather than an older shape; rejecting it beats defaulting to a bar that never
 * moves. `percent` is only checked for finiteness: the wire type is a plain
 * number and the renderer clamps to `0..100`, so a stricter bound here would
 * reject a frame the backend is allowed to emit.
 */
function assertUpdateProgress(value: unknown): UpdateProgress {
  if (!isRecord(value)) invalidPayload("Invalid update progress payload");
  const progress = value as Record<string, unknown>;
  const bytesValid = (item: unknown): boolean =>
    item === null || (typeof item === "number" && Number.isFinite(item));
  if (
    typeof progress.phase !== "string" ||
    typeof progress.percent !== "number" ||
    !Number.isFinite(progress.percent) ||
    typeof progress.message !== "string" ||
    !bytesValid(progress.bytesReceived) ||
    !bytesValid(progress.bytesTotal) ||
    !(progress.error === null || typeof progress.error === "string")
  ) {
    invalidPayload("Invalid update progress payload");
  }
  return progress as unknown as UpdateProgress;
}

/** Validates `GET /console/api/update`; the modal renders from the returned value. */
export function assertUpdateStatus(value: unknown): UpdateStatus {
  if (!isRecord(value)) invalidPayload("Invalid update status payload");
  const status = value as Record<string, unknown>;
  if (
    typeof status.launcher !== "boolean" ||
    typeof status.current !== "string" ||
    typeof status.available !== "boolean" ||
    typeof status.running !== "boolean" ||
    !(status.latest === null || typeof status.latest === "string") ||
    !(status.notesUrl === null || typeof status.notesUrl === "string") ||
    !(status.publishedAt === null || typeof status.publishedAt === "string")
  ) {
    invalidPayload("Invalid update status payload");
  }
  if (status.progress !== null) assertUpdateProgress(status.progress);
  return status as unknown as UpdateStatus;
}

/**
 * Loads the gateway's update state. `poll: false` disables the interval for a
 * one-shot reader; the modal keeps the default so a running install advances.
 */
export function useUpdateStatus(options: { poll?: boolean } = {}) {
  const poll = options.poll ?? true;
  return useQuery({
    queryKey: queryKeys.update.status,
    queryFn: (context) =>
      consoleRequest<unknown>("/update", { signal: querySignal(context) }).then(assertUpdateStatus),
    ...QUERY_OPTIONS,
    staleTime: 0,
    refetchInterval: (query) => {
      if (!poll) return false;
      return query.state.data?.running === true ? RUNNING_POLL_MS : IDLE_POLL_MS;
    },
  });
}

/** Asks the launcher to install the release it reported as available. */
export function useStartUpdate() {
  const queryClient = useQueryClient();
  return useMutation<{ accepted: boolean }, ApiErrorShape, void>({
    mutationFn: () => consoleRequest<{ accepted: boolean }>("/update/start", { method: "POST" }),
    onSuccess: () => {
      toast.success("Update started", "The gateway will restart when the install finishes.");
      void queryClient.invalidateQueries({ queryKey: queryKeys.update.status });
    },
    onError: (error) => {
      const description =
        error.code === "update_in_progress"
          ? "An update is already running."
          : error.code === "launcher_unavailable"
            ? "This gateway was not started by the lianrouter launcher. Run lianrouter update in the terminal."
            : error.code === "launcher_error"
              ? "The launcher could not start the update."
              : error.message;
      toast.error("Update did not start", description);
    },
  });
}
