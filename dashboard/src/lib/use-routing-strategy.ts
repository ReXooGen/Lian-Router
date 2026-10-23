import { useEffect, useState } from "react";
import { useProviderRouting, useUpdateProviderRouting } from "./hooks/routing";
import { useDebouncedSave } from "./use-debounced-save";
import type { ProviderRoutingResponse } from "./contracts";

export type RoutingStrategy = ProviderRoutingResponse["strategy"];

export const ROUTING_ACTIVE_LABEL = {
  fallback: "Failover",
  roundRobin: "Round robin",
} as const;

// Providers known to not reliably support plain HTTP/S proxying — routing
// for these defaults to bypassProxy on the backend. Dashboard copy of the
// backend `DEFAULT_PROXY_BYPASS_PROVIDER_IDS` (`src/providers/provider-metadata.ts`).
// Intentionally duplicated, not imported: importing the backend value would
// bundle the backend module graph (Elysia + `node:crypto`) into the browser
// build and break Vite dev with "Module node:crypto has been externalized".
// Same precedent as the dashboard `isRecord` copy in `lib/api.ts`.
// This set only decides whether the UI shows an explanatory tip; the backend
// constant is what actually enforces the default. Keep in sync.
export const PROXY_UNSUPPORTED_HINT_PROVIDERS: ReadonlySet<string> = new Set([
]);

export interface RoutingStrategyState {
  readonly strategy: RoutingStrategy;
  readonly roundRobinEnabled: boolean;
  readonly setRoundRobinEnabled: (next: boolean) => void;
  readonly rotateCount: number;
  readonly setRotateCount: (next: number) => void;
  readonly maxInflight: number | null;
  readonly bypassProxy: boolean;
  /** Text prepended to every request routed to this provider; `""` = none. */
  readonly systemPrompt: string;
  readonly setSystemPrompt: (next: string) => void;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly isSaving: boolean;
  readonly saveFailed: boolean;
  readonly refetch: () => void;
  readonly setMaxInflight: (next: number | null) => void;
  readonly setBypassProxy: (next: boolean) => void;
}

export function useRoutingStrategy(providerId: string): RoutingStrategyState {
  const query = useProviderRouting(providerId);
  const mutation = useUpdateProviderRouting();
  const [strategy, setStrategyState] = useState<RoutingStrategy>("fallback");
  const [rotateCount, setRotateCountState] = useState(1);
  const [maxInflight, setMaxInflightState] = useState<number | null>(null);
  const [bypassProxy, setBypassProxyState] = useState(false);
  const [systemPrompt, setSystemPromptState] = useState("");

  useEffect(() => {
    if (!query.data) return;
    setStrategyState(query.data.strategy);
    setRotateCountState(query.data.rotateCount);
    setMaxInflightState(query.data.maxInflight);
    setBypassProxyState(query.data.bypassProxy);
    setSystemPromptState(query.data.systemPrompt ?? "");
  }, [query.data]);

  const save = (next: {
    strategy: RoutingStrategy;
    rotateCount: number;
    maxInflight: number | null;
    bypassProxy: boolean;
    systemPrompt?: string;
  }) => {
    mutation.mutate(
      {
        providerId,
        request: {
          enabled: true,
          strategy: next.strategy,
          rotateCount: next.rotateCount,
          maxInflight: next.maxInflight,
          bypassProxy: next.bypassProxy,
          // Absent means "leave the stored prompt alone": every other caller of
          // `save` is editing an unrelated field, and sending the local prompt
          // from those paths would overwrite a concurrent edit.
          ...(next.systemPrompt === undefined ? {} : { systemPrompt: next.systemPrompt }),
        },
      },
      {
        onError: () => {
          if (!query.data) return;
          setStrategyState(query.data.strategy);
          setRotateCountState(query.data.rotateCount);
          setBypassProxyState(query.data.bypassProxy);
          setSystemPromptState(query.data.systemPrompt ?? "");
        },
      },
    );
  };
  const scheduleMaxInflightSave = useDebouncedSave((next: number | null) =>
    save({ strategy, rotateCount, maxInflight: next, bypassProxy }),
  );
  const scheduleRotateCountSave = useDebouncedSave((next: number) =>
    save({ strategy, rotateCount: next, maxInflight, bypassProxy }),
  );
  // Debounced like the other typed fields: the prompt is free text, so a save
  // per keystroke would write a half-typed sentence on every character.
  const scheduleSystemPromptSave = useDebouncedSave((next: string) =>
    save({ strategy, rotateCount, maxInflight, bypassProxy, systemPrompt: next }),
  );

  return {
    strategy,
    maxInflight,
    bypassProxy,
    systemPrompt,
    setSystemPrompt: (next) => {
      setSystemPromptState(next);
      scheduleSystemPromptSave(next);
    },
    isLoading: query.isPending,
    isError: query.isError,
    isSaving: mutation.isPending,
    saveFailed: mutation.isError,
    refetch: () => query.refetch(),
    setMaxInflight: (next) => {
      setMaxInflightState(next);
      scheduleMaxInflightSave(next);
    },
    setBypassProxy: (next) => {
      setBypassProxyState(next);
      save({ strategy, rotateCount, maxInflight, bypassProxy: next });
    },
    roundRobinEnabled: strategy === "round_robin",
    setRoundRobinEnabled: (next) => {
      const resolved: RoutingStrategy = next ? "round_robin" : "fallback";
      setStrategyState(resolved);
      save({ strategy: resolved, rotateCount, maxInflight, bypassProxy });
    },
    rotateCount,
    setRotateCount: (next) => {
      setRotateCountState(next);
      scheduleRotateCountSave(next);
    },
  };
}
