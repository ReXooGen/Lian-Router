import { useEffect, useRef, type ReactElement } from "react";
import type { OrbitHandle, OrbitVariant } from "./orbit-scene";
import "./orbit.css";

export interface OrbitObjectProps {
  /** Which procedural variant to draw. */
  readonly variant?: OrbitVariant;
  /** Accessible description; the canvas itself is decorative. */
  readonly label: string;
  readonly className?: string;
}

/**
 * Mounts a procedural Three.js object that can be grabbed and turned.
 *
 * Interaction is the zslabs pattern: hold to take over, drag to spin, release
 * to hand rotation back to the idle drift. The canvas is focusable and
 * labelled so the gesture is reachable without a pointer, and it is skipped
 * entirely when the reader prefers reduced motion — in that case the canvas
 * still draws, it just does not animate.
 *
 * Three.js loads dynamically: it is the largest dependency on the page and it
 * is decoration, so the surrounding UI paints first.
 */
export function OrbitObject({ variant = "core", label, className = "" }: OrbitObjectProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let handle: OrbitHandle | null = null;
    let cancelled = false;

    const publish = (): void => {
      if (handle === null) return;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      handle.setProgress(scrollable > 0 ? window.scrollY / scrollable : 0);
    };

    window.addEventListener("scroll", publish, { passive: true });
    window.addEventListener("resize", publish);

    void import("./orbit-scene")
      .then(({ createOrbitObject }) => {
        if (cancelled) return;
        handle = createOrbitObject(canvas, variant);
        publish();
      })
      .catch(() => {
        // No WebGL: the surrounding panel keeps its own styling and nothing
        // here is load-bearing.
      });

    return () => {
      cancelled = true;
      window.removeEventListener("scroll", publish);
      window.removeEventListener("resize", publish);
      handle?.dispose();
    };
  }, [variant]);

  return (
    <div className={`orbit-object ${className}`.trim()}>
      <canvas
        ref={canvasRef}
        className="orbit-object-canvas"
        role="img"
        aria-label={label}
        tabIndex={0}
      />
    </div>
  );
}

export default OrbitObject;
