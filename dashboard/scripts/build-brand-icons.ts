import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

/**
 * Rasterizes `public/favicon.svg` into the PNG sizes the browser and PWA
 * surfaces want. Run with `bun run scripts/build-brand-icons.ts` from the
 * dashboard workspace; the committed SVG stays the single source of truth and
 * the PNGs are regenerated from it, never hand-edited.
 *
 * Chromium is borrowed through Playwright because it is already installed for
 * the dashboard's verification tooling and renders SVG with the same engine
 * the browser uses — no extra image dependency.
 */
const SIZES = [16, 32, 180, 192, 512] as const;

const dashboardRoot = resolve(import.meta.dir, "..");
const svgPath = resolve(dashboardRoot, "public/favicon.svg");
const outDir = resolve(dashboardRoot, "public");

const svg = await readFile(svgPath, "utf8");

const browser = await chromium.launch();
const page = await browser.newPage();

await mkdir(outDir, { recursive: true });

for (const size of SIZES) {
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
svg{display:block;width:${size}px;height:${size}px}</style>
${svg}`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(html);
  const buffer = await page.locator("svg").screenshot({ omitBackground: true });
  const target = resolve(outDir, `favicon-${size}.png`);
  await writeFile(target, buffer);
  console.log(`✓ favicon-${size}.png`);
}

await browser.close();
