import { consoleRequest, isRecord } from "../api";
import type { ApiErrorShape } from "../api";
import type {
  GenerationCatalog,
  GenerationImageRequest,
  GenerationImageTask,
  GenerationVideoRequest,
  GenerationVideoTask,
} from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, querySignal } from "./common";
import { useMutation, useQuery } from "@tanstack/react-query";

function invalidResponse(message: string): ApiErrorShape {
  return { status: 500, code: "invalid_response", message };
}

function assertCatalog(value: unknown): GenerationCatalog {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw invalidResponse("Invalid generation catalog response");
  }
  const models = value.models.filter(
    (entry): entry is GenerationCatalog["models"][number] =>
      isRecord(entry) &&
      typeof entry.providerId === "string" &&
      typeof entry.providerLabel === "string" &&
      typeof entry.modelId === "string" &&
      (entry.kind === "image" || entry.kind === "video"),
  );
  return { models };
}

function assertImageTask(value: unknown): GenerationImageTask {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.status !== "string" ||
    typeof value.progress !== "number" ||
    typeof value.createdAt !== "number" ||
    !Array.isArray(value.images)
  ) {
    throw invalidResponse("Invalid image task response");
  }
  return value as unknown as GenerationImageTask;
}

function assertVideoTask(value: unknown): GenerationVideoTask {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.status !== "string" ||
    typeof value.progress !== "number" ||
    typeof value.createdAt !== "number"
  ) {
    throw invalidResponse("Invalid video task response");
  }
  return value as unknown as GenerationVideoTask;
}

/** Image and video models this tenant can generate with. */
export function useGenerationCatalog() {
  return useQuery({
    queryKey: queryKeys.generation.catalog,
    queryFn: (context) =>
      consoleRequest<unknown>("/generation/catalog", { signal: querySignal(context) }).then(
        assertCatalog,
      ),
    ...QUERY_OPTIONS,
  });
}

/** Submits one image job; the response is a task (or a completed sync result). */
export function useGenerateImage() {
  return useMutation<GenerationImageTask, ApiErrorShape, GenerationImageRequest>({
    mutationFn: (request) =>
      consoleRequest<unknown>("/generation/images", {
        method: "POST",
        body: JSON.stringify(request),
      }).then(assertImageTask),
  });
}

/** Submits one video job. */
export function useGenerateVideo() {
  return useMutation<GenerationVideoTask, ApiErrorShape, GenerationVideoRequest>({
    mutationFn: (request) =>
      consoleRequest<unknown>("/generation/videos", {
        method: "POST",
        body: JSON.stringify(request),
      }).then(assertVideoTask),
  });
}

/**
 * Polls one image task until it reaches a terminal status. A `sync` id means
 * the provider answered inline and there is nothing to poll.
 */
export function useGenerationImageTask(providerId: string, taskId: string) {
  return useQuery({
    queryKey: queryKeys.generation.imageTask(providerId, taskId),
    queryFn: (context) => {
      if (!providerId || !taskId) {
        throw { status: 400, code: "invalid_request", message: "Task is required" } satisfies ApiErrorShape;
      }
      const query = new URLSearchParams({ providerId }).toString();
      return consoleRequest<unknown>(
        `/generation/images/${encodeURIComponent(taskId)}?${query}`,
        { signal: querySignal(context) },
      ).then(assertImageTask);
    },
    enabled: providerId.length > 0 && taskId.length > 0 && taskId !== "sync",
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 2_000 : false;
    },
    ...QUERY_OPTIONS,
  });
}

/** Polls one video task until it reaches a terminal status. */
export function useGenerationVideoTask(providerId: string, taskId: string) {
  return useQuery({
    queryKey: queryKeys.generation.videoTask(providerId, taskId),
    queryFn: (context) => {
      if (!providerId || !taskId) {
        throw { status: 400, code: "invalid_request", message: "Task is required" } satisfies ApiErrorShape;
      }
      const query = new URLSearchParams({ providerId }).toString();
      return consoleRequest<unknown>(
        `/generation/videos/${encodeURIComponent(taskId)}?${query}`,
        { signal: querySignal(context) },
      ).then(assertVideoTask);
    },
    enabled: providerId.length > 0 && taskId.length > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 2_000 : false;
    },
    ...QUERY_OPTIONS,
  });
}
