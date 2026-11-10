import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jsonResponse } from "../../lib/test-helpers";
import { useProbeModel } from "../../lib/hooks/providers";
import type { ProbeModelResult, ProviderAccountResponse } from "../../lib/contracts";
import { accountProbeRequest } from "../account-probe-model";
import { AccountProbePanel } from "./AccountProbeDialog";
import { AccountsList } from "./Accounts";

const noop = (): undefined => undefined;

const account: ProviderAccountResponse = {
  id: "acct-row-7",
  providerId: "openai",
  tenantId: "tenant-1",
  label: "primary",
  credentialKind: "api_key",
  status: "active",
  maxInflight: null,
  networkPoolId: null,
  bypassProxy: false,
  usageToday: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  usageAllTime: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
};

function renderWithClient(element: ReactElement): string {
  const client = new QueryClient();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, element),
  );
}

/** The full opening tag of the button whose visible text ends with `text`. */
function buttonTag(markup: string, text: string): string {
  const closing = `${text}</button>`;
  const end = markup.indexOf(closing);
  if (end === -1) throw new Error(`button "${text}" not found`);
  const start = markup.lastIndexOf("<button", end);
  return markup.slice(start, end + closing.length);
}

function renderPanel(overrides: {
  models: ReadonlyArray<{ modelId: string; enabled: boolean }>;
  modelsLoading?: boolean;
  pending?: boolean;
  result?: ProbeModelResult;
  error?: string;
}): string {
  return renderToStaticMarkup(
    createElement(AccountProbePanel, {
      models: overrides.models,
      modelsLoading: overrides.modelsLoading ?? false,
      pending: overrides.pending ?? false,
      result: overrides.result,
      error: overrides.error,
      onProbe: noop,
      onClose: noop,
    }),
  );
}

describe("per-account probe action", () => {
  test("each row exposes a Probe action named for its account", () => {
    const markup = renderWithClient(
      createElement(AccountsList, {
        providerId: "openai",
        accounts: [account],
        onDelete: noop,
      }),
    );

    expect(markup).toContain('aria-label="Probe primary"');
  });

  test("the probe request pins exactly one accountId, the row's account", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({ ok: true, latencyMs: 12, accountId: account.id });
    }) as typeof fetch;

    try {
      let mutate: ((variables: unknown) => Promise<unknown>) | undefined;
      function Capture(): null {
        const probe = useProbeModel();
        mutate = probe.mutateAsync as unknown as (variables: unknown) => Promise<unknown>;
        return null;
      }
      renderWithClient(createElement(Capture));
      if (!mutate) throw new Error("probe mutation was not captured");

      const request = accountProbeRequest("gpt-4o", account.id);
      expect(Object.keys(request).sort()).toEqual(["accountId", "modelId"]);
      expect(request.accountId).toBe(account.id);

      await mutate({ providerId: "openai", request });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toContain("/providers/openai/models/probe");
      const body = requests[0]?.body as Record<string, unknown>;
      expect(body).toEqual({ modelId: "gpt-4o", accountId: account.id });
      expect(Object.keys(body).filter((key) => key === "accountId")).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the model select defaults to the first enabled model and skips disabled ones", () => {
    const markup = renderPanel({
      models: [
        { modelId: "retired-model", enabled: false },
        { modelId: "current-model", enabled: true },
        { modelId: "second-model", enabled: true },
      ],
    });

    expect(markup).toContain(">current-model</span>");
    expect(markup).not.toContain("retired-model");
    expect(buttonTag(markup, "Probe")).not.toContain("disabled");
  });

  test("a failed result renders the error and status code", () => {
    const markup = renderPanel({
      models: [{ modelId: "gpt-4o", enabled: true }],
      result: {
        ok: false,
        latencyMs: 240,
        statusCode: 429,
        httpStatus: 429,
        error: "upstream rate limited",
      },
    });

    expect(markup).toContain("upstream rate limited");
    expect(markup).toContain("HTTP 429");
    expect(markup).toContain("badge-err");
  });

  test("a successful result renders latency, TTFB, and the sample", () => {
    const markup = renderPanel({
      models: [{ modelId: "gpt-4o", enabled: true }],
      result: {
        ok: true,
        latencyMs: 180,
        httpStatus: 200,
        ttfbMs: 95,
        sample: "pong",
      },
    });

    expect(markup).toContain("180 ms");
    expect(markup).toContain("TTFB 95 ms");
    expect(markup).toContain("pong");
    expect(markup).toContain("badge-ok");
  });

  test("with no enabled models the Probe button is disabled with a reason", () => {
    const markup = renderPanel({
      models: [{ modelId: "retired-model", enabled: false }],
    });

    expect(markup).toContain("No enabled model on this provider");
    expect(buttonTag(markup, "Probe")).toContain("disabled");
  });
});
