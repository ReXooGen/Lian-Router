/**
 * Records which release is installed on disk.
 *
 * The compiled binary bakes in a version at build time, but a binary that
 * installed an update over itself is no longer the artifact it was compiled
 * from. Without a file, `--version` after an update would keep reporting the
 * version the running process was built with, and the next check would compare
 * the *new* release against the *old* number and offer the same update forever.
 *
 * Everything here tolerates absence and corruption: a missing file means "never
 * updated", and a half-written one (a crash between truncate and write) must not
 * break startup. Both return `undefined`, and the caller falls back to the
 * compiled-in version.
 */
import { join } from "node:path";

import { normalizeVersion } from "./contracts";

export interface InstalledVersionRecord {
  readonly version: string;
  readonly installedAt: string;
  readonly assetName: string;
}

const VERSION_FILE_NAME = "version.json";

function versionFilePath(installRoot: string): string {
  return join(installRoot, VERSION_FILE_NAME);
}

/**
 * Reads `<installRoot>/version.json`, or `undefined` when it is missing, not
 * valid JSON, or missing the required `version` field.
 *
 * The fields are validated individually rather than trusting a cast: this file
 * lives in a user-writable directory, so it is external input like any other,
 * and a hand-edited `version: 5` must not reach the comparator as a number.
 */
export async function readInstalledVersion(
  installRoot: string,
): Promise<InstalledVersionRecord | undefined> {
  const file = Bun.file(versionFilePath(installRoot));
  if (!(await file.exists())) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const { version, installedAt, assetName } = parsed as {
    readonly version?: unknown;
    readonly installedAt?: unknown;
    readonly assetName?: unknown;
  };
  if (typeof version !== "string" || version.trim().length === 0) {
    return undefined;
  }
  // Records written before the version seam existed hold the release tag with
  // its `v` (`v2.0.0`). Normalizing on read makes such a record comparable and
  // displayable without a second normalization convention elsewhere; a record
  // that normalizes to nothing is as unusable as one with no version at all.
  const normalized = normalizeVersion(version);
  if (normalized.length === 0) {
    return undefined;
  }
  return {
    version: normalized,
    installedAt: typeof installedAt === "string" ? installedAt : "",
    assetName: typeof assetName === "string" ? assetName : "",
  };
}

/**
 * Writes the installed-version record.
 *
 * Written directly rather than through a temp file and rename: this file is
 * advisory — a torn write degrades to `undefined`, which is the same state as a
 * first run — while a temp-and-rename adds a second failure mode (a leftover
 * `.tmp` that never got promoted) for a file whose worst case is already benign.
 */
export async function writeInstalledVersion(
  installRoot: string,
  record: InstalledVersionRecord,
): Promise<void> {
  // Stored bare so the file, the comparator, and the display site agree: the
  // `v` is presentation, added by whoever renders the number. A caller handing
  // in a tag (`v2.1.0`) gets `2.1.0` on disk, which is what keeps a legacy or
  // hand-edited record from producing `vv` after the next read.
  const payload: InstalledVersionRecord = {
    version: normalizeVersion(record.version),
    installedAt: record.installedAt,
    assetName: record.assetName,
  };
  await Bun.write(versionFilePath(installRoot), `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Version strings that mean "the build did not know its own version".
 *
 * `0.0.0` is what a placeholder `package.json` produces, `dev` and `unknown` are
 * what a source run reports. Comparing against any of them would make every
 * release look newer, so they are treated as absent rather than as a real
 * number — a false "update available" is worse than a check that says nothing.
 */
const UNKNOWN_VERSIONS = new Set(["", "0.0.0", "dev", "unknown"]);

/**
 * Resolves which version to compare against.
 *
 * The compiled-in version wins when it is real: it describes the artifact the
 * process is actually running. It is only consulted when that value is a
 * placeholder, which is the case in a development run and in a binary built
 * before versioning was wired in. The on-disk record is the fallback because a
 * binary that installed an update over itself reports the version it was
 * *built* with, not the one now on disk.
 */
export async function resolveCurrentVersion(
  installRoot: string,
  compiledVersion: string,
): Promise<string> {
  if (!UNKNOWN_VERSIONS.has(compiledVersion.trim())) {
    return compiledVersion.trim();
  }
  const record = await readInstalledVersion(installRoot);
  return record?.version ?? compiledVersion.trim();
}
