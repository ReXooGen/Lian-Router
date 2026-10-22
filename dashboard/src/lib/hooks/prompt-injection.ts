import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { consoleRequest, type ApiErrorShape } from "../api";
import type {
  PromptInjectionCatalog,
  PromptInjectionInput,
  PromptInjectionPreviewEntry,
} from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, querySignal } from "./common";

/** The whole injection catalog: global entry, per-key map, per-model map. */
export function usePromptInjections() {
  return useQuery({
    queryKey: queryKeys.promptInjection.all,
    queryFn: (context) =>
      consoleRequest<PromptInjectionCatalog>("/prompt-injection", {
        signal: querySignal(context),
      }),
    ...QUERY_OPTIONS,
  });
}

/**
 * The exact stack a request would receive for one key + model, in order.
 * Disabled until at least one selector is set; the preview is a diagnostic,
 * not a page load.
 */
export function usePromptInjectionPreview(keyId: string | null, model: string) {
  const params = new URLSearchParams({ preview: "1" });
  if (keyId !== null) params.set("keyId", keyId);
  if (model.trim().length > 0) params.set("model", model.trim());
  return useQuery({
    queryKey: queryKeys.promptInjection.preview(keyId, model),
    queryFn: (context) =>
      consoleRequest<{ stack: readonly PromptInjectionPreviewEntry[] }>(
        `/prompt-injection?${params.toString()}`,
        { signal: querySignal(context) },
      ),
    enabled: keyId !== null || model.trim().length > 0,
    ...QUERY_OPTIONS,
  });
}

export type SavePromptInjectionRequest =
  | { readonly global: PromptInjectionInput | null }
  | ({ readonly keyId: string } & PromptInjectionInput)
  | ({ readonly model: string } & PromptInjectionInput);

/** Creates or replaces one target's entry; an empty prompt deletes it server-side. */
export function useSavePromptInjection() {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiErrorShape, SavePromptInjectionRequest>({
    mutationFn: (input) =>
      consoleRequest<unknown>("/prompt-injection", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.promptInjection.all });
    },
  });
}

export interface PromptInjectionTarget {
  readonly scope: "global" | "key" | "model";
  readonly target: string;
  readonly name: string;
}

/** Removes one named entry from its target. */
export function useDeletePromptInjection() {
  const queryClient = useQueryClient();
  return useMutation<{ deleted: boolean }, ApiErrorShape, PromptInjectionTarget>({
    mutationFn: ({ scope, target, name }) => {
      const params = new URLSearchParams();
      if (scope === "global") params.set("global", "1");
      else if (scope === "key") params.set("keyId", target);
      else params.set("model", target);
      params.set("name", name);
      return consoleRequest<{ deleted: boolean }>(`/prompt-injection?${params.toString()}`, {
        method: "DELETE",
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.promptInjection.all });
    },
  });
}

/** Makes one saved entry the applied persona for its target. */
export function useActivatePromptInjection() {
  const queryClient = useQueryClient();
  return useMutation<{ activated: boolean }, ApiErrorShape, PromptInjectionTarget>({
    mutationFn: ({ scope, target, name }) =>
      consoleRequest<{ activated: boolean }>("/prompt-injection/activate", {
        method: "POST",
        body: JSON.stringify({ scope, target, name }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.promptInjection.all });
    },
  });
}
