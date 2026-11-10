import { describe, expect, test } from "bun:test";

import { probeRowView, type ProbeRowResult } from "./probe-view";

function result(overrides: Partial<ProbeRowResult> = {}): ProbeRowResult {
  return { ok: true, latencyMs: 900, ...overrides };
}

describe("probeRowView — a listing is never a generation", () => {
  test("renders a catalog hit as listed, with the paid action beside it", () => {
    const view = probeRowView(result({ mode: "catalog", poolHost: "45.3.54.79:3129" }), false);
    expect(view.kind).toBe("listed");
    expect(view.tone).toBe("neutral");
    expect(view.headline).toBe("listed upstream · via 45.3.54.79:3129");
    expect(view.detail).toBe("No completion was sent, so no allowance was spent.");
    expect(view.canProve).toBe(true);
  });

  test("states the cost in the label, so the click cannot be a surprise", () => {
    expect(probeRowView(result({ mode: "catalog" }), false).proveLabel).toBe(
      "Prove it generates (spends 1)",
    );
  });

  test("an absent id is a refusal, not a failure to generate", () => {
    const view = probeRowView(
      result({ ok: false, mode: "catalog", code: "model_not_found", error: "not listed" }),
      false,
    );
    expect(view.kind).toBe("refused");
    expect(view.tone).toBe("bad");
    expect(view.headline).toBe("not in the published catalog · direct");
    // No paid action: a dispatch at an id upstream does not publish is a
    // guaranteed waste of an allowance unit.
    expect(view.canProve).toBe(false);
  });

  test("a listing that was free never claims a cost", () => {
    expect(probeRowView(result({ mode: "catalog" }), false).allowanceNote).toBeUndefined();
  });
});

describe("probeRowView — a dispatched result", () => {
  test("a generation shows the sample and the exit, and offers no second paid click", () => {
    const view = probeRowView(
      result({ kind: "generated", latencyMs: 1729, sample: "I am a model.", allowanceSpent: true }),
      false,
    );
    expect(view.kind).toBe("generated");
    expect(view.tone).toBe("ok");
    expect(view.headline).toBe("generated in 1.7s · direct");
    expect(view.detail).toBe("I am a model.");
    expect(view.allowanceNote).toBe("1 allowance unit spent");
    expect(view.canProve).toBe(false);
  });

  test("renders the real routing refusal the operator hits, not a quota wall", () => {
    // This is the shape measured on `opencodeft`: the gateway refuses locally
    // because the selected candidate carries no pool while a pooled sibling
    // exists for another tenant. Nothing left the box, so no unit was charged.
    const view = probeRowView(
      result({
        ok: false,
        kind: "refused",
        latencyMs: 1729,
        code: "proxy_pool_unhealthy",
        reason: "candidate_pool_missing",
        errorOrigin: "network",
        error: "This route has proxy pools configured, but the selected candidate carries none.",
      }),
      false,
    );
    expect(view.kind).toBe("refused");
    expect(view.tone).toBe("bad");
    // The code is in the headline so it survives a narrow row.
    expect(view.headline).toBe("refused · proxy_pool_unhealthy");
    expect(view.detail).toContain("selected candidate carries none");
    expect(view.detail).toContain("origin: network");
    expect(view.detail).toContain("candidate_pool_missing");
    expect(view.detail).toContain("nothing left the box, so no allowance was spent");
    // The message must not read as a rate limit: this is a routing/config fault.
    expect(view.detail).not.toContain("429");
    expect(view.canProve).toBe(false);
  });

  test("a refusal that did spend a unit says so", () => {
    const view = probeRowView(
      result({
        ok: false,
        kind: "refused",
        code: "quota_exceeded",
        errorOrigin: "upstream",
        error: "free usage limit reached",
        allowanceSpent: true,
      }),
      false,
    );
    expect(view.allowanceNote).toBe("1 allowance unit spent");
    expect(view.detail).not.toContain("nothing left the box");
  });

  test("a refusal that rotated through exits says how many it burned", () => {
    // Nine spent addresses and one spent address are different operator
    // problems; without the count the row reads identically.
    const view = probeRowView(
      result({
        ok: false,
        kind: "refused",
        code: "quota_exceeded",
        errorOrigin: "upstream",
        error: "free usage limit reached",
        allowanceSpent: true,
        exitsTried: 9,
      }),
      false,
    );
    expect(view.detail).toContain("9 exits tried");
    expect(view.detail).not.toContain("1 exits tried");
  });

  test("a single-exit refusal does not clutter the row with a count", () => {
    const view = probeRowView(
      result({
        ok: false,
        kind: "refused",
        code: "quota_exceeded",
        errorOrigin: "upstream",
        error: "free usage limit reached",
        allowanceSpent: true,
      }),
      false,
    );
    expect(view.detail).not.toContain("exits tried");
  });

  test("falls back to a refusal for a dispatched failure with no kind", () => {
    const view = probeRowView(result({ ok: false, mode: "dispatch" }), false);
    expect(view.kind).toBe("refused");
    expect(view.headline).toBe("refused · unknown_error");
  });
});

describe("probeRowView — lifecycle", () => {
  test("pending disables the paid action and says a request is in flight", () => {
    const view = probeRowView(result({ mode: "catalog" }), true);
    expect(view.kind).toBe("pending");
    expect(view.proveDisabled).toBe(true);
    expect(view.canProve).toBe(false);
  });

  test("idle renders nothing and offers nothing", () => {
    const view = probeRowView(null, false);
    expect(view.kind).toBe("idle");
    expect(view.headline).toBe("");
    expect(view.canProve).toBe(false);
    expect(view.proveDisabled).toBe(false);
  });
});
