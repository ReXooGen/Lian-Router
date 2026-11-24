import { describe, expect, test } from "bun:test";
import {
  claimZcodePlan,
  fetchZcodeClaimVerificationConfig,
  listZcodeClaims,
} from "../../../src/providers/integrations/zcode/zcode-claim";
import { ZCODE_APP_VERSION, zcodeCampaignAppVersion } from "../../../src/providers/integrations/zcode/identity";
import { jsonResponse } from "../../helpers/sse-fixtures";

const PREVIEW = "https://zcode.z.ai/api/v1/zcode-plan/billing/preview";
const TOUCH = "https://zcode.z.ai/api/v1/marketing/touch";
const CLAIM = "https://zcode.z.ai/api/v1/zcode-plan/billing/claim";


function routedFetcher(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler();
    }
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof fetch;
}

/** A delivery tree shaped like the marketing surface: nested, defensive-parse territory. */
const TOUCH_DELIVERIES = [
  {
    banner: {
      title: "Weekend build",
      buttons: [{ label: "Claim", action: { type: "claim_zcode_plan", args: { plan_id: "weekend-500m" } } }],
      body: { zcode_plan: { plan_id: "weekend-500m", name: "ZCODE WEEKEND BUILD", priority: 90, ends_at: 1795000000 } },
    },
  },
  {
    popup: {
      buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "trial-5m" } } }],
    },
  },
];

describe("listZcodeClaims", () => {
  test("merges the preview and marketing surfaces", async () => {
    const listing = await listZcodeClaims(
      "jwt-1",
      routedFetcher({
        [PREVIEW]: () =>
          jsonResponse({
            code: 0,
            data: { plans: [{ plan_id: "start-plan", name: "Start Plan", priority: 10 }] },
          }),
        [TOUCH]: () => jsonResponse({ code: 0, data: { deliveries: TOUCH_DELIVERIES } }),
      }),
    );
    expect(listing.plans.map((plan) => plan.planId).sort()).toEqual([
      "start-plan",
      "trial-5m",
      "weekend-500m",
    ]);
    expect(listing.errors).toEqual([]);
    const weekend = listing.plans.find((plan) => plan.planId === "weekend-500m");
    expect(weekend?.name).toBe("ZCODE WEEKEND BUILD");
    expect(weekend?.priority).toBe(90);
    expect(weekend?.source).toBe("banner");
    expect(weekend?.endsAt).not.toBeNull();
  });

  test("orders by declared priority, unknown last", async () => {
    const listing = await listZcodeClaims(
      "jwt-1",
      routedFetcher({
        [PREVIEW]: () =>
          jsonResponse({
            code: 0,
            data: {
              plans: [
                { plan_id: "low", priority: 1 },
                { plan_id: "high", priority: 99 },
              ],
            },
          }),
        [TOUCH]: () => jsonResponse({ code: 0, data: { deliveries: TOUCH_DELIVERIES } }),
      }),
    );
    expect(listing.plans[0]?.planId).toBe("high");
    expect(listing.plans.at(-1)?.priority).toBeNull();
  });

  test("a button naming a campaign without metadata still lists it", async () => {
    const listing = await listZcodeClaims(
      "jwt-1",
      routedFetcher({
        [PREVIEW]: () => jsonResponse({ code: 0, data: { plans: [] } }),
        [TOUCH]: () => jsonResponse({ code: 0, data: { deliveries: TOUCH_DELIVERIES } }),
      }),
    );
    const trial = listing.plans.find((plan) => plan.planId === "trial-5m");
    expect(trial).toBeDefined();
    expect(trial?.name).toBe("trial-5m");
  });

  test("one failed surface does not discard the other", async () => {
    const listing = await listZcodeClaims(
      "jwt-1",
      routedFetcher({
        [PREVIEW]: () => jsonResponse({ error: "boom" }, 500),
        [TOUCH]: () => jsonResponse({ code: 0, data: { deliveries: TOUCH_DELIVERIES } }),
      }),
    );
    expect(listing.plans.length).toBeGreaterThan(0);
    expect(listing.errors.some((error) => error.startsWith("preview:"))).toBe(true);
  });

  /**
   * The vendor answers a burst of reads with `429` and no body, then serves
   * the same request normally. Reporting the first refusal as the campaign
   * list told the operator nothing was claimable, so one retry is made after
   * the advertised delay.
   */
  test("a rate-limited surface is retried once before being reported", async () => {
    let previewCalls = 0;
    const listing = await listZcodeClaims(
      "jwt-1",
      routedFetcher({
        [PREVIEW]: () => {
          previewCalls += 1;
          return previewCalls === 1
            ? new Response("", { status: 429, headers: { "retry-after": "0" } })
            : jsonResponse({ code: 0, data: { plans: [{ plan_id: "after-retry", priority: 5 }] } });
        },
        [TOUCH]: () => jsonResponse({ code: 0, data: { deliveries: [] } }),
      }),
    );
    expect(previewCalls).toBe(2);
    expect(listing.plans.map((plan) => plan.planId)).toContain("after-retry");
    expect(listing.errors).toHaveLength(0);
  });

  test("both surfaces failing yields no plans and both errors", async () => {
    const listing = await listZcodeClaims(
      "jwt-1",
      routedFetcher({
        [PREVIEW]: () => jsonResponse({ error: "boom" }, 500),
        [TOUCH]: () => jsonResponse({ error: "boom" }, 500),
      }),
    );
    expect(listing.plans).toEqual([]);
    expect(listing.errors).toHaveLength(2);
  });

  test("a campaign nested past the depth cap is not read", async () => {
    // The walk is depth-bounded so a hostile delivery cannot make it recurse
    // forever. The bound is observable: a campaign parked 12 levels down is
    // ignored, while one inside the cap is found.
    const nest = (levels: number, leaf: Record<string, unknown>): Record<string, unknown> => {
      let node: Record<string, unknown> = leaf;
      for (let index = 0; index < levels; index += 1) node = { child: node };
      return node;
    };
    const tooDeep = nest(12, {
      zcode_plan: { plan_id: "buried", name: "Buried", priority: 5 },
      buttons: [{ action: { type: "claim_zcode_plan", args: { plan_id: "buried" } } }],
    });
    const withinCap = nest(2, {
      zcode_plan: { plan_id: "reachable", name: "Reachable", priority: 5 },
    });
    const listing = await listZcodeClaims(
      "jwt-1",
      routedFetcher({
        [PREVIEW]: () => jsonResponse({ code: 0, data: { plans: [] } }),
        [TOUCH]: () => jsonResponse({ code: 0, data: { deliveries: [tooDeep, withinCap] } }),
      }),
    );
    expect(listing.plans.map((plan) => plan.planId)).toEqual(["reachable"]);
  });

  test("an empty credential is rejected before any request", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    await expect(listZcodeClaims("   ", fetcher)).rejects.toThrow("ZCode credential is empty.");
    expect(called).toBe(false);
  });
});

describe("claimZcodePlan", () => {
  test("a successful claim reports the granted window", async () => {
    const outcome = await claimZcodePlan(
      "jwt-1",
      "weekend-500m",
      routedFetcher({
        [CLAIM]: () =>
          jsonResponse({
            code: 0,
            data: { plan: { starts_at: 1794000000, ends_at: 1795000000 } },
          }),
      }),
    );
    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") return;
    expect(outcome.planId).toBe("weekend-500m");
    expect(outcome.startsAt).not.toBeNull();
    expect(outcome.endsAt).not.toBeNull();
  });

  test("code 3007 is a captcha gate, not a generic rejection", async () => {
    // Verified live: the claim endpoint answers 400 {"code":3007,"msg":"captcha
    // verify failed"} for a campaign that needs a solved challenge. The operator's
    // next step is the desktop app, so the outcome must say so.
    const outcome = await claimZcodePlan(
      "jwt-1",
      "weekend-500m",
      routedFetcher({ [CLAIM]: () => jsonResponse({ code: 3007, msg: "captcha verify failed" }, 400) }),
    );
    expect(outcome.kind).toBe("captcha_required");
    if (outcome.kind !== "captcha_required") return;
    expect(outcome.message).toContain("captcha");
  });

  test("another business code is a rejection carrying the code", async () => {
    const outcome = await claimZcodePlan(
      "jwt-1",
      "expired",
      routedFetcher({ [CLAIM]: () => jsonResponse({ code: 4003, msg: "campaign ended" }, 400) }),
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.code).toBe(4003);
    expect(outcome.message).toContain("campaign ended");
  });

  test("a non-JSON failure still reports a rejection rather than throwing", async () => {
    const outcome = await claimZcodePlan(
      "jwt-1",
      "x",
      routedFetcher({ [CLAIM]: () => new Response("upstream exploded", { status: 502 }) }),
    );
    expect(outcome.kind).toBe("rejected");
  });

  /**
   * The campaign faces are version-gated by the vendor, and the gate is not
   * lenient: a client that claims an older app version is answered with no
   * marketing deliveries at all, which reads exactly like "this account has no
   * campaigns". Measured live: 3.16.3 answered `deliveries: []` for an account
   * whose 3.17.2 read carried a live campaign. The claim lane must therefore
   * present the campaign version, and that version is deliberately separate
   * from the inference-lane constant, which is locked to the captured system
   * prompt.
   */
  test("claims the campaign client version on both campaign surfaces", async () => {
    const seen: Record<string, string>[] = [];
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers);
      if (String(input).startsWith(PREVIEW)) return jsonResponse({ code: 0, data: { plans: [] } });
      return jsonResponse({ code: 0, data: { deliveries: [] } });
    }) as unknown as typeof fetch;

    await listZcodeClaims("jwt-1", fetcher);

    expect(seen).toHaveLength(2);
    // Pinned to the literal, not to the constant: the version is the vendor's
    // gate, so a test that compares the constant to itself would pass no matter
    // which value the constant held. Older clients are measured refused — 3.17.2
    // answered `deliveries: []` on 2026-11-20 where 3.18.2 carried the weekend
    // campaign — and the installed desktop client has since moved to 4.0.0,
    // which is what the claim now presents.
    for (const headers of seen) {
      expect(headers["x-zcode-app-version"]).toBe("4.0.0");
      expect(headers["user-agent"]).toBe("ZCode/4.0.0");
    }
    // The campaign version is the one ZCode face allowed to follow a release,
    // so it must come from the resolver — a literal here would be the bug this
    // whole change exists to prevent. The inference constant stays pinned,
    // because the prompt it speaks is captured.
    expect(zcodeCampaignAppVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ZCODE_APP_VERSION).toBe("4.0.0");
  });

  /**
   * The claim gate is a captcha, and the desktop app does not solve it either:
   * it renders the vendor's Aliyun widget and sends the resulting token back in
   * a header pair. Reporting "use the desktop app" therefore pointed the
   * operator at the one place that is not special, while the claim could be
   * finished here. This pins both halves: the config read that makes the widget
   * possible, and the headers that carry the solved challenge.
   */
  test("reads the captcha config the vendor's widget needs", async () => {
    const fetcher = routedFetcher({
      "https://zcode.z.ai/api/v1/client/configs": () =>
        jsonResponse({
          code: 0,
          data: {
            configs: {
              captcha: {
                enabled: true,
                prefix: "no8xfe",
                region: "sgp",
                sceneId: "11xygtvd",
                skip_model_request: true,
              },
            },
          },
        }),
    });
    const config = await fetchZcodeClaimVerificationConfig("jwt-1", fetcher);
    expect(config).toEqual({
      enabled: true,
      region: "sgp",
      prefix: "no8xfe",
      sceneId: "11xygtvd",
      skipModelRequest: true,
    });
  });

  test("an absent captcha object is not an enabled gate", async () => {
    const fetcher = routedFetcher({
      "https://zcode.z.ai/api/v1/client/configs": () => jsonResponse({ code: 0, data: { configs: {} } }),
    });
    const config = await fetchZcodeClaimVerificationConfig("jwt-1", fetcher);
    expect(config.enabled).toBe(false);
  });

  test("sends the solved challenge as the verify header pair", async () => {
    let seen: Record<string, string> = {};
    let body = "";
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      body = String(init?.body ?? "");
      return jsonResponse({ code: 0, data: { plan: { starts_at: 1794222000, ends_at: 1794272400 } } });
    }) as unknown as typeof fetch;

    const outcome = await claimZcodePlan("jwt-1", "zcode-v3-start-plan-1109", fetcher, {
      param: "solved-token",
      region: "sgp",
    });

    expect(outcome.kind).toBe("claimed");
    expect(seen["x-aliyun-captcha-verify-param"]).toBe("solved-token");
    expect(seen["x-aliyun-captcha-verify-region"]).toBe("sgp");
    expect(JSON.parse(body)).toEqual({ plan_id: "zcode-v3-start-plan-1109" });
  });

  test("omits the verify headers for a bare claim", async () => {
    let seen: Record<string, string> = {};
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse({ code: 3007, msg: "captcha verify failed" });
    }) as unknown as typeof fetch;

    const outcome = await claimZcodePlan("jwt-1", "zcode-v3-start-plan-1109", fetcher);

    expect(outcome.kind).toBe("captcha_required");
    // An empty verify header would be rejected as a malformed challenge rather
    // than treated as "no challenge supplied", so it must not be sent at all.
    expect(seen["x-aliyun-captcha-verify-param"]).toBeUndefined();
    expect(seen["x-aliyun-captcha-verify-region"]).toBeUndefined();
  });

  /**
   * A throttle is not a rejection. The vendor answers repeated claims with a
   * bare `HTTP 429`, and folding that into "rejected" told the operator the
   * campaign was gone when the only expired thing was the rate window.
   */
  test("reports a vendor throttle as its own outcome, not a rejection", async () => {
    const fetcher = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    const outcome = await claimZcodePlan("jwt-1", "zcode-v3-start-plan-1109", fetcher);
    expect(outcome.kind).toBe("rate_limited");
  });

  test("an empty plan id is refused before any request", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    await expect(claimZcodePlan("jwt-1", "   ", fetcher)).rejects.toThrow("plan id is required");
    expect(called).toBe(false);
  });
});
