import { useEffect, useRef, type ReactElement } from "react";

/**
 * A hairline progress bar for the top of the landing page.
 *
 * Scroll-driven, and deliberately the only element besides the hero object
 * that reads scroll position: it publishes `--lr-scroll` on the document root
 * so other rules can key off the same value without each installing its own
 * listener.
 */
export function ScrollProgress(): ReactElement {
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (bar === null) return;

    let frame = 0;
    const update = (): void => {
      frame = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const progress = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
      bar.style.transform = `scaleX(${progress})`;
      document.documentElement.style.setProperty("--lr-scroll", String(progress));
    };

    // Coalesce scroll events into one write per frame: the bar is a paint-only
    // effect and does not need a write per event.
    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
      document.documentElement.style.removeProperty("--lr-scroll");
    };
  }, []);

  return (
    <div className="lr-progress" aria-hidden={true}>
      <div ref={barRef} className="lr-progress-bar" />
    </div>
  );
}

export default ScrollProgress;
