import type { NetworkPoolResponse } from "./contracts";

/**
 * Human-readable pool name for anything that renders a pool the API returned
 * only as an id (an API key's egress, an account's binding).
 *
 * A bare uuid tells the operator nothing about which egress they are looking
 * at, and the label must be resolved from the pool list at render time so a
 * renamed pool cannot leave a stale name on a key.
 */
export function networkPoolLabel(pool: NetworkPoolResponse): string {
  if (pool.label) return pool.label;
  const raw = pool.endpoint ?? "";
  const withoutScheme = raw.includes("://") ? raw.slice(raw.indexOf("://") + 3) : raw;
  return withoutScheme || pool.id;
}
