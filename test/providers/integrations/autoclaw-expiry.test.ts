import { describe, expect, test } from "bun:test";
import {
  fetchAutoClawExpirySummary,
  fetchAutoClawLedger,
} from "../../../src/providers/integrations/autoclaw/autoclaw-credits";

/** Fixed "now": 2026-11-23T00:00:00Z. */
const NOW = 1_795_392_000_000;
const day = (offset: number) => Math.floor(NOW / 1000) + offset * 86_400;

function entry(partial: {
  id: string;
  amount: number;
  occurredAt: string;
  walletExpiresAt: number | null;
}): Record<string, unknown> {
  // The vendor's envelope is snake_case; the parser reads exactly these keys.
  return {
    id: partial.id,
    amount: partial.amount,
    description: "Daily Check In",
    occurred_at: partial.occurredAt,
    mutation_type: partial.amount < 0 ? "debit" : "credit",
    wallet_scope: "annual",
    wallet_expires_at: partial.walletExpiresAt,
  };
}

function ledgerFetcher(pages: readonly Record<string, unknown>[][]) {
  let page = 0;
  return (async (input: unknown) => {
    const url = String(input);
    if (!url.includes("ledgers_std")) throw new Error("unexpected fetch: " + url);
    const entries = pages[page] ?? [];
    page += 1;
    return new Response(
      JSON.stringify({
        code: 0,
        data: { entries, next_page_token: page < pages.length ? `cursor-${page}` : null },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

describe("fetchAutoClawLedger", () => {
  test("parses wallet_expires_at from the envelope", async () => {
    const fetcher = ledgerFetcher([
      [entry({ id: "1", amount: 400, occurredAt: "2026-11-23T03:10:24.308+08:00", walletExpiresAt: day(6) })],
    ]);
    const page = await fetchAutoClawLedger("tok", { pageSize: 10 }, fetcher);
    expect(page.entries[0]?.walletExpiresAt).toBe(day(6));
  });
});

describe("fetchAutoClawExpirySummary", () => {
  test("buckets expired grants by expiry day and nets the debits out", async () => {
    const fetcher = ledgerFetcher([
      [
        // Expired 4 days ago: grant minus a partial spend.
        entry({ id: "e1", amount: 400, occurredAt: "2026-11-17T00:00:00Z", walletExpiresAt: day(-4) }),
        entry({ id: "e2", amount: -100, occurredAt: "2026-11-18T00:00:00Z", walletExpiresAt: day(-4) }),
        // A different expiry day, also expired.
        entry({ id: "e3", amount: 250, occurredAt: "2026-11-10T00:00:00Z", walletExpiresAt: day(-2) }),
        // Expiring in 3 days: still live, inside the 7-day window.
        entry({ id: "e4", amount: 400, occurredAt: "2026-11-21T00:00:00Z", walletExpiresAt: day(3) }),
        // Far runway: outside the window entirely.
        entry({ id: "e5", amount: 900, occurredAt: "2026-11-22T00:00:00Z", walletExpiresAt: day(40) }),
        // No expiry field on the envelope: excluded rather than guessed.
        entry({ id: "e6", amount: 77, occurredAt: "2026-11-22T00:00:00Z", walletExpiresAt: null }),
      ],
    ]);
    const summary = await fetchAutoClawExpirySummary("tok", fetcher, { withinDays: 7 }, );

    // Netted: 400 - 100 = 300 lapsed on day(-4); 250 on day(-2).
    expect(summary.expiredPoints).toBe(550);
    expect(summary.expired.map((b) => b.expiresOn)).toEqual([
      new Date(day(-2) * 1000).toISOString().slice(0, 10),
      new Date(day(-4) * 1000).toISOString().slice(0, 10),
    ]);
    expect(summary.expiringSoonPoints).toBe(400);
    // The far-runway grant and the expiry-less one never enter a bucket.
    expect(summary.expiringSoon[0]?.entries.every((e) => e.id !== "e5" && e.id !== "e6")).toBe(true);
  });

  test("a wallet fully spent before lapsing is not reported as expired", async () => {
    const fetcher = ledgerFetcher([
      [
        entry({ id: "g1", amount: 400, occurredAt: "2026-11-17T00:00:00Z", walletExpiresAt: day(-3) }),
        entry({ id: "s1", amount: -400, occurredAt: "2026-11-19T00:00:00Z", walletExpiresAt: day(-3) }),
      ],
    ]);
    const summary = await fetchAutoClawExpirySummary("tok", fetcher);
    expect(summary.expiredPoints).toBe(0);
    expect(summary.expired).toEqual([]);
  });

  test("paging stops once the ledger is older than the lookback window", async () => {
    let fetches = 0;
    const fetcher = (async () => {
      fetches += 1;
      const page = fetches - 1;
      const occurred = new Date(NOW - (page * 40 + 10) * 86_400_000).toISOString();
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            entries: [entry({ id: `p${page}`, amount: 100, occurredAt: occurred, walletExpiresAt: day(30) })],
            next_page_token: `cursor-${page + 1}`,
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await fetchAutoClawExpirySummary("tok", fetcher, { lookbackDays: 45 });
    // Each page ages 40 days past the last: 45-day lookback stops after page 2.
    expect(fetches).toBeLessThanOrEqual(3);
  });
});
