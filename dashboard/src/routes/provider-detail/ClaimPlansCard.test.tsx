import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountQuotaResponse } from "../../lib/hooks/quota";
import { queryKeys } from "../../lib/query-keys";
import { ClaimPlansCard } from "./ClaimPlansCard";

const ACCOUNT_ID = "acct-zcode-1";
const ACCOUNT = [{ id: ACCOUNT_ID, label: "sutsujin", status: "active" }];

function renderWithQuota(quota: AccountQuotaResponse["quota"]): string {
  const client = new QueryClient();
  // Seed the cache so the synchronous render observes the quota answer: a
  // static render never awaits a query, which is why the row is asserted from
  // pre-seeded data rather than from a live fetch.
  client.setQueryData<AccountQuotaResponse>(queryKeys.quota.account(ACCOUNT_ID), {
    accountId: ACCOUNT_ID,
    quota,
    health: null,
  });
  client.setQueryData(queryKeys.providers.claims(ACCOUNT_ID), {
    plans: [],
    errors: [],
    supported: true,
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ClaimPlansCard, { providerId: "zcode", accounts: ACCOUNT }),
    ),
  );
}

const QUOTA = {
  source: "zcode",
  status: "ready" as const,
  // The summary names one plan; the second plan reaches the card through each
  // window's group, which is what keeps "Start Plan" and "Referral Global"
  // apart instead of reading as one plan called "A + B".
  plan: "ZCode Start Plan",
  windows: [
    {
      kind: "grant",
      label: "GLM-5.3",
      remainingPercent: 100,
      usedPercent: 0,
      resetsAt: null,
      group: "ZCode Start Plan",
    },
    {
      kind: "grant",
      label: "GLM-5.3-Flash",
      remainingPercent: 99.4,
      usedPercent: 0.6,
      resetsAt: null,
      group: "ZCode Referral Global",
    },
  ],
  fetchedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  error: null,
};

/**
 * "No claimable campaign" is a statement about campaigns, not about the
 * account: an account can hold live grants and have nothing to claim. The card
 * used to render only the campaign state, so an operator holding three grants
 * had no way to tell it from an empty login.
 */
describe("claim card plan summary", () => {
  test("shows each granted plan as its own block next to the campaign state", () => {
    const markup = renderWithQuota(QUOTA);
    expect(markup).toContain("Plan granted");
    // Two plans, two blocks: neither the joined label nor a single merged list.
    expect(markup).toContain("ZCode Start Plan");
    expect(markup).toContain("ZCode Referral Global");
    expect(markup).not.toContain("ZCode Start Plan + ZCode Referral Global");
    expect(markup.match(/Plan granted/g) ?? []).toHaveLength(2);
    expect(markup).toContain("GLM-5.3");
    expect(markup).toContain("99% left");
    // The campaign answer is still shown: both facts belong on the card.
    expect(markup).toContain("No claimable campaign");
  });

  test("omits the plan block when the account holds no grant", () => {
    const markup = renderWithQuota({ ...QUOTA, plan: null, windows: [] });
    expect(markup).not.toContain("Plan granted");
    expect(markup).toContain("No claimable campaign");
  });

  /**
   * A spent plan is still reported by the vendor, but it grants nothing. The
   * card must not advertise it as a held plan; an operator reading "Plan
   * granted" would reasonably expect capacity they can draw.
   */
  /**
   * The claim card shows what an account holds. A campaign whose units are
   * granted but scheduled must say so: "Plan granted" alone invites the operator
   * to expect working capacity that the vendor will refuse.
   */
  test("marks a granted-but-scheduled plan as pending", () => {
    const markup = renderWithQuota({
      ...QUOTA,
      plan: "ZCODE GLOBAL BUILD",
      windows: [
        {
          kind: "grant",
          label: "GLM-5.3-Flash · glm-5.3-flash",
          usedPercent: null,
          remainingPercent: null,
          resetsAt: null,
          limit: 300_000_000,
          group: "ZCODE GLOBAL BUILD",
          availableAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
        },
      ],
    });
    expect(markup).toContain("ZCODE GLOBAL BUILD");
    expect(markup).toContain("Pending");
  });

  test("hides a plan whose grants are all spent", () => {
    const markup = renderWithQuota({
      ...QUOTA,
      exhausted: true,
      windows: [
        { kind: "grant", label: "GLM-5.3", remainingPercent: 0, usedPercent: 100, resetsAt: null, group: "ZCode Start Plan" },
      ],
    });
    expect(markup).not.toContain("Plan granted");
    expect(markup).not.toContain("ZCode Start Plan");
    expect(markup).toContain("No claimable campaign");
  });
});
