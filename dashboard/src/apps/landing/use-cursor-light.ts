import { useEffect, useRef } from "react";

/**
 * Cursor-tracked light for a card.
 *
 * While the pointer is over the element, its
 * position is published as `--mx`/`--my` percentages and its offset from centre
 * as `--rx`/`--ry` degrees. The stylesheet turns those into a highlight that
 * tracks the pointer and a slight 3D tilt, so the panel reads as a physical
 * surface catching light rather than a flat rectangle.
 *
 * Two details worth keeping:
 *
 * - Writes are coalesced into one animation frame. `pointermove` fires far more
 *   often than the compositor paints, and writing a custom property per event
 *   forces style recalculation each time.
 * - The variables are removed on leave, so a card that was tilted or lit
 *   returns to its resting state instead of keeping the last pointer position.
 */
export function useCursorLight<T extends HTMLElement>(): {
  readonly ref: React.RefObject<T | null>;
} {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    // A pointer-driven effect is meaningless without a pointer, and it is the
    // kind of motion the reduced-motion preference exists to suppress.
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let nextX = 0;
    let nextY = 0;

    const apply = (): void => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const px = (nextX - rect.left) / rect.width;
      const py = (nextY - rect.top) / rect.height;
      element.style.setProperty("--mx", `${px * 100}%`);
      element.style.setProperty("--my", `${py * 100}%`);
      // Tilt stays subtle: 4 degrees reads as depth, more reads as a gimmick.
      element.style.setProperty("--ry", `${(px - 0.5) * 4}deg`);
      element.style.setProperty("--rx", `${(py - 0.5) * -4}deg`);
    };

    const onMove = (event: PointerEvent): void => {
      nextX = event.clientX;
      nextY = event.clientY;
      if (frame !== 0) return;
      frame = requestAnimationFrame(apply);
    };

    const onLeave = (): void => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      element.style.removeProperty("--mx");
      element.style.removeProperty("--my");
      element.style.removeProperty("--rx");
      element.style.removeProperty("--ry");
    };

    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerleave", onLeave);
    return () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerleave", onLeave);
      if (frame !== 0) cancelAnimationFrame(frame);
      onLeave();
    };
  }, []);

  return { ref };
}

export default useCursorLight;
