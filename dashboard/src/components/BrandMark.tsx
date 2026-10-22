import type { ReactElement } from "react";

/**
 * The LianRouter brand mark: three inbound lanes converging into a single
 * outbound arrow — many clients, one route.
 *
 * Drawn as strokes with `currentColor`, so the host surface decides the
 * contrast: the console renders it dark on a white tile (the app-icon look),
 * while the auth panel renders it light on glass.
 */
export function BrandMark(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      {/* three inbound lanes */}
      <path d="M3.4 5.6h3.4" />
      <path d="M3.4 12h3.4" />
      <path d="M3.4 18.4h3.4" />
      {/* converging into one trunk */}
      <path d="M6.8 5.6c3.3 0 3.4 5.1 5.6 6.4" />
      <path d="M6.8 18.4c3.3 0 3.4-5.1 5.6-6.4" />
      <path d="M6.8 12h5.6" />
      {/* one addressed outbound route */}
      <path d="M12.4 12h8.2" />
      <path d="M17.4 8.6 20.8 12l-3.4 3.4" />
    </svg>
  );
}

export default BrandMark;
