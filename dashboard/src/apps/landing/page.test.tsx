import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LandingPage } from "./page";

/**
 * The landing page is a pure document: every section renders from the static
 * tables in `page.tsx`, so the initial markup must already carry the product
 * copy, the pipeline, the provider catalog, and the console entry point. There
 * is no data fetching and no session, so nothing here needs a backend.
 */
describe("landing page", () => {
  const markup = renderToStaticMarkup(createElement(LandingPage));
  const count = (pattern: RegExp): number => (markup.match(pattern) ?? []).length;

  test("renders the brand and the hero statement", () => {
    expect(markup).toContain("LianRouter");
    expect(markup).toContain("Every client. Every provider.");
    expect(markup).toContain("One door.");
    expect(markup).toContain("Self-hosted AI gateway");
  });

  test("renders the constellation canvas as a decorative, inert backdrop", () => {
    // The field is the page background: one canvas, first child of `.lr`, so it
    // paints under every section. It is `aria-hidden` and unclickable, and the
    // static render must not need `window` — the effect only runs in the browser.
    expect(count(/<canvas/g)).toBe(1);
    expect(markup).toContain('class="lr-constellation"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup.indexOf('class="lr-constellation"')).toBeLessThan(markup.indexOf('class="lr-navwrap"'));
    expect(markup).not.toContain("lr-hero-orbit");
    expect(markup).not.toContain("Routing core");
  });

  test("renders six capability panels with badges and meta feet", () => {
    // 6 capability panels + 4 setup panels all share the one card primitive.
    // Each carries the scroll-reveal modifier, so match the class prefix.
    expect(count(/class="lr-card lr-reveal"/g)).toBe(10);
    expect(markup).toContain("Translates instead of rejecting");
    expect(markup).toContain("Tenant isolation by default");
    expect(markup).toContain(">ROUTING<");
    expect(markup).toContain("Degrades in place");
  });

  test("renders the six-stage request pipeline in order", () => {
    expect(count(/class="lr-stage"/g)).toBe(6);
    for (const stage of ["ingress", "pipeline", "plan", "leases", "dispatch", "settle"]) {
      expect(markup).toContain(`>${stage}<`);
    }
  });

  test("renders the provider catalog and its bundled tail", () => {
    expect(count(/class="lr-provider"/g)).toBe(18);
    expect(markup).toContain("OpenAI");
    expect(markup).toContain("Anthropic");
    expect(markup).toContain("+22 more bundled integrations");
  });

  test("renders the four setup panels", () => {
    expect(markup).toContain("Point a client at one URL");
    expect(markup).toContain("Let it run");
    expect(markup).toContain(">CLIENT<");
    expect(markup).toContain(">RUNTIME<");
  });

  test("renders the end-to-end how-it-works rail", () => {
    // The rail is one track of eight stops — client, the six stages, the
    // provider account — so a stop added or dropped without moving the
    // timetable in `landing.css` would desynchronise the packet from the
    // nodes it is supposed to land on.
    expect(markup).toContain('id="how"');
    expect(markup).toContain('href="#how"');
    expect(count(/class="lr-flow-cell /g)).toBe(8);
    expect(markup).toContain(">POST<");
    expect(markup).toContain(">/v1/messages<");
    expect(markup).toContain(">anthropic<");
    expect(count(/class="lr-flow-note"/g)).toBe(10);
    expect(markup).toContain("ready for the next request");
    // The packet and the lit trail behind it are what make it a motion
    // diagram rather than a static list of stages.
    expect(markup).toContain('class="lr-flow-packet"');
    expect(markup).toContain('class="lr-flow-trail"');
  });

  test("links into the console and lists the gateway paths", () => {
    expect(markup).toContain("/console/login");
    expect(markup).toContain("/v1/messages");
  });

  test("draws the brand mark as inline svg, not an image file", () => {
    expect(markup).toContain('class="lr-brand-mark"');
    expect(markup).toContain("<svg");
    expect(markup).not.toContain("favicon.webp");
  });

  test("carries no repository source link", () => {
    expect(markup).not.toContain("github.com");
    expect(markup).not.toContain("View source");
  });
});
