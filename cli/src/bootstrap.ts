/**
 * First-run installation of the gateway.
 *
 * The published package is only the launcher. The gateway itself — the compiled
 * executable, `migrations/`, `dist/dashboard/` — is a release artifact, so a
 * machine that has never run LianRouter has an install root with nothing in it.
 * Before this module existed the supervisor spawned `<installRoot>/lianrouter.exe`
 * and the operator got `ENOENT` from `uv_spawn`.
 *
 * The contract with the release feed is the same one the updater uses, and it is
 * deliberately not re-implemented here: `resolveInstallCandidate` answers the
 * install question (newest release for this host, plus its asset) without
 * comparing versions, `downloadToFile` streams it and verifies the sha256 inline,
 * `extractArchive` unpacks into a bounded staging directory, and
 * `installAtomically` swaps the top-level entries with rollback. A second
 * download path would be a second place for the checksum check to rot.
 *
 * Two properties matter more than speed:
 *
 * 1. **The hot path is offline.** Every `lianrouter` run calls this, and the
 *    common case is "already installed". A present binary returns immediately
 *    without constructing a release source, so a machine with no network still
 *    starts.
 * 2. **A failed install says why.** A release whose archive nests its payload
 *    one level deep installs successfully as far as `installAtomically` is
 *    concerned and then leaves the launcher spawning a path that does not
 *    exist — the silent loop this module's final assertion exists to prevent.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UpdateSource } from "../update/contracts";
import { downloadToFile } from "../update/download";
import { resolveInstallCandidate } from "../update/engine";
import { extractArchive } from "../update/extract";
import { UPDATE_REPO } from "../update/github-source";
import { installAtomically } from "../update/install";
import { resolveCurrentVersion, writeInstalledVersion } from "../update/version-file";
import { resolveBinaryPath } from "./paths";

/** Weighted slices of the single 0..100 bar, mirroring the update engine. */
const SLICE = {
  downloadEnd: 70,
  verifyEnd: 78,
  extractEnd: 90,
} as const;

export interface BootstrapProgress {
  readonly phase: string;
  readonly percent: number;
  readonly message: string;
  readonly bytesReceived?: number;
  readonly bytesTotal?: number;
}

export interface BootstrapOptions {
  readonly installRoot: string;
  readonly currentVersion: string;
  /** Called for each human-readable step; defaults to console.log. */
  readonly log?: (line: string) => void;
  readonly onProgress?: (p: BootstrapProgress) => void;
  /**
   * Release feed override. Production leaves it undefined and the engine uses
   * the GitHub source; tests inject a fake so no suite touches the network.
   */
  readonly source?: UpdateSource;
}

export interface BootstrapResult {
  /** Absolute path of the gateway executable that now exists. */
  readonly binaryPath: string;
  readonly version: string;
}

/**
 * Raised when no gateway can be installed for this host.
 *
 * Carries the release page so a caller can point the operator at the place the
 * artifact should have been, and keeps the message to one line: the bin entry
 * prints `lianrouter: <message>` and a multi-line message would look like a
 * stack trace.
 */
export class GatewayNotInstalledError extends Error {
  readonly platform: string;
  readonly arch: string;
  readonly releaseUrl: string;

  constructor(message: string, details: { platform: string; arch: string; releaseUrl: string }) {
    super(message);
    this.name = "GatewayNotInstalledError";
    this.platform = details.platform;
    this.arch = details.arch;
    this.releaseUrl = details.releaseUrl;
  }
}

/** The human-facing releases page, or the release notes when the feed gave one. */
function releasePageUrl(notesUrl: string | undefined): string {
  return notesUrl ?? `https://github.com/${UPDATE_REPO}/releases`;
}

/** Maps a 0..100 in-phase percentage onto a slice of the global bar. */
function withinSlice(start: number, end: number, percent: number): number {
  const clamped = Math.max(0, Math.min(100, percent));
  return start + ((end - start) * clamped) / 100;
}

/** Top-level entries of the extracted payload become the replace list. */
async function payloadEntries(stagedDir: string): Promise<readonly string[]> {
  const entries = await readdir(stagedDir, { withFileTypes: true });
  return entries.map((entry) => entry.name);
}

/**
 * Installs the gateway into `installRoot` when it is not already there.
 *
 * Returns the existing binary untouched when one is present: the version is
 * read from `version.json` (falling back to the compiled-in version), and no
 * release source is constructed at all.
 */
export async function ensureGatewayInstalled(options: BootstrapOptions): Promise<BootstrapResult> {
  const { installRoot, currentVersion } = options;
  const log = options.log ?? ((line: string): void => console.log(line));
  const emit = options.onProgress;

  const binaryPath = resolveBinaryPath(installRoot);
  if (existsSync(binaryPath)) {
    return { binaryPath, version: await resolveCurrentVersion(installRoot, currentVersion) };
  }

  await mkdir(installRoot, { recursive: true });
  log("gateway not installed; fetching the latest release");

  const resolution = await resolveInstallCandidate({
    ...(options.source === undefined ? {} : { source: options.source }),
    clientVersion: currentVersion,
  });
  const platform = process.platform;
  const arch = process.arch;
  const releaseUrl = releasePageUrl(
    resolution.status === "installable"
      ? resolution.candidate.notesUrl
      : resolution.status === "no-asset"
        ? resolution.notesUrl
        : undefined,
  );

  if (resolution.status === "no-release") {
    throw new GatewayNotInstalledError(
      `no LianRouter release published for ${platform}-${arch} yet ` +
        `(the release feed has no published release). See ${releaseUrl}`,
      { platform, arch, releaseUrl },
    );
  }
  if (resolution.status === "no-asset") {
    throw new GatewayNotInstalledError(
      `LianRouter ${resolution.version} has no build for ${platform}-${arch}. ` +
        `Install from source (\`bun run build\`) or check ${releaseUrl}`,
      { platform, arch, releaseUrl },
    );
  }

  // Install whatever this host can run, regardless of how the release version
  // compares to the launcher's own. A launcher that cannot install a gateway is
  // useless, and refusing an older-but-installable build leaves the operator
  // with nothing at all — there is no gateway on disk to be "downgraded" from.
  const { candidate } = resolution;

  if (candidate.checksum === undefined) {
    // Fail closed. The code executes what it downloads, so an artifact that
    // cannot be distinguished from a tampered one is not installed.
    throw new GatewayNotInstalledError(
      `release ${candidate.version} has no sha256 digest for ${candidate.assetName}; ` +
        `refusing to install unverified bytes. See ${releaseUrl}`,
      { platform, arch, releaseUrl },
    );
  }
  const assetUrl = candidate.assetUrl;
  const assetName = candidate.assetName;
  const checksum = candidate.checksum;
  log(`installing LianRouter ${candidate.version} for ${platform}-${arch}`);

  const workDir = await mkdtemp(join(tmpdir(), "lianrouter-bootstrap-"));
  try {
    const archivePath = join(workDir, assetName);
    const stagedDir = join(workDir, "staged");

    // No synthetic "downloading" emit here: `downloadToFile` reports immediately
    // with received=0 and the resolved total, so its first sample is the phase's
    // transition line. Emitting one first would make the non-TTY output show a
    // byte-less line and then suppress the informative one.
    const download = await downloadToFile({
      url: assetUrl,
      destination: archivePath,
      expectedChecksum: checksum,
      onProgress: ({ received, total, percent }) => {
        emit?.({
          phase: "downloading",
          percent: withinSlice(0, SLICE.downloadEnd, percent),
          message: `downloading ${assetName}`,
          bytesReceived: received,
          ...(total === undefined ? {} : { bytesTotal: total }),
        });
      },
    });

    emit?.({ phase: "verifying", percent: SLICE.downloadEnd, message: "verifying checksum" });
    emit?.({
      phase: "verifying",
      percent: SLICE.verifyEnd,
      message: `checksum ok (sha256 ${download.sha256.slice(0, 12)}…)`,
    });

    emit?.({ phase: "extracting", percent: SLICE.verifyEnd, message: "extracting archive" });
    await extractArchive(archivePath, stagedDir, ({ percent, message }) => {
      emit?.({
        phase: "extracting",
        percent: withinSlice(SLICE.verifyEnd, SLICE.extractEnd, percent),
        message,
      });
    });

    const replace = await payloadEntries(stagedDir);
    if (replace.length === 0) {
      throw new GatewayNotInstalledError(
        `release ${candidate.version} for ${platform}-${arch} has an empty archive; nothing to install. See ${releaseUrl}`,
        { platform, arch, releaseUrl },
      );
    }

    emit?.({ phase: "installing", percent: SLICE.extractEnd, message: "installing gateway" });
    await installAtomically({
      installRoot,
      stagedDir,
      replace,
      onProgress: ({ percent, message }) => {
        emit?.({
          phase: "installing",
          percent: withinSlice(SLICE.extractEnd, 100, percent),
          message,
        });
      },
    });

    if (!existsSync(binaryPath)) {
      // The archive installed, but not where the supervisor looks. The usual
      // cause is a release built as `payload/lianrouter.exe` instead of
      // `lianrouter.exe` at the root; naming the entries makes that obvious
      // instead of leaving a spawn error on the next run.
      throw new GatewayNotInstalledError(
        `release ${candidate.version} installed but ${binaryPath} is missing; ` +
          `the archive's top-level entries were ${replace.join(", ")}. ` +
          `A release whose payload is nested one level deep cannot be installed. See ${releaseUrl}`,
        { platform, arch, releaseUrl },
      );
    }

    // After the binary assertion, so a rejected archive never records a version
    // for an install the launcher cannot use.
    await writeInstalledVersion(installRoot, {
      version: candidate.version,
      installedAt: new Date().toISOString(),
      assetName,
    });

    emit?.({ phase: "done", percent: 100, message: `installed ${candidate.version}` });
    return { binaryPath, version: candidate.version };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
