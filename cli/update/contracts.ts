/**
 * Shared vocabulary for the self-update engine.
 *
 * Every other module in `cli/update` speaks these types, and the console UI
 * imports them to render the update modal without knowing how a release is
 * fetched or how a binary is replaced. Keeping the progress phases here (rather
 * than in the engine) means the UI can switch on a closed union and the compiler
 * catches a phase the renderer forgot.
 */

/** Result of a version check, already resolved for the running platform. */
export interface UpdateInfo {
  readonly current: string;
  readonly latest: string;
  readonly available: boolean;
  readonly notesUrl?: string;
  readonly publishedAt?: string;
  readonly assetUrl?: string;
  readonly assetName?: string;
  readonly checksum?: string;
}

/**
 * Ordered stages of an update. The UI renders one label per phase; the engine
 * emits them in this order and never moves backwards.
 */
export type UpdatePhase =
  | "checking"
  | "downloading"
  | "verifying"
  | "extracting"
  | "installing"
  | "restarting"
  | "done"
  | "error";

/**
 * One progress sample. `percent` is the *total* update percentage (0..100), not
 * a per-phase number: the engine maps each phase into a weighted slice so a bar
 * driven straight from this field never jumps backwards between stages.
 */
export interface UpdateProgress {
  readonly phase: UpdatePhase;
  readonly percent: number;
  readonly message: string;
  readonly bytesReceived?: number;
  readonly bytesTotal?: number;
  readonly error?: string;
}

export type UpdateChannel = "stable" | "beta";

export interface UpdateSource {
  /** Returns the newest release, or null when the channel has none. */
  fetchLatest(channel: UpdateChannel): Promise<RawRelease | null>;
}

/** A release as the source sees it, before platform asset selection. */
export interface RawRelease {
  readonly version: string;
  readonly notesUrl?: string;
  readonly publishedAt?: string;
  readonly assets: readonly ReleaseAsset[];
}

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  readonly size: number;
  readonly checksum?: string;
}

interface ParsedVersion {
  readonly core: readonly number[];
  readonly prerelease: readonly string[];
}

/** Strips surrounding whitespace and a leading `v`, so tags and package versions compare alike. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^[vV]/, "");
}

function parseVersion(input: string): ParsedVersion {
  const normalized = normalizeVersion(input);
  // Build metadata is explicitly excluded from precedence ordering, so it is
  // dropped before parsing rather than compared as if it were a prerelease.
  const withoutBuild = normalized.split("+", 1)[0] ?? "";
  const dash = withoutBuild.indexOf("-");
  const corePart = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const prereleasePart = dash === -1 ? "" : withoutBuild.slice(dash + 1);

  // Missing segments are treated as zero, so `2.0` and `2.0.0` are equal. A
  // non-numeric segment (a malformed tag) contributes zero instead of throwing:
  // a release feed with one bad tag must not break the whole check.
  const core = corePart.split(".").map((segment) => {
    const digits = /^\d+/.exec(segment)?.[0];
    return digits === undefined ? 0 : Number.parseInt(digits, 10);
  });
  const prerelease = prereleasePart
    .split(".")
    .filter((segment) => segment.length > 0);

  return { core: core.length === 0 ? [0] : core, prerelease };
}

/**
 * Strict semver-ish precedence: returns -1 when `a < b`, 1 when `a > b`, 0 when
 * equal. Handles `v` prefixes, missing segments, build metadata, and prerelease
 * tags with semver's rule that a release outranks any of its prereleases
 * (`2.0.0-beta.3 < 2.0.0`) and numeric identifiers sort below alphanumeric ones.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  const coreLength = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < coreLength; index += 1) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  // A version without a prerelease tag is the final release and outranks one.
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }

  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    // Fewer identifiers means lower precedence when all shared ones match.
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const diff = Number(leftPart) - Number(rightPart);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric) {
      return -1;
    }
    if (rightNumeric) {
      return 1;
    }
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }

  return 0;
}
