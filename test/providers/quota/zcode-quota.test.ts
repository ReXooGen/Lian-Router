import { describe, expect, test } from "bun:test";
import { fetchZcodeQuota } from "../../../src/providers/integrations/zcode/zcode-quota";
import { zcodeDeviceId } from "../../../src/providers/integrations/zcode/spec";
import { jsonResponse } from "../../helpers/sse-fixtures";

const BALANCE = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const CURRENT = "https://zcode.z.ai/api/v1/zcode-plan/billing/current";

/** One plan definition carrying two entitlements. */
const PLANS = [
  {
    name: "ZCode Start Plan",
    status: "active",
    entitlements: [
      {
        entitlement_id: "ent-flash",
        show_name: "GLM-5.3-Flash",
        capabilities: ["model:glm-5.3-flash"],
        grant_units: 5_000_000,
        unit_type: "tokens",
        period: "daily",
      },
      {
        entitlement_id: "ent-pro",
        show_name: "GLM-5.3",
        capabilities: ["model:glm-5.3"],
        grant_units: 1_000_000,
        unit_type: "tokens",
        period: "daily",
      },
    ],
  },
];

const BALANCES = [
  {
    entitlement_id: "ent-flash",
    show_name: "GLM-5.3-Flash",
    capabilities: ["model:glm-5.3-flash"],
    total_units: 5_000_000,
    used_units: 1_250_000,
    remaining_units: 3_750_000,
    period_start: 1_760_000_000,
    period_end: 1_760_086_400,
    unit_type: "tokens",
  },
];

function routedFetcher(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler();
    }
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof fetch;
}

describe("fetchZcodeQuota", () => {
  test("reads the panel balance and reports one window per entitlement", async () => {
    const result = await fetchZcodeQuota(
      "jwt-1",
      routedFetcher({
        [BALANCE]: () =>
          jsonResponse({ code: 0, data: { plans: PLANS, balances: BALANCES, server_time: 1_760_000_100 } }),
      }),
    );
    expect(result.plan).toBe("ZCode Start Plan");
    expect(result.error).toBeNull();
    // The flash entitlement has usage; the pro entitlement is defined but
    // untouched, and both must render.
    expect(result.windows).toHaveLength(2);
    const flash = result.windows.find((window) => window.label.includes("GLM-5.3-Flash"));
    expect(flash?.usedPercent).toBeCloseTo(25);
    expect(flash?.used).toBe(1_250_000);
    expect(flash?.limit).toBe(5_000_000);
    const pro = result.windows.find((window) => window.label.includes("GLM-5.3 ·"));
    expect(pro?.usedPercent).toBeNull();
    expect(pro?.limit).toBe(1_000_000);
  });

  test("sends the derived device mid on the balance read", async () => {
    let seen: Record<string, string> = {};
    await fetchZcodeQuota(
      "jwt-1",
      routedFetcher({
        [BALANCE]: () => jsonResponse({ code: 0, data: { plans: PLANS, balances: BALANCES } }),
      }),
    );
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      if (String(input).startsWith(BALANCE)) seen = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ code: 0, data: { plans: PLANS, balances: BALANCES } });
    }) as unknown as typeof fetch;
    await fetchZcodeQuota("jwt-1", fetcher);
    expect(seen["x-device-mid"]).toBe(zcodeDeviceId("jwt-1"));
    expect(seen["authorization"]).toBe("Bearer jwt-1");
  });

  test("falls back to the definition-only endpoint with bare auth", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.startsWith(BALANCE)) return jsonResponse({ code: 3001, msg: "parameter error" });
      return jsonResponse({ code: 0, data: { plans: PLANS } });
    }) as unknown as typeof fetch;
    const result = await fetchZcodeQuota("jwt-1", fetcher);
    expect(calls.map((call) => call.url.split("?")[0])).toEqual([BALANCE, CURRENT]);
    // The control face empties `current`; the fallback must not carry it.
    const fallback = calls[1];
    expect(fallback?.headers["x-device-mid"]).toBeUndefined();
    expect(fallback?.headers["authorization"]).toBe("Bearer jwt-1");
    expect(result.windows).toHaveLength(2);
    expect(result.error).toContain("balance:");
  });

  test("an envelope code on HTTP 200 is a failure, not an empty success", async () => {
    const result = await fetchZcodeQuota(
      "jwt-1",
      routedFetcher({
        [BALANCE]: () => jsonResponse({ code: 3012, msg: "unusual activity" }),
        [CURRENT]: () => jsonResponse({ code: 3012, msg: "unusual activity" }),
      }),
    );
    expect(result.windows).toHaveLength(0);
    expect(result.error).toContain("3012");
  });

  test("a failed read on both endpoints throws nothing and reports the errors", async () => {
    const result = await fetchZcodeQuota(
      "jwt-1",
      routedFetcher({
        [BALANCE]: () => jsonResponse({ error: "boom" }, 500),
        [CURRENT]: () => jsonResponse({ error: "boom" }, 500),
      }),
    );
    expect(result.windows).toHaveLength(0);
    expect(result.error).toContain("balance:");
    expect(result.error).toContain("current:");
  });

  test("an exhausted grant is a successful read, not an error", async () => {
    const result = await fetchZcodeQuota(
      "jwt-1",
      routedFetcher({
        [BALANCE]: () =>
          jsonResponse({
            code: 0,
            data: {
              plans: PLANS,
              balances: [
                {
                  entitlement_id: "ent-flash",
                  show_name: "GLM-5.3-Flash",
                  capabilities: ["model:glm-5.3-flash"],
                  total_units: 100,
                  used_units: 100,
                  remaining_units: 0,
                  unit_type: "tokens",
                },
              ],
            },
          }),
      }),
    );
    const flash = result.windows.find((window) => window.label.includes("GLM-5.3-Flash"));
    expect(flash?.usedPercent).toBe(100);
    expect(flash?.remainingPercent).toBe(0);
    expect(result.error).toBeNull();
  });

  /**
   * A campaign's units are often scheduled: the plan is `active` and its size is
   * known, but the vendor refuses every request until `effective_at`. The read
   * must carry that instant, because without it the dashboard can only render an
   * empty bar under a bare limit — which reads as a broken readout — instead of
   * the schedule the vendor's own app shows as "Pending".
   */
  test("carries a pending grant's scheduled instant onto its window", async () => {
    const result = await fetchZcodeQuota(
      "jwt-1",
      routedFetcher({
        [BALANCE]: () =>
          jsonResponse({
            code: 0,
            data: {
              plans: [
                {
                  plan_id: "zcode-v3-start-plan-1110-nt",
                  name: "ZCODE GLOBAL BUILD",
                  status: "active",
                  entitlements: [
                    {
                      entitlement_id: "ent-1110-1",
                      show_name: "GLM-5.3-Flash",
                      capabilities: ["model:glm-5.3-flash"],
                      grant_units: 300_000_000,
                      effective_at: 1_794_322_800,
                    },
                  ],
                },
              ],
              // The vendor omits the balance row entirely until the grant is
              // spendable, which is why the definition is the only source.
              balances: [],
            },
          }),
      }),
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.availableAt).toBe(new Date(1_794_322_800 * 1000).toISOString());
    // No usage has been reported, so no percentage may be invented.
    expect(result.windows[0]?.usedPercent).toBeNull();
    expect(result.windows[0]?.limit).toBe(300_000_000);
  });

  test("a grant with no schedule reports no pending instant", async () => {
    const result = await fetchZcodeQuota(
      "jwt-1",
      routedFetcher({
        [BALANCE]: () =>
          jsonResponse({
            code: 0,
            data: {
              plans: [
                {
                  plan_id: "zcode-v3-start-plan-0817",
                  name: "ZCode Start Plan",
                  entitlements: [
                    { entitlement_id: "ent-0817", show_name: "GLM-5.3", grant_units: 3_000_000 },
                  ],
                },
              ],
              balances: [],
            },
          }),
      }),
    );
    expect(result.windows[0]?.availableAt).toBeNull();
  });

  test("an empty credential is rejected before any request", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    await expect(fetchZcodeQuota("   ", fetcher)).rejects.toThrow("ZCode credential is empty.");
    expect(called).toBe(false);
  });

  /**
   * An account can hold a referral grant and a start plan at the same time.
   * Both plans must stay visible, but they are two plans, not one plan named
   * "A + B": the summary label names the dominant plan, and each window names
   * its own plan so the dashboard can render them as separate cards.
   */
  test("keeps two plans separate instead of joining them into one label", async () => {
    const result = await fetchZcodeQuota(
      "jwt-1",
      routedFetcher({
        [BALANCE]: () =>
          jsonResponse({
            code: 0,
            data: {
              plans: [
                {
                  plan_id: "zcode-v3-start-plan-referral",
                  name: "ZCode Referral Global",
                  entitlements: [
                    {
                      entitlement_id: "ent-referral",
                      show_name: "GLM-5.3-Flash",
                      capabilities: ["model:glm-5.3-flash"],
                      grant_units: 100_000_000,
                    },
                  ],
                },
                {
                  plan_id: "zcode-v3-start-plan-0817",
                  name: "ZCode Start Plan",
                  entitlements: [
                    {
                      entitlement_id: "ent-start",
                      show_name: "GLM-5.3",
                      capabilities: ["model:glm-5.3"],
                      grant_units: 3_000_000,
                    },
                  ],
                },
              ],
              balances: [],
            },
          }),
      }),
    );
    // The summary label names one plan; it must never read "A + B", which is
    // how a two-plan account was previously mistaken for a single plan.
    expect(result.plan).not.toContain("+");
    expect(result.plan === null ? null : ["ZCode Referral Global", "ZCode Start Plan"].includes(result.plan)).toBe(true);
    expect(result.windows).toHaveLength(2);
    // Each window carries the plan it belongs to, which is what the quota page
    // groups on. Without it the two plans collapse into one undifferentiated list.
    expect(result.windows.map((window) => window.group).sort()).toEqual([
      "ZCode Referral Global",
      "ZCode Start Plan",
    ]);
  });

  /**
   * A refused read is not an empty plan. The message used to say "No plan
   * grants on this account", which told an operator holding a live plan that
   * the account had none — the vendor had simply rate-limited the read.
   */
  test("a refused read reports the refusal instead of claiming there is no plan", async () => {
    const result = await fetchZcodeQuota(
      "jwt-1",
      routedFetcher({
        [BALANCE]: () => new Response("", { status: 429, headers: { "retry-after": "1" } }),
        [CURRENT]: () => new Response("", { status: 429, headers: { "retry-after": "1" } }),
      }),
    );
    expect(result.windows).toHaveLength(0);
    expect(result.plan).toBeNull();
    expect(result.error).toContain("rate limited");
    expect(result.error).not.toContain("no plan grants");
  });

  /** An answered read of an empty account is still an answer. */
  test("an answered empty account reports that it has no grants", async () => {
    const result = await fetchZcodeQuota(
      "jwt-1",
      routedFetcher({
        [BALANCE]: () => jsonResponse({ code: 0, data: { plans: [], balances: [] } }),
        [CURRENT]: () => jsonResponse({ code: 0, data: { plans: [] } }),
      }),
    );
    expect(result.error).toContain("no plan grants");
  });
});
