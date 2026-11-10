import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useProbeModel } from "../lib/hooks/providers";
import { jsonResponse } from "../lib/test-helpers";
import { queryKeys } from "../lib/query-keys";
import type {
  ModelCatalogEntry,
  ProviderAccountResponse,
  ProviderResponse,
} from "../lib/contracts";
import AccountProbeAll from "./AccountProbeAll";

const provider: ProviderResponse = {
  providerId: "openai",
  label: "OpenAI",
  enabled: true,
  isBuiltIn: true,
  requiresAccount: true,
  supportsModelDiscovery: true,
};

const account = (id: string, label: string): ProviderAccountResponse => ({
  id,
  providerId: "openai",
  tenantId: "tenant-1",
  label,
  credentialKind: "api_key",
  status: "active",
  maxInflight: null,
  networkPoolId: null,
  bypassProxy: false,
  usageToday: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  usageAllTime: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
});

const model: ModelCatalogEntry = {
  modelId: "gpt-5",
  route: "/v1/chat/completions",
  provider: "openai",
  wireFamily: "chat",
  enabled: true,
  contextLimit: 400_000,
  outputLimit: 128_000,
  reasoning: true,
  toolCall: true,
  vision: true,
  document: true,
  audio: false,
  mediaGeneration: false,
  webSearch: false,
  cost: null,
  source: "builtin",
  sourceUpdatedAt: null,
};

function renderPage(accounts: readonly ProviderAccountResponse[]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.providers.all, [provider]);
  client.setQueryData(queryKeys.providers.accounts("openai"), accounts);
  client.setQueryData(queryKeys.providers.models("openai"), [model]);
  const element: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      MemoryRouter,
      { initialEntries: ["/providers/openai/accounts/test"] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/providers/:providerId/accounts/test",
          element: createElement(AccountProbeAll),
        }),
      ),
    ),
  );
  return renderToStaticMarkup(element);
}

describe("probe-all page", () => {
  test("renders the provider header, model picker, counters, and account rows", () => {
    const markup = renderPage([account("acct-1", "primary"), account("acct-2", "backup")]);

    expect(markup).toContain("Back to OpenAI");
    expect(markup).toContain('href="/providers/openai"');
    expect(markup).toContain("Probe every account · 2 accounts");
    expect(markup).toContain("gpt-5");
    expect(markup).toContain("Test All Accounts");
    expect(markup).toContain("Remaining");
    expect(markup).toContain("primary");
    expect(markup).toContain("backup");
    expect(markup).toContain("Pending");
    // Stop only exists while a run is in flight.
    expect(markup).not.toContain(">Stop<");
  });

  test("renders the empty state when the provider has no accounts", () => {
    const markup = renderPage([]);

    expect(markup).toContain("No accounts connected");
    expect(markup).toContain(
      "Add an API key or OAuth credential before probing this provider.",
    );
  });
});

describe("probe settlement", () => {
  test("a probe settles without waiting for the account-list refetch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.providers.accounts("cb"), []);
    let markRefetchStarted: () => void = () => {};
    const refetchStarted = new Promise<void>((resolve) => {
      markRefetchStarted = resolve;
    });
    let releaseRefetch: () => void = () => {};
    const refetchGate = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    // Stands in for the 2,214-account GET the probe's onSettled invalidates.
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.providers.accounts("cb"),
      queryFn: async () => {
        markRefetchStarted();
        await refetchGate;
        return [];
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribe = observer.subscribe(() => {});

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/models/probe"))
        return jsonResponse({ ok: true, latencyMs: 4, accountId: "acct-1" });
      return jsonResponse([]);
    }) as typeof fetch;

    try {
      let mutateAsync: ((variables: unknown) => Promise<unknown>) | undefined;
      function Capture(): null {
        const probe = useProbeModel();
        mutateAsync = probe.mutateAsync as unknown as (variables: unknown) => Promise<unknown>;
        return null;
      }
      renderToStaticMarkup(
        createElement(QueryClientProvider, { client }, createElement(Capture)),
      );
      if (!mutateAsync) throw new Error("probe mutation was not captured");

      let probeSettled = false;
      const pending = mutateAsync({
        providerId: "cb",
        request: { modelId: "model-1", accountId: "acct-1" },
      });
      void pending.then(
        () => {
          probeSettled = true;
        },
        () => {
          probeSettled = true;
        },
      );

      await refetchStarted;
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(probeSettled).toBe(true);

      releaseRefetch();
      await pending;
    } finally {
      globalThis.fetch = originalFetch;
      unsubscribe();
    }
  });
});
