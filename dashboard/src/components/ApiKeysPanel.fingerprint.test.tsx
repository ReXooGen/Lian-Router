import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiKeysPanel } from "./ApiKeysPanel";
import type { ApiKeyResponse } from "../lib/contracts";
import { queryKeys } from "../lib/query-keys";

/** Three rows that differ only in what the panel can use to identify them. */
const withFingerprint: ApiKeyResponse = {
  id: "11111111-1111-1111-1111-111111111111",
  label: "cli-client",
  keyMode: "personal",
  scopes: [],
  keyPrefix: "rk_",
  keyFingerprint: "rk_QVAxx…1Z9k",
  createdAt: "2026-09-01T00:00:00.000Z",
  secretRecoverable: true,
  tokensConsumed: 0,
};

const prefixOnly: ApiKeyResponse = {
  id: "22222222-2222-2222-2222-222222222222",
  label: "legacy-key",
  keyMode: "personal",
  scopes: [],
  keyPrefix: "rk_",
  createdAt: "2026-09-02T00:00:00.000Z",
  secretRecoverable: false,
  tokensConsumed: 0,
};

const noPrefix: ApiKeyResponse = {
  id: "abcdef1234567890",
  label: "pre-encryption-key",
  keyMode: "personal",
  scopes: [],
  createdAt: "2026-09-03T00:00:00.000Z",
  secretRecoverable: false,
  tokensConsumed: 0,
};

function render(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.apiKeys.all, [withFingerprint, prefixOnly, noPrefix]);
  client.setQueryData(queryKeys.network.pools, []);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ApiKeysPanel)),
  );
}

describe("API key row identity", () => {
  test("the row shows the fingerprint, then the prefix, then the id", () => {
    const markup = render();

    // A: the fingerprint of the key's own secret wins over the shared prefix.
    expect(markup).toContain("rk_QVAxx…1Z9k");
    // B: no fingerprint, so the configured prefix is all there is.
    expect(markup).toContain("rk_…");
    expect(markup).not.toContain("22222222-222");
    // C: neither, so the id is the honest fallback.
    expect(markup).toContain("abcdef123456…");
  });

  test("a fingerprint and a prefix-only row do not render the same identity", () => {
    const markup = render();
    // The regression that caused the incident: every rk_ row reading "rk_…".
    expect(markup).toContain("rk_QVAxx…1Z9k");
    expect(markup).toContain("rk_…");
    expect(markup.match(/rk_QVAxx…1Z9k/g)?.length).toBe(1);
  });
});
