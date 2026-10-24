import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiKeysPanel } from "./ApiKeysPanel";
import { queryKeys } from "../lib/query-keys";
import type { ApiKeyResponse, NetworkPoolResponse, SessionUser } from "../lib/contracts";

const ACTIVE_KEY: ApiKeyResponse = {
  id: "key-active-0001",
  keyMode: "personal",
  label: "ci-key",
  scopes: ["dashboard:read"],
  keyPrefix: "ctk_",
  requestsPerMinute: 120,
  dailyTokenLimit: 1_000_000,
  monthlyTokenLimit: 10_000_000,
  maxConcurrentRequests: 4,
  modelAllowlist: ["openai/gpt-5", "anthropic/claude-x"],
  createdAt: "2026-01-02T00:00:00.000Z",
  secretRecoverable: true,
  tokensConsumed: 2_500_000,
};

const REVOKED_KEY: ApiKeyResponse = {
  id: "key-revoked-0002",
  keyMode: "personal",
  label: "old-key",
  scopes: ["dashboard:read"],
  keyPrefix: "rk_",
  createdAt: "2025-12-01T00:00:00.000Z",
  revokedAt: "2026-01-05T00:00:00.000Z",
  secretRecoverable: true,
  tokensConsumed: 10,
};
const SHARE_TEMPLATE: ApiKeyResponse = {
  id: "key-share-0003",
  keyMode: "share",
  label: "team-share",
  scopes: ["routing:invoke"],
  keyPrefix: "rk_",
  createdAt: "2026-01-03T00:00:00.000Z",
  secretRecoverable: false,
  tokensConsumed: 0,
};

const SESSION: SessionUser = {
  id: "user-1",
  username: "admin",
  email: "admin@example.test",
  displayName: "Admin",
  isFirstBoot: false,
  sessionExpiresAt: "2026-08-31T00:00:00.000Z",
  isPlatformAdmin: true,
};

function render(
  keys: readonly ApiKeyResponse[] | undefined,
  pools?: readonly NetworkPoolResponse[],
  session?: SessionUser,
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (keys) queryClient.setQueryData(queryKeys.apiKeys.all, keys);
  if (pools) queryClient.setQueryData(queryKeys.network.pools, pools);
  if (session) queryClient.setQueryData(queryKeys.session.current, session);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(ApiKeysPanel)),
  );
}

describe("API keys panel", () => {
  test("renders key rows with status, prefix and limits", () => {
    const markup = render([ACTIVE_KEY, REVOKED_KEY]);
    expect(markup).toContain("API Credentials");
    expect(markup).toContain("ci-key");
    expect(markup).toContain("old-key");
    expect(markup).toContain(">active<");
    expect(markup).toContain(">revoked<");
    expect(markup).toContain("ctk_…");
    expect(markup).toContain("Edit");
    expect(markup).not.toContain("Create enrollment link");
    expect(markup).toContain("Revoke");
  });

  test("only share templates can create enrollment links", () => {
    const markup = render([SHARE_TEMPLATE]);
    expect(markup).toContain("share template");
    expect(markup).toContain("Create enrollment link");
  });

  test("never renders a secret or key hash", () => {
    const markup = render([ACTIVE_KEY]);
    expect(markup).not.toContain("keyHash");
    expect(markup).not.toContain("key_hash");
    expect(markup).not.toContain("keyEncrypted");
  });

  test("summarises totals across keys", () => {
    const markup = render([ACTIVE_KEY, REVOKED_KEY]);
    expect(markup).toContain("Active keys");
    expect(markup).toContain("Total usage");
    expect(markup).toContain("1 / 2");
  });

  test("shows each key's effective egress, resolved against the pool list", () => {
    const pool: NetworkPoolResponse = {
      id: "pool-eu-1",
      kind: "http",
      label: "EU egress",
      endpoint: "http://eu.proxy.example.com:8080",
      maxInflight: 8,
      weight: 100,
      status: "active",
      inflight: 0,
      consecutiveFailures: 0,
      tenantId: "tenant-1",
    };
    const markup = render(
      [
        { ...ACTIVE_KEY, networkPoolId: pool.id },
        REVOKED_KEY,
        // A binding whose pool was deleted still names something, rather than
        // rendering as if the key had no binding at all.
        { ...SHARE_TEMPLATE, networkPoolId: "pool-deleted" },
      ],
      [pool],
    );
    expect(markup).toContain("EU egress");
    // The unbound key reads as default routing, not as a missing value.
    expect(markup).toContain("Default");
    expect(markup).toContain("pool-del…");
  });

  test("renders the empty state when no keys exist", () => {
    const markup = render([]);
    expect(markup).toContain("No API keys issued");
    expect(markup).toContain("Create Key");
  });

  test("offers the blocked-client list only to a platform admin", () => {
    // A model-abuse block is keyed on the client address, so it is
    // cross-tenant. The server refuses a tenant operator; the entry point is
    // hidden so they never walk into that 403.
    expect(render([ACTIVE_KEY], undefined, SESSION)).toContain("Blocked Clients");
    expect(render([ACTIVE_KEY], undefined, { ...SESSION, isPlatformAdmin: false })).not.toContain(
      "Blocked Clients",
    );
  });

  test("renders a loading state before the key list resolves", () => {
    const markup = render(undefined);
    expect(markup).toContain("Loading API keys");
  });
});
