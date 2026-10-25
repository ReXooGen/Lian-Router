/**
 * The launcher package's own update check.
 *
 * The gateway archive and the `lianrouter` package are published separately:
 * `checkForUpdate()` compares a *gateway* release against `version.json`, so a
 * newer launcher on the registry is invisible to it. This module answers the
 * other question — "is the package that is running right now still the newest
 * published one" — and nothing else. It performs no install: the instruction it
 * returns is the package-manager command the operator already uses.
 *
 * Two properties are load-bearing:
 *
 * 1. **It never throws and never blocks for long.** The result is a
 *    discriminated union, including an explicit `unavailable` arm, because "the
 *    registry could not be asked" and "you are current" are different facts and
 *    a startup notice must not turn the second into the first. The deadline is
 *    short on purpose: this call is started alongside the gateway boot, and a
 *    slow registry must never be visible in the time it takes to reach the menu.
 *
 * 2. **The endpoint is overridable, and the override is read once.** A mirrored
 *    or offline registry points the check elsewhere; reading the variable per
 *    request would let a mid-run change make two checks disagree about which
 *    host is authoritative, which is the same failure mode the release feed
 *    override documents.
 */
import { compareVersions, normalizeVersion } from "./contracts";

/** The published launcher package; the manifest's own `name` is `lianrouter`. */
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/lianrouter/latest";

/**
 * CLI-only override for the manifest URL. Read once at module load so the value
 * is stable for the process.
 */
const REGISTRY_URL = (() => {
  const override = process.env.LIANROUTER_NPM_REGISTRY;
  return override !== undefined && override.trim().length > 0
    ? override.trim()
    : DEFAULT_REGISTRY_URL;
})();

/**
 * Deadline for the manifest request. Deliberately shorter than the release
 * feed's: this check runs on every startup, so it has to fit inside the gateway
 * boot rather than after it.
 */
const REQUEST_TIMEOUT_MS = 2_500;

/** Set to `1` to skip every startup update check, this one included. */
export const UPDATE_CHECK_DISABLE_ENV = "LIANROUTER_NO_UPDATE_CHECK";

/**
 * Whether startup update checking is switched off.
 *
 * This is the single authority for the switch: the launcher asks here before it
 * starts either check, so the release feed and the registry can never disagree
 * about whether the operator wanted to be contacted at all.
 */
export function updateCheckDisabled(): boolean {
  return process.env[UPDATE_CHECK_DISABLE_ENV] === "1";
}

/** Outcome of a launcher version check. Never thrown, always returned. */
export type LauncherUpdateResult =
  | { readonly status: "current"; readonly latest: string }
  | { readonly status: "outdated"; readonly latest: string; readonly current: string }
  | { readonly status: "unavailable"; readonly reason: string };

export interface LauncherUpdateCheck {
  /** The running launcher's version, compared against the published one. */
  readonly currentVersion: string;
  /** Test seam; the production path uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam for a mirrored registry; defaults to the module-level URL. */
  readonly registryUrl?: string;
}

/**
 * Shape accepted as a published version. `compareVersions` already tolerates
 * missing segments and junk, which is right for release tags; a registry
 * manifest is machine-written, so a body that is not a version at all is
 * treated as an unusable answer instead of being coerced into `0.0.0`.
 */
const VERSION_SHAPE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isSemverish(value: unknown): value is string {
  return typeof value === "string" && VERSION_SHAPE.test(normalizeVersion(value));
}

/**
 * Compares the running launcher against the newest published `lianrouter`.
 *
 * Returns `outdated` only for a strictly newer published version; an equal or
 * older manifest is `current`, and anything that prevents an answer is
 * `unavailable` with a reason the caller may ignore.
 */
export async function checkLauncherVersion(
  options: LauncherUpdateCheck,
): Promise<LauncherUpdateResult> {
  const url = options.registryUrl ?? REGISTRY_URL;
  const doFetch = options.fetchImpl ?? fetch;

  // The deadline races the request rather than only aborting it, so an injected
  // or misbehaving implementation that ignores the signal still returns. The
  // abort is kept as well: a real `fetch` should drop its socket instead of
  // holding the process open for the rest of the deadline.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`registry did not answer within ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);
  });

  let response: Response;
  try {
    response = await Promise.race([
      doFetch(url, { headers: { Accept: "application/json" }, signal: controller.signal }),
      deadline,
    ]);
  } catch (error) {
    return {
      status: "unavailable",
      reason: `registry unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return { status: "unavailable", reason: `registry returned ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "unavailable", reason: "registry returned a non-JSON body" };
  }

  if (typeof payload !== "object" || payload === null || !("version" in payload)) {
    return { status: "unavailable", reason: "registry returned no usable version" };
  }
  const published = payload.version;
  if (!isSemverish(published)) {
    return { status: "unavailable", reason: "registry returned no usable version" };
  }

  const latest = normalizeVersion(published);
  const current = normalizeVersion(options.currentVersion);
  return compareVersions(latest, current) > 0
    ? { status: "outdated", latest, current }
    : { status: "current", latest };
}
