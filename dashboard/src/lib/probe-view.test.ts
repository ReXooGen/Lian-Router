import { describe, expect, test } from "bun:test";

import { probeRowView, type ProbeRowResult } from "./probe-view";

function result(overrides: Partial<ProbeRowResult> = {}): ProbeRowResult {
  return { ok: true, latencyMs: 900, ...overrides };
}

describe("probeRowView — a probe answers generation, not listing", () => {
  test("a generation shows the sample and the exit", () => {
    const view = probeRowView(
      result({ kind: "generated", latencyMs: 1729, sample: "I am a model.", poolHost: "45.3.54.79:3129" }),
      false,
    );
    expect(view.kind).toBe("generated");
    expect(view.tone).toBe("ok");
    expect(view.headline).toBe("generated in 1.7s · via 45.3.54.79:3129");
    expect(view.detail).toBe("I am a model.");
  });

  test("there is no listed state to render", () => {
    // A probe dispatches, so `ok` without a generated kind can only mean an
    // older payload. It renders as a generation, never as a listing, because a
    // listing is not an answer this surface has any more.
    const view = probeRowView(result({ ok: true }), false);
    expect(view.kind).toBe("generated");
    expect(view.headline).toBe("generated in 900ms · direct");
  });

  test("an idle row has no headline and no detail", () => {
    const view = probeRowView(null, false);
    expect(view.kind).toBe("idle");
    expect(view.headline).toBe("");
    expect(view.detail).toBeUndefined();
  });

  test("a pending row says one request is in flight", () => {
    const view = probeRowView(null, true);
    expect(view.kind).toBe("pending");
    expect(view.headline).toBe("Probing…");
  });
});

describe("probeRowView — a dispatched refusal", () => {
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
    expect(view.detail ?? "").not.toContain("nothing left the box");
  });

  test("a refusal with no code still reads as a refusal", () => {
    const view = probeRowView(result({ ok: false }), false);
    expect(view.kind).toBe("refused");
    expect(view.headline).toBe("refused · unknown_error");
    expect(view.detail).toBe("The probe was refused. (nothing left the box, so no allowance was spent)");
  });

  test("a refusal that rotated exits reports how many it burned", () => {
    const view = probeRowView(
      result({ ok: false, kind: "refused", code: "rate_limited", exitsTried: 3, allowanceSpent: true }),
      false,
    );
    expect(view.detail).toContain("3 exits tried");
    expect(view.detail).not.toContain("nothing left the box");
  });

  test("a generation never claims a cost it did not record", () => {
    const view = probeRowView(result({ kind: "generated", sample: "ok" }), false);
    expect(view.allowanceNote).toBeUndefined();
    expect(view.detail).toBe("ok");
  });
});
