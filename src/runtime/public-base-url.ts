// Process-lifetime override for the address recipients are told to use.
//
// A quick tunnel's host is minted at runtime and belongs to the child process:
// it exists only while that process lives, so it can never be a stored setting.
// This module owns that one piece of mutable state and nothing else; the
// operator-configured `LIANROUTER_PUBLIC_BASE_URL` stays authoritative in
// `src/config.ts`, which remains a leaf and knows nothing about tunnels.

import { resolvePublicBaseUrl } from "../config";

let runtimePublicBaseUrl: string | null = null;

/**
 * Sets (or clears, with `null`) the tunnel URL that outranks the environment.
 *
 * Trailing slashes are trimmed here as well as in `resolvePublicBaseUrl`: every
 * caller splices this value as `${base}/share/...`, so a stray slash would
 * produce a double-slash path.
 */
export function setRuntimePublicBaseUrl(url: string | null): void {
  runtimePublicBaseUrl = url === null ? null : url.replace(/\/+$/, "");
}

/** The tunnel URL currently advertised, or `null` when no tunnel is running. */
export function getRuntimePublicBaseUrl(): string | null {
  return runtimePublicBaseUrl;
}

/**
 * The origin enrollment links and share payloads should advertise.
 *
 * A live tunnel wins over the environment because it is the address that
 * actually resolves right now: the operator started it from the console
 * precisely to stop hand-editing `.env`. With no tunnel the configured value
 * applies, and with neither the caller falls back to the request origin.
 */
export function resolveEffectivePublicBaseUrl(): string | undefined {
  return runtimePublicBaseUrl ?? resolvePublicBaseUrl();
}
