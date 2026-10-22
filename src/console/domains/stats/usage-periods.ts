/**
 * Canonical usage-period presets: the fixed options the dashboard offers.
 * A subset of what `isSupportedUsagePeriod` accepts (any `\d+[hd]` token) —
 * the single home for the preset list + type so the UI never hardcodes its
 * own union.
 *
 * This module is intentionally free of Elysia / node:crypto so the dashboard
 * codegen can import the constant without bundling the backend graph.
 */
export const USAGE_PERIODS = ["1h", "6h", "12h", "24h", "7d", "30d", "all"] as const;

/** One dashboard usage-period preset. */
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

/**
 * Breakdown dimensions the usage endpoint accepts. One runtime tuple, because
 * three layers read it: the route table registers one `by-<dimension>` path per
 * member, the operations validator rejects anything outside it, and the
 * dashboard's `Dimension` union re-exports it (pinned by
 * `dashboard/src/usage-dimensions-parity.test.ts`).
 *
 * Lives beside the period presets, not in `contracts.ts`: the dashboard imports
 * this value at runtime, and `contracts.ts` pulls in Elysia plus `node:crypto`.
 */
export const USAGE_DIMENSIONS = ["model", "provider", "key", "client", "client_ip"] as const;

/** One usage breakdown dimension. */
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

