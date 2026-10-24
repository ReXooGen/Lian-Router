/**
 * The notification-area icon, drawn at runtime.
 *
 * The mark is the same one `dashboard/src/components/BrandMark.tsx` renders:
 * three inbound lanes converging into one outbound arrow, drawn inside a
 * 24-unit viewBox with a 2.3-unit stroke. Reproducing it here — rather than
 * shipping a `.ico` — keeps the tray and the console on one source of truth and
 * means a packaged build needs no assets.
 *
 * # Why supersampling
 *
 * GDI has no path rasteriser reachable through these bindings, and a 1.5-pixel
 * stroke at 16×16 quantised to whole pixels turns into a dashed mess. Instead
 * every pixel is sampled on a 4× grid, coverage is ramped across one subpixel,
 * and the block is box-filtered down. The result is a straight-alpha BGRA bitmap
 * with alpha 0 everywhere outside the strokes, so the icon blends into whatever
 * the taskbar background happens to be.
 *
 * The glyph is drawn twice: a dark halo one subpixel wider, then the light mark
 * on top. A single-tone glyph is unreadable on one of the two taskbar themes —
 * the halo costs nothing and keeps the lanes separated on both.
 */

import {
  createDibSection,
  createIconFromBitmaps,
  deleteBitmap,
  registerTrayIconFactory,
  systemSmallIconSize,
} from "./win32";
import type { NativeHandle } from "./win32";

// ─── Geometry (design units, 24-unit viewBox) ───────────────────────────────

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Segment {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

const VIEW_BOX = 24;
const STROKE_RADIUS = 2.3 / 2;
const HALO_EXTRA = 0.55;

const LANE_Y = [5.6, 12, 18.4] as const;

/** Flattens a cubic Bézier into line segments; 24 steps is well under a subpixel. */
function flattenCubic(start: Point, control1: Point, control2: Point, end: Point): Point[] {
  const points: Point[] = [];
  const steps = 24;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const inv = 1 - t;
    const a = inv * inv * inv;
    const b = 3 * inv * inv * t;
    const c = 3 * inv * t * t;
    const d = t * t * t;
    points.push({
      x: a * start.x + b * control1.x + c * control2.x + d * end.x,
      y: a * start.y + b * control1.y + c * control2.y + d * end.y,
    });
  }
  return points;
}

function buildSegments(): readonly Segment[] {
  const polylines: Point[][] = [];

  for (const y of LANE_Y) {
    polylines.push([
      { x: 3.4, y },
      { x: 6.8, y },
    ]);
  }

  const upper = { x: 6.8, y: 5.6 };
  polylines.push([upper, ...flattenCubic(upper, { x: 10.1, y: 5.6 }, { x: 10.2, y: 10.7 }, { x: 12.4, y: 12 })]);

  const lower = { x: 6.8, y: 18.4 };
  polylines.push([lower, ...flattenCubic(lower, { x: 10.1, y: 18.4 }, { x: 10.2, y: 13.3 }, { x: 12.4, y: 12 })]);

  polylines.push([
    { x: 6.8, y: 12 },
    { x: 12.4, y: 12 },
  ]);

  // Trunk and arrowhead are one polyline: a round join at the tip would round
  // off the point, so the shaft stops at the arrow's base instead.
  polylines.push([
    { x: 12.4, y: 12 },
    { x: 20.6, y: 12 },
  ]);
  polylines.push([
    { x: 17.4, y: 8.6 },
    { x: 20.8, y: 12 },
    { x: 17.4, y: 15.4 },
  ]);

  const segments: Segment[] = [];
  for (const polyline of polylines) {
    for (let i = 1; i < polyline.length; i += 1) {
      const from = polyline[i - 1];
      const to = polyline[i];
      if (from === undefined || to === undefined) continue;
      segments.push({ ax: from.x, ay: from.y, bx: to.x, by: to.y });
    }
  }
  return segments;
}

const SEGMENTS = buildSegments();

/**
 * Distance from a point to a segment.
 *
 * Round caps and round joins come free from taking the minimum over segment
 * distances: the endpoint regions of a segment are exactly the cap circles, so
 * no separate cap geometry is needed.
 */
function distanceToSegment(px: number, py: number, segment: Segment): number {
  const dx = segment.bx - segment.ax;
  const dy = segment.by - segment.ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((px - segment.ax) * dx + (py - segment.ay) * dy) / lengthSquared;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const nearestX = segment.ax + t * dx;
  const nearestY = segment.ay + t * dy;
  const offsetX = px - nearestX;
  const offsetY = py - nearestY;
  return Math.sqrt(offsetX * offsetX + offsetY * offsetY);
}

// ─── Rasterisation ──────────────────────────────────────────────────────────

const SUPERSAMPLE = 4;

/** Light glyph, matching the console's `currentColor` on a dark tile. */
const MARK_RED = 238;
const MARK_GREEN = 242;
const MARK_BLUE = 247;
/** Halo colour, the same near-black the favicon tile uses. */
const HALO_RED = 11;
const HALO_GREEN = 12;
const HALO_BLUE = 16;
const HALO_ALPHA = 0.85;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Renders the mark into a straight-alpha BGRA buffer.
 *
 * Each subpixel is composited as "halo under mark" and accumulated
 * premultiplied, which is the only form that averages correctly in the box
 * filter. The division back to straight alpha happens once per output pixel.
 *
 * Exported because it is the whole rasterisation contract in one pure function:
 * a caller can assert transparency and coverage without an `HICON` or a screen.
 */
export function renderMark(size: number): Buffer {
  const samples = size * SUPERSAMPLE;
  const unitsPerSample = VIEW_BOX / samples;
  const feather = unitsPerSample;
  const lightRadius = STROKE_RADIUS;
  const haloRadius = STROKE_RADIUS + HALO_EXTRA;

  const output = Buffer.alloc(size * size * 4);
  const blockSamples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let sumA = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        const sampleY = (py * SUPERSAMPLE + sy + 0.5) * unitsPerSample;
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const sampleX = (px * SUPERSAMPLE + sx + 0.5) * unitsPerSample;

          let nearest = Number.POSITIVE_INFINITY;
          for (const segment of SEGMENTS) {
            const distance = distanceToSegment(sampleX, sampleY, segment);
            if (distance < nearest) nearest = distance;
          }

          const markAlpha = clamp01((lightRadius - nearest) / feather + 0.5);
          const haloAlpha = clamp01((haloRadius - nearest) / feather + 0.5) * HALO_ALPHA;

          const outAlpha = markAlpha + haloAlpha * (1 - markAlpha);
          if (outAlpha <= 0) continue;

          const red = (MARK_RED * markAlpha + HALO_RED * haloAlpha * (1 - markAlpha)) / outAlpha;
          const green = (MARK_GREEN * markAlpha + HALO_GREEN * haloAlpha * (1 - markAlpha)) / outAlpha;
          const blue = (MARK_BLUE * markAlpha + HALO_BLUE * haloAlpha * (1 - markAlpha)) / outAlpha;

          sumA += outAlpha;
          sumR += red * outAlpha;
          sumG += green * outAlpha;
          sumB += blue * outAlpha;
        }
      }

      if (sumA <= 0) continue;

      const alpha = sumA / blockSamples;
      const offset = (py * size + px) * 4;
      output[offset] = Math.round(sumB / sumA);
      output[offset + 1] = Math.round(sumG / sumA);
      output[offset + 2] = Math.round(sumR / sumA);
      output[offset + 3] = Math.round(alpha * 255);
    }
  }

  return output;
}

// ─── Icon construction ──────────────────────────────────────────────────────

/** Notification-area icons top out at 32 px on the largest DPI Windows ships. */
const DEFAULT_ICON_SIZE = 16;
const MAX_ICON_SIZE = 32;

/**
 * Picks the bitmap size Explorer will actually display.
 *
 * `Shell_NotifyIconW` takes one `HICON` and scales it, so drawing at 32 and
 * letting the shell shrink it to 16 blurs the 1.5-pixel strokes into a smudge.
 * Rendering at the metric size keeps the lanes crisp at every DPI; the 32-pixel
 * path is the same code with a larger grid.
 */
function resolveIconSize(): number {
  const metric = systemSmallIconSize();
  if (metric <= 0) return DEFAULT_ICON_SIZE;
  return metric > MAX_ICON_SIZE ? MAX_ICON_SIZE : metric;
}

/**
 * Builds the `HICON` the tray registers.
 *
 * `CreateIconIndirect` copies both bitmaps, so they are released immediately.
 * The mask must be a real bitmap even though Windows ignores it for 32-bit
 * alpha icons — a null mask makes the call fail.
 */
export function drawTrayIcon(): NativeHandle | undefined {
  const size = resolveIconSize();

  const color = createDibSection(size, size, 32);
  const mask = createDibSection(size, size, 1);
  try {
    renderMark(size).copy(color.pixels);
    const icon = createIconFromBitmaps(color.bitmap, mask.bitmap);
    return icon;
  } finally {
    deleteBitmap(color.bitmap);
    deleteBitmap(mask.bitmap);
  }
}

registerTrayIconFactory(drawTrayIcon);
