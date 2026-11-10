import { useEffect, useRef, type ReactElement } from "react";
import {
  bandStarCountFor,
  buildStarGrid,
  collectCursorLinks,
  collectStarLinks,
  linkRadiusFor,
  seedStars,
  seedWindowFor,
  type Star,
} from "./constellation-model";

/**
 * The landing backdrop: a drifting star field that links nearby stars into a
 * soft web and treats the pointer as one more node in it.
 *
 * The canvas stays fixed to the viewport; the field lives in world
 * coordinates where `y` grows down the document and is drawn at `y - scrollY`.
 * That keeps the backing store viewport-sized — a 6000px page would otherwise
 * cost 2880 × 12000 px at DPR 2, roughly 138 MB — while the web still travels
 * with the content and new stars are seeded into the band being scrolled in.
 *
 * Four costs are bounded on purpose:
 *
 * - Fill rate: the backing store is capped at 2× DPR, so a 3× phone screen
 *   does not pay 9× the pixels for a background nobody reads.
 * - Population: stars are seeded one viewport-tall band at a time, one band
 *   above the viewport and one and a half below it, and bands outside that
 *   window are dropped. The resident count tracks the viewport, not the page.
 * - Line search: neighbours come from a uniform grid keyed on the link radius
 *   (see `constellation-model.ts`), built over the visible band only, so the
 *   per-frame cost does not grow with the document.
 * - Idle: the loop stops on a hidden tab and the whole field renders a single
 *   frame under `prefers-reduced-motion`.
 *
 * Everything lives inside `useEffect` so the component renders as inert markup
 * under `renderToStaticMarkup` — the landing is a static document and the
 * canvas must not touch `window` during render.
 */

const DPR_CAP = 2;
/** A resumed background tab reports a multi-second delta; clamp so stars do not teleport. */
const MAX_DELTA_SECONDS = 0.05;
const LINE_BUCKETS = 6;
const CURSOR_BUCKETS = 4;
const POINTER_FADE_IN = 12;
const POINTER_FADE_OUT = 3.2;

const LINE_STYLES: readonly string[] = Array.from(
  { length: LINE_BUCKETS },
  (_, index) => `rgba(186, 205, 235, ${(0.19 * (index + 1)) / LINE_BUCKETS})`,
);
const CURSOR_STYLES: readonly string[] = Array.from(
  { length: CURSOR_BUCKETS },
  (_, index) => `rgba(226, 236, 255, ${(0.3 * (index + 1)) / CURSOR_BUCKETS})`,
);
const STAR_STYLES: readonly string[] = Array.from(
  { length: 8 },
  (_, index) => `rgba(238, 244, 255, ${(0.72 * (index + 1)) / 8})`,
);

function bucketOf(strength: number, buckets: number): number {
  const index = Math.floor(strength * buckets);
  return index < 0 ? 0 : index >= buckets ? buckets - 1 : index;
}

export function ConstellationField(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let width = 0;
    let height = 0;
    let docHeight = 0;
    let scrollY = 0;
    /** World-space band coverage. Empty when `seededBottom <= seededTop`. */
    let seededTop = 0;
    let seededBottom = 0;
    let stars: Star[] = [];
    let frame = 0;
    let lastTimestamp = 0;
    let elapsed = 0;
    let running = false;

    let pointerX = 0;
    let pointerY = 0;
    let pointerTarget = 0;
    let pointerAlpha = 0;

    // A partial band at the document edge carries a proportional share of the
    // density, so the field does not get denser where it is cut off.
    const seedBand = (top: number, span: number): void => {
      if (span <= 0 || width <= 0 || height <= 0) return;
      const band = seedStars(bandStarCountFor(width, height, span), width, span);
      for (const star of band) star.y += top;
      stars.push(...band);
    };

    // Grows the seeded range to cover the viewport plus the margins. It only
    // ever fills below the existing bottom (or above the existing top), so a
    // band is always born outside the viewport and drifts in under its own
    // velocity.
    const ensureBands = (): void => {
      if (width <= 0 || height <= 0) return;
      const band = height;
      const { top: wantTop, bottom: wantBottom } = seedWindowFor(scrollY, height, docHeight);
      if (seededBottom <= seededTop) {
        seededTop = wantTop;
        seededBottom = wantTop;
      }
      while (seededTop > wantTop) {
        const top = Math.max(wantTop, seededTop - band);
        seedBand(top, seededTop - top);
        seededTop = top;
      }
      while (seededBottom < wantBottom) {
        const bottom = Math.min(wantBottom, seededBottom + band);
        seedBand(seededBottom, bottom - seededBottom);
        seededBottom = bottom;
      }
    };

    // Drops what the seed window no longer covers. Without this the population
    // would grow with the document instead of the viewport; scrolling back
    // reseeds the band from `ensureBands` rather than remembering it.
    const retireBands = (): void => {
      if (width <= 0 || height <= 0) return;
      const { top: keepTop, bottom: keepBottom } = seedWindowFor(scrollY, height, docHeight);
      if (keepTop === seededTop && keepBottom === seededBottom) return;
      stars = stars.filter((star) => star.y >= keepTop && star.y <= keepBottom);
      seededTop = keepTop;
      seededBottom = keepBottom;
    };

    const paint = (deltaSeconds: number): void => {
      if (width <= 0 || height <= 0) return;
      const radius = linkRadiusFor(width, height);
      const cursorRadius = radius * 1.85;
      scrollY = window.scrollY;
      ensureBands();

      if (deltaSeconds > 0) {
        elapsed += deltaSeconds;
        const margin = radius;
        for (const star of stars) {
          star.x += star.vx * deltaSeconds;
          star.y += star.vy * deltaSeconds;
          if (star.x < -margin) star.x = width + margin;
          else if (star.x > width + margin) star.x = -margin;
          if (star.y < seededTop) star.y = seededBottom;
          else if (star.y > seededBottom) star.y = seededTop;
        }
      }
      retireBands();

      // Exponential approach, so the fade rate is independent of frame rate and
      // the node never snaps when the pointer leaves.
      const rate = pointerTarget > pointerAlpha ? POINTER_FADE_IN : POINTER_FADE_OUT;
      pointerAlpha += (pointerTarget - pointerAlpha) * (1 - Math.exp(-rate * deltaSeconds));
      if (pointerAlpha < 0.004 && pointerTarget === 0) pointerAlpha = 0;

      ctx.clearRect(0, 0, width, height);

      // Only stars whose world position is within one link radius of the
      // viewport enter the grid, so the link pass is bounded by the viewport
      // and not by how far the reader has scrolled.
      const bandTop = scrollY - radius;
      const bandHeight = height + radius * 2;
      const { links } = collectStarLinks(
        stars,
        buildStarGrid(stars, radius, width, bandHeight, bandTop),
        radius,
      );
      const offset = scrollY;
      ctx.lineWidth = 1;
      for (let bucket = 0; bucket < LINE_BUCKETS; bucket += 1) {
        ctx.beginPath();
        let drew = false;
        for (const link of links) {
          if (bucketOf(link.strength, LINE_BUCKETS) !== bucket) continue;
          ctx.moveTo(link.ax, link.ay - offset);
          ctx.lineTo(link.bx, link.by - offset);
          drew = true;
        }
        if (!drew) continue;
        ctx.strokeStyle = LINE_STYLES[bucket] ?? "";
        ctx.stroke();
      }

      if (pointerAlpha > 0.004) {
        const cursorLinks = collectCursorLinks(stars, pointerX, pointerY, cursorRadius, offset);
        for (let bucket = 0; bucket < CURSOR_BUCKETS; bucket += 1) {
          ctx.beginPath();
          let drew = false;
          for (const link of cursorLinks) {
            if (bucketOf(link.strength * pointerAlpha, CURSOR_BUCKETS) !== bucket) continue;
            ctx.moveTo(link.ax, link.ay);
            ctx.lineTo(link.bx, link.by);
            drew = true;
          }
          if (!drew) continue;
          ctx.strokeStyle = CURSOR_STYLES[bucket] ?? "";
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(pointerX, pointerY, 2.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(240, 246, 255, ${0.4 * pointerAlpha})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(pointerX, pointerY, 9, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200, 216, 245, ${0.07 * pointerAlpha})`;
        ctx.fill();
      }

      for (let bucket = 0; bucket < STAR_STYLES.length; bucket += 1) {
        ctx.beginPath();
        let drew = false;
        for (const star of stars) {
          const screenY = star.y - offset;
          if (screenY < -radius || screenY > height + radius) continue;
          const alpha = (0.28 + star.depth * 0.62) * (0.75 + 0.25 * Math.sin(elapsed * 1.7 + star.phase));
          if (bucketOf(alpha, STAR_STYLES.length) !== bucket) continue;
          const size = 0.7 + star.depth * 1.4;
          ctx.moveTo(star.x + size, screenY);
          ctx.arc(star.x, screenY, size, 0, Math.PI * 2);
          drew = true;
        }
        if (!drew) continue;
        ctx.fillStyle = STAR_STYLES[bucket] ?? "";
        ctx.fill();
      }
    };

    const loop = (timestamp: number): void => {
      frame = 0;
      if (!running) return;
      const delta = lastTimestamp === 0 ? 0 : (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;
      paint(Math.min(delta, MAX_DELTA_SECONDS));
      frame = requestAnimationFrame(loop);
    };

    const start = (): void => {
      if (running || reduceMotion.matches) return;
      running = true;
      lastTimestamp = 0;
      frame = requestAnimationFrame(loop);
    };

    const stop = (): void => {
      running = false;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    };

    const measureDocument = (): number =>
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight);

    // The page is static markup, but fonts and the share/console switch can
    // still change the scroll height, so the world bound is re-read here.
    const resize = (): void => {
      const nextWidth = document.documentElement.clientWidth || window.innerWidth;
      const nextHeight = document.documentElement.clientHeight || window.innerHeight;
      const nextDocHeight = measureDocument();
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);

      if (nextWidth !== width) {
        // Mobile browser chrome resizes the viewport horizontally only on
        // rotation; stretching the field beats reseeding it.
        if (width > 0) {
          const scaleX = nextWidth / width;
          for (const star of stars) star.x *= scaleX;
        }
        width = nextWidth;
      }
      height = nextHeight;
      docHeight = Math.max(nextDocHeight, nextHeight);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scrollY = window.scrollY;
      ensureBands();
      retireBands();

      pointerX = Math.min(pointerX, width);
      pointerY = Math.min(pointerY, height);
      if (reduceMotion.matches) paint(0);
    };

    const onPointerMove = (event: PointerEvent): void => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerTarget = 1;
    };
    const onPointerGone = (): void => {
      pointerTarget = 0;
    };
    // `pointerleave` does not bubble, so it never reaches `window`; `pointerout`
    // with no `relatedTarget` is the reliable "left the document" signal.
    const onPointerOut = (event: PointerEvent): void => {
      if (event.relatedTarget === null) pointerTarget = 0;
    };

    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };

    // Under reduced motion there is no loop to pick the scroll up, so the
    // static frame is repainted on every scroll instead.
    const onScroll = (): void => {
      if (reduceMotion.matches) paint(0);
    };

    const onMotionPreference = (): void => {
      if (reduceMotion.matches) {
        stop();
        pointerTarget = 0;
        pointerAlpha = 0;
        paint(0);
      } else {
        start();
      }
    };

    resize();
    start();

    const observer = new ResizeObserver(resize);
    observer.observe(document.documentElement);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerout", onPointerOut);
    window.addEventListener("blur", onPointerGone);
    document.addEventListener("visibilitychange", onVisibility);
    reduceMotion.addEventListener("change", onMotionPreference);

    return () => {
      stop();
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("blur", onPointerGone);
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMotion.removeEventListener("change", onMotionPreference);
    };
  }, []);

  return <canvas ref={canvasRef} className="lr-constellation" aria-hidden="true" />;
}

export default ConstellationField;
