import { useEffect, useRef, type RefObject } from "react";

/**
 * Reveals an element as it scrolls into view.
 *
 * Returns a ref to attach to the element and a class string to spread onto it.
 * The element starts hidden only once the observer is armed, and it reveals
 * immediately when `IntersectionObserver` is unavailable or the reader prefers
 * reduced motion — so content is never trapped behind an effect that did not
 * run.
 */
export function useScrollReveal<T extends HTMLElement>(): {
  readonly ref: RefObject<T | null>;
  readonly className: string;
} {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof IntersectionObserver === "undefined") {
      element.classList.add("is-revealed");
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-revealed");
          observer.unobserve(entry.target);
        }
      },
      // The generous top margin matters: an anchor link can jump past a whole
      // section, and those panels never intersect the viewport on the way. With
      // the observation area extended upward, anything above the reader counts
      // as intersecting and reveals instead of staying at opacity 0.
      { rootMargin: "9999px 0px -12% 0px", threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, className: "lr-reveal" };
}
