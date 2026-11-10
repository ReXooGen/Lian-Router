import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuotaEntry } from "../lib/hooks/quota";

// One page of cards is the whole point of this suite: 60 accounts must not
// become 60 cards in the document.
const accounts: QuotaEntry[] = Array.from({ length: 60 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  return {
    id: `acct-${number}`,
    provider: "cb",
    name: `Account ${number}`,
    credentialHint: "oauth",
    active: true,
    quota: null,
    pending: false,
    health: null,
    providerName: "CodeBuddy",
    providerIcon: "cb",
  };
});

const noop = (): undefined => undefined;

mock.module("../lib/hooks/quota", () => ({
  useQuotaOverview: () => ({
    data: { providers: [{ id: "cb", name: "CodeBuddy" }], accounts },
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
    dataUpdatedAt: 0,
    refetch: noop,
  }),
  useRefreshAccountQuota: () => ({ isPending: false, error: null, mutate: noop }),
  useRefreshAllQuotas: () => ({ isPending: false, mutate: noop }),
  useTriggerGrowthPass: () => ({ isPending: false, mutate: noop }),
  useBulkAccountCheckin: () => ({ isPending: false, mutate: noop }),
  useTriggerAccountReset: () => ({ isPending: false, mutate: noop }),
  useAccountResets: () => ({
    data: { availableCount: 0 },
    isPending: false,
    isError: false,
    refetch: noop,
  }),
  useUpdateAccountActive: () => ({ mutateAsync: async () => undefined }),
  useSetAccountsActiveBatch: () => ({ mutateAsync: async () => undefined }),
  useDeleteQuotaAccount: () => ({ mutateAsync: async () => undefined }),
  supportsAccountCheckin: (providerId: string) =>
    ["cb", "cbcn", "workbuddy"].includes(providerId.toLowerCase()),
  supportsAccountReset: () => false,
}));

// The mock must register before the route module resolves its hooks.
const { QUOTA_PAGE_SIZE, QuotaAccountGrid, quotaAccountMatchesFilter } = await import("./Quota");

// Each card's refresh button is named after its account, so counting those
// names counts rendered cards rather than looking at component internals.
function cardCount(markup: string): number {
  return (markup.match(/aria-label="Refresh Account \d+ quota"/g) ?? []).length;
}

function renderPage(page: number): string {
  return renderToStaticMarkup(
    createElement(QuotaAccountGrid, {
      accounts,
      page,
      onPageChange: noop,
      onToggle: (_account: QuotaEntry, _active: boolean) => undefined,
      onDelete: (_account: QuotaEntry) => undefined,
      onShowHealth: (_account: QuotaEntry) => undefined,
      onShowResets: (_account: QuotaEntry) => undefined,
    }),
  );
}

describe("quota account check-in actions", () => {
  test("the card names the account's billing facade", () => {
    const mixed: QuotaEntry[] = [
      { ...accounts[0]!, id: "acct-cb", name: "Account CB", provider: "cb", providerName: "CodeBuddy" },
      {
        ...accounts[0]!,
        id: "acct-cbcn",
        name: "Account CN",
        provider: "cbcn",
        providerName: "CodeBuddy CN",
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(QuotaAccountGrid, {
        accounts: mixed,
        page: 1,
        onPageChange: noop,
        onToggle: (_account: QuotaEntry, _active: boolean) => undefined,
        onDelete: (_account: QuotaEntry) => undefined,
        onShowHealth: (_account: QuotaEntry) => undefined,
        onShowResets: (_account: QuotaEntry) => undefined,
      }),
    );

    // The per-card check-in pill is gone; the provider badge is what keeps two
    // same-looking accounts on one grid distinguishable.
    expect(markup).toContain('title="Billing facade: CodeBuddy (cb)"');
    expect(markup).toContain('title="Billing facade: CodeBuddy CN (cbcn)"');
  });
});

describe("quota account grid pagination", () => {
  test("renders only the first page of a 60-account list", () => {
    const markup = renderPage(1);

    expect(QUOTA_PAGE_SIZE).toBe(24);
    expect(cardCount(markup)).toBe(24);
    expect(markup).toContain("Page 1 of 3");
    expect(markup).toContain("Refresh Account 01 quota");
    expect(markup).toContain("Refresh Account 24 quota");
    expect(markup).not.toContain("Refresh Account 25 quota");
  });

  test("the next page advances to the following window of accounts", () => {
    const markup = renderPage(2);

    expect(cardCount(markup)).toBe(24);
    expect(markup).toContain("Page 2 of 3");
    expect(markup).toContain("Refresh Account 25 quota");
    expect(markup).toContain("Refresh Account 48 quota");
    expect(markup).not.toContain("Refresh Account 24 quota");
    expect(markup).not.toContain("Refresh Account 49 quota");
  });

  test("the last page stops at the end of the filtered list", () => {
    const markup = renderPage(3);

    expect(cardCount(markup)).toBe(12);
    expect(markup).toContain("Page 3 of 3");
    expect(markup).toContain("Refresh Account 60 quota");
  });

  test("a page past the end clamps back to the last page", () => {
    const markup = renderPage(99);

    expect(cardCount(markup)).toBe(12);
    expect(markup).toContain("Page 3 of 3");
  });
});

describe("quota account grid plan split", () => {
  /**
   * An account holding two plans carries both sets of grants in one window
   * list. Rendering them under one heading made a referral grant and a paid
   * plan read as one pool; the split is what tells the operator which plan a
   * percentage came from.
   */
  test("heads each plan's grants when one account holds more than one", () => {
    const twoPlans: QuotaEntry[] = [
      {
        ...accounts[0]!,
        id: "acct-two-plans",
        name: "Two plans",
        quota: {
          source: "zcode",
          status: "ready",
          plan: "ZCode Start Plan",
          exhausted: false,
          windows: [
            { kind: "grant", label: "GLM-5.3", usedPercent: 0, remainingPercent: 100, resetsAt: null, group: "ZCode Start Plan" },
            { kind: "grant", label: "GLM-5.3-Flash", usedPercent: 99, remainingPercent: 1, resetsAt: null, group: "ZCode Start Plan" },
            { kind: "grant", label: "GLM-5.3-Flash Promo", usedPercent: null, remainingPercent: null, resetsAt: null, group: "ZCode Referral Global" },
          ],
          fetchedAt: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          error: null,
        },
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(QuotaAccountGrid, {
        accounts: twoPlans,
        page: 1,
        onPageChange: noop,
        onToggle: (_account: QuotaEntry, _active: boolean) => undefined,
        onDelete: (_account: QuotaEntry) => undefined,
        onShowHealth: (_account: QuotaEntry) => undefined,
        onShowResets: (_account: QuotaEntry) => undefined,
      }),
    );
    expect(markup).toContain("ZCode Start Plan");
    expect(markup).toContain("ZCode Referral Global");
    expect(markup).not.toContain("ZCode Start Plan + ZCode Referral Global");
  });

  test("draws no plan heading when the account holds one plan", () => {
    const onePlan: QuotaEntry[] = [
      {
        ...accounts[0]!,
        id: "acct-one-plan",
        name: "One plan",
        quota: {
          source: "zcode",
          status: "ready",
          plan: "ZCode Start Plan",
          windows: [
            { kind: "grant", label: "GLM-5.3", usedPercent: 0, remainingPercent: 100, resetsAt: null, group: "ZCode Start Plan" },
          ],
          fetchedAt: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          error: null,
        },
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(QuotaAccountGrid, {
        accounts: onePlan,
        page: 1,
        onPageChange: noop,
        onToggle: (_account: QuotaEntry, _active: boolean) => undefined,
        onDelete: (_account: QuotaEntry) => undefined,
        onShowHealth: (_account: QuotaEntry) => undefined,
        onShowResets: (_account: QuotaEntry) => undefined,
      }),
    );
    // One plan is already named by the card badge; a second copy would just be
    // noise above the bar.
    expect((markup.match(/ZCode Start Plan/g) ?? []).length).toBe(1);
  });
});

describe("quota account grid pending grants", () => {
  /**
   * A granted-but-not-yet-live campaign has no usage, so the bar is an empty
   * line under a bare "limit 300,000,000". Reporting the scheduled instant is
   * the only statement that is true: the units exist, and the vendor will not
   * spend them yet.
   */
  test("names the schedule for a pending grant instead of drawing an empty bar", () => {
    const pending: QuotaEntry[] = [
      {
        ...accounts[0]!,
        id: "acct-pending",
        name: "Pending grant",
        quota: {
          source: "zcode",
          status: "ready",
          plan: "ZCODE GLOBAL BUILD",
          windows: [
            {
              kind: "grant",
              label: "GLM-5.3-Flash · glm-5.3-flash",
              usedPercent: null,
              remainingPercent: null,
              resetsAt: null,
              used: null,
              limit: 300_000_000,
              group: "ZCODE GLOBAL BUILD",
              availableAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
            },
          ],
          fetchedAt: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          error: null,
        },
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(QuotaAccountGrid, {
        accounts: pending,
        page: 1,
        onPageChange: noop,
        onToggle: (_account: QuotaEntry, _active: boolean) => undefined,
        onDelete: (_account: QuotaEntry) => undefined,
        onShowHealth: (_account: QuotaEntry) => undefined,
        onShowResets: (_account: QuotaEntry) => undefined,
      }),
    );
    expect(markup).toContain("Pending");
    // The pending grant has no usage, so no percentage may be drawn for it: a
    // "0%" or "100%" would state a balance the vendor never reported.
    expect(markup).not.toMatch(/300,000,000[^<]*%|%\s*<\/span>\s*<\/div>\s*<div[^>]*inner-border/);
  });
});

describe("quota account filter", () => {
  const withWindows: QuotaEntry = {
    ...accounts[0]!,
    id: "acct-ready",
    quota: {
      source: "zcode",
      status: "ready",
      plan: "ZCode Start Plan",
      windows: [
        {
          kind: "grant",
          label: "GLM-5.3",
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: null,
          used: 0,
          limit: 1_000,
        },
      ],
      fetchedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      error: null,
    },
  };
  const refused: QuotaEntry = {
    ...accounts[0]!,
    id: "acct-refused",
    quota: {
      source: "zcode",
      status: "error",
      plan: null,
      windows: [],
      fetchedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      error: "Quota endpoint rejected request: rate limited (HTTP 429)",
    },
  };
  const neverRead: QuotaEntry = { ...accounts[0]!, id: "acct-none", quota: null };
  const spent: QuotaEntry = {
    ...accounts[0]!,
    id: "acct-spent",
    quota: {
      source: "zcode",
      status: "ready",
      plan: "ZCode Start Plan",
      exhausted: true,
      windows: [
        { kind: "grant", label: "GLM-5.3", usedPercent: 100, remainingPercent: 0, resetsAt: null },
        { kind: "grant", label: "GLM-5.3-Flash", usedPercent: 100, remainingPercent: 0, resetsAt: null },
      ],
      fetchedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      error: null,
    },
  };

  /**
   * The default filter is "With quota". A refused read has no windows, so
   * treating "no windows" as "no quota" hid exactly the accounts whose quota
   * endpoint was failing.
   */
  test("keeps a failed read visible under the default filter", () => {
    expect(quotaAccountMatchesFilter(withWindows, "all", "all")).toBe(true);
    expect(quotaAccountMatchesFilter(refused, "all", "all")).toBe(true);
    expect(quotaAccountMatchesFilter(neverRead, "all", "all")).toBe(false);
  });

  test("lists only truly untracked accounts under No quota", () => {
    expect(quotaAccountMatchesFilter(neverRead, "untracked", "all")).toBe(true);
    expect(quotaAccountMatchesFilter(refused, "untracked", "all")).toBe(false);
    expect(quotaAccountMatchesFilter(withWindows, "untracked", "all")).toBe(false);
  });

  /**
   * A spent plan holds nothing the operator can draw, so it leaves the default
   * list instead of sitting there looking like capacity. It stays reachable
   * under "Spent": hiding a fact is not deleting it, and an operator still
   * needs to find which accounts ran dry.
   */
  test("hides a spent account from the default list but keeps it under Spent", () => {
    expect(quotaAccountMatchesFilter(spent, "all", "all")).toBe(false);
    expect(quotaAccountMatchesFilter(spent, "spent", "all")).toBe(true);
    expect(quotaAccountMatchesFilter(withWindows, "spent", "all")).toBe(false);
    // Unknown balance is not spent: neither a refused read nor an account that
    // was never read may be hidden as if its grants were used up.
    expect(quotaAccountMatchesFilter(refused, "spent", "all")).toBe(false);
    expect(quotaAccountMatchesFilter(neverRead, "spent", "all")).toBe(false);
  });

  test("still filters by provider and by active state", () => {
    expect(quotaAccountMatchesFilter(refused, "all", "cbcn")).toBe(false);
    expect(quotaAccountMatchesFilter({ ...refused, active: false }, "active", "all")).toBe(false);
    expect(quotaAccountMatchesFilter({ ...refused, active: false }, "disabled", "all")).toBe(true);
  });
});
