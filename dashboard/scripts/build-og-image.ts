import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

/**
 * Renders `public/og_image.webp`, the social preview card.
 *
 * Generated rather than hand-drawn so the card cannot drift from the product's
 * own surfaces: it uses the same brand mark, the same type stack, and the same
 * black-glass treatment as the landing page and the console. The previous card
 * was a hand-made banner that survived the rename and still advertised the old
 * product name over a light pastel background — a preview image is the first
 * thing a shared link shows, so a stale one misrepresents the site before
 * anyone opens it.
 *
 * Chromium is borrowed through Playwright because the dashboard already
 * depends on it for verification tooling, and it renders the same engine the
 * browser uses — no extra image dependency, matching `build-brand-icons.ts`.
 *
 * Run from the dashboard workspace: `bun run scripts/build-og-image.ts`
 */
const WIDTH = 1760;
const HEIGHT = 576;

const dashboardRoot = resolve(import.meta.dir, "..");
const outPath = resolve(dashboardRoot, "public/og_image.webp");

/** The brand mark, inlined so the card needs no network or app bundle. */
const MARK = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3.4 5.6h3.4" /><path d="M3.4 12h3.4" /><path d="M3.4 18.4h3.4" />
  <path d="M6.8 5.6c3.3 0 3.4 5.1 5.6 6.4" />
  <path d="M6.8 18.4c3.3 0 3.4-5.1 5.6-6.4" />
  <path d="M6.8 12h5.6" />
  <path d="M12.4 12h8.2" /><path d="M17.4 8.6 20.8 12l-3.4 3.4" />
</svg>`;

const html = `<!doctype html>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Inter:wght@400;500&family=Space+Grotesk:wght@500;600;700&display=swap">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; }
  body {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 3rem;
    padding: 0 6rem;
    background: #000;
    color: #f4f7ff;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: -.011em;
    overflow: hidden;
  }
  /* One soft pool behind the copy, the same depth cue the landing uses. */
  .pool {
    position: absolute;
    top: -220px;
    left: 180px;
    width: 900px;
    height: 620px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(194, 202, 214, .13), transparent 68%);
  }
  .copy { position: relative; min-width: 0; }
  .brand { display: flex; align-items: center; gap: .8rem; margin-bottom: 2.1rem; }
  .brand-mark {
    display: grid;
    width: 62px;
    height: 62px;
    place-items: center;
    border: 1px solid rgba(255, 255, 255, .1);
    border-top-color: rgba(255, 255, 255, .16);
    border-radius: 999px;
    background: rgba(255, 255, 255, .07);
    color: #c2cad6;
  }
  .brand-mark svg { width: 34px; height: 34px; }
  .brand-name {
    font-family: "Space Grotesk", "Inter", sans-serif;
    font-size: 40px;
    font-weight: 600;
    letter-spacing: -.02em;
  }
  h1 {
    font-family: "Space Grotesk", "Inter", sans-serif;
    font-size: 68px;
    font-weight: 600;
    line-height: 1.06;
    letter-spacing: -.035em;
    max-width: 17ch;
  }
  p {
    margin-top: 1.5rem;
    max-width: 30ch;
    color: rgba(226, 234, 250, .62);
    font-size: 23px;
    line-height: 1.5;
  }
  .meta {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: .6rem;
    margin-top: 2.4rem;
  }
  .chip {
    padding: .5rem .95rem;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 999px;
    background: rgba(255, 255, 255, .04);
    color: rgba(226, 234, 250, .62);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 15px;
    letter-spacing: .02em;
  }
  /* The panel mirrors the landing card: brighter top edge, inset hairline,
     deep drop shadow. */
  .panel {
    position: relative;
    flex: 0 0 auto;
    display: grid;
    gap: .85rem;
    width: 430px;
    padding: 1.6rem;
    border: 1px solid rgba(255, 255, 255, .08);
    border-top-color: rgba(255, 255, 255, .16);
    border-radius: 22px;
    background: rgba(11, 11, 15, .6);
    box-shadow:
      inset 0 1px 0 0 rgba(255, 255, 255, .1),
      0 24px 56px -14px rgba(0, 0, 0, .95);
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: .5rem;
    color: #c2cad6;
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 12px;
    letter-spacing: .12em;
  }
  .dot { width: 7px; height: 7px; border-radius: 999px; background: #c2cad6; }
  .route {
    display: flex;
    align-items: center;
    gap: .7rem;
    padding: .7rem .85rem;
    border: 1px solid rgba(255, 255, 255, .06);
    border-radius: 12px;
    background: rgba(255, 255, 255, .04);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 15px;
    color: rgba(226, 234, 250, .78);
  }
  .route span:first-child { color: rgba(226, 234, 250, .45); }
  .arrow { margin-left: auto; color: #c2cad6; }
</style>
<div class="pool"></div>
<div class="copy">
  <div class="brand">
    <span class="brand-mark">${MARK}</span>
    <span class="brand-name">lianrouter</span>
  </div>
  <h1>One gateway for every AI provider</h1>
  <p>Any client protocol in, any provider dialect out — routed, translated, and quota-controlled.</p>
  <div class="meta">
    <span class="chip">40 providers</span>
    <span class="chip">OpenAI &amp; Anthropic</span>
    <span class="chip">self-hosted</span>
  </div>
</div>
<div class="panel">
  <div class="panel-head"><span class="dot"></span>ROUTING</div>
  <div class="route"><span>client</span> /v1/messages <span class="arrow">→</span></div>
  <div class="route"><span>route</span> claude-sonnet <span class="arrow">→</span></div>
  <div class="route"><span>provider</span> anthropic <span class="arrow">→</span></div>
  <div class="route"><span>egress</span> 200 OK <span class="arrow">→</span></div>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
});

await mkdir(resolve(dashboardRoot, "public"), { recursive: true });
await page.setContent(html, { waitUntil: "networkidle" });
// Web fonts must be laid out before the shot, or the card renders in a
// fallback face and the generated file silently disagrees with the design.
await page.evaluate(() => document.fonts.ready);
const buffer = await page.screenshot({ type: "webp", quality: 92 });
await writeFile(outPath, buffer);
console.log(`✓ og_image.webp (${WIDTH}×${HEIGHT}, ${(buffer.length / 1024).toFixed(1)} KB)`);

await browser.close();
