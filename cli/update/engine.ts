/**
 * The public surface of the update engine.
 *
 * `checkForUpdate` answers "is there a newer release for this host" without
 * touching the installation; `runUpdate` performs the whole sequence. The split
 * exists because the console shows a modal on the answer and only starts the
 * destructive work when the user picks it — checking must therefore be cheap,
 * side-effect free, and callable on a timer.
 *
 * Progress accounting is deliberately global rather than per phase. Each stage
 * is mapped into a weighted slice of 0..100 (download 0–70, verify 70–78, extract
 * 78–90, install 90–97, restart 97–100) because the download is the only stage
 * whose duration is unknown up front: it is tens of megabytes over an unknown
 * link, while verification, extraction, and installation are seconds of local
 * I/O. Allocating the download most of the bar keeps the visible motion
 * proportional to the time actually spent, and a single bar that never resets
 * between stages reads as one operation instead of five. `emit` additionally
 * clamps to the highest percentage already reported, so a stage that finishes
 * early can never pull the bar backwards.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareVersions } from "./contracts";
import type { UpdateChannel, UpdateInfo, UpdateProgress, UpdateSource } from "./contracts";
import { ChecksumMismatchError, downloadToFile } from "./download";
import { extractArchive } from "./extract";
import { GitHubReleaseSource, pickAssetForPlatform } from "./github-source";
import { installAtomically } from "./install";
import { writeInstalledVersion } from "./version-file";

/** Phase boundaries in the single 0..100 bar; see the module comment. */
const SLICE = {
  downloadEnd: 70,
  verifyEnd: 78,
  extractEnd: 90,
  installEnd: 97,
} as const;

export interface UpdateEngineOptions {
  readonly installRoot: string;
  readonly currentVersion: string;
  readonly channel?: UpdateChannel;
  readonly source?: UpdateSource;
  readonly restart?: () => Promise<void>;
  readonly onProgress: (p: UpdateProgress) => void;
  readonly signal?: AbortSignal;
}

/** Maps a 0..100 in-phase percentage onto a slice of the global bar. */
function withinSlice(start: number, end: number, percent: number): number {
  const clamped = Math.max(0, Math.min(100, percent));
  return start + ((end - start) * clamped) / 100;
}

/**
 * Resolves the newest release for the running platform.
 *
 * Asset selection happens here rather than in `runUpdate` so the modal can show
 * the artifact name and size before the user commits. A release that ships
 * nothing for this host is reported as `available: false` with the latest
 * version still filled in — "a newer release exists but not for you" is a
 * different fact from "you are current", and the UI should be able to say so.
 */
export async function checkForUpdate(opts: {
  currentVersion: string;
  channel?: UpdateChannel;
  source?: UpdateSource;
}): Promise<UpdateInfo> {
  const channel = opts.channel ?? "stable";
  const source = opts.source ?? new GitHubReleaseSource(opts.currentVersion);
  const release = await source.fetchLatest(channel);

  if (release === null) {
    return { current: opts.currentVersion, latest: opts.currentVersion, available: false };
  }

  const asset = pickAssetForPlatform(release.assets, process.platform, process.arch);
  const newer = compareVersions(release.version, opts.currentVersion) > 0;

  return {
    current: opts.currentVersion,
    latest: release.version,
    available: newer && asset !== undefined,
    ...(release.notesUrl === undefined ? {} : { notesUrl: release.notesUrl }),
    ...(release.publishedAt === undefined ? {} : { publishedAt: release.publishedAt }),
    ...(asset === undefined ? {} : { assetUrl: asset.url, assetName: asset.name }),
    ...(asset?.checksum === undefined ? {} : { checksum: asset.checksum }),
  };
}

/**
 * Top-level entries of the extracted payload become the replace list.
 *
 * A release archive is a flattened install root — the binary, `migrations`,
 * `dist/dashboard` — so whatever sits at its top level is exactly what belongs
 * at the top level of the installation. Deriving it from the payload instead of
 * hardcoding a list means a release that adds a folder does not silently fail to
 * install it.
 */
async function payloadEntries(stagedDir: string): Promise<readonly string[]> {
  const entries = await readdir(stagedDir, { withFileTypes: true });
  return entries.map((entry) => entry.name);
}

/**
 * Runs the full update: check, download, verify, extract, install, restart.
 *
 * Every failure is reported as a terminal `error` progress event and then
 * rethrown. Both, because the UI renders from progress events and the caller
 * needs the exception to distinguish an abort from a corrupt artifact — and
 * because swallowing the error after emitting it would let a caller that
 * ignores progress treat a failed update as a finished one.
 */
export async function runUpdate(opts: UpdateEngineOptions): Promise<void> {
  const channel = opts.channel ?? "stable";
  const source = opts.source ?? new GitHubReleaseSource(opts.currentVersion);

  // Monotonicity is enforced here, at the single choke point, rather than
  // trusting every call site to compute a non-decreasing number.
  let highest = 0;
  const emit = (progress: UpdateProgress): void => {
    const percent = Math.max(highest, Math.min(100, progress.percent));
    highest = percent;
    opts.onProgress({ ...progress, percent });
  };

  let stagingDir: string | undefined;

  try {
    emit({ phase: "checking", percent: 0, message: "checking for updates" });
    const info = await checkForUpdate({
      currentVersion: opts.currentVersion,
      channel,
      source,
    });
    if (!info.available || info.assetUrl === undefined || info.assetName === undefined) {
      throw new Error(
        `no update available for ${process.platform}-${process.arch} (latest: ${info.latest})`,
      );
    }
    if (info.checksum === undefined) {
      // Fail closed. An artifact without a digest cannot be distinguished from a
      // tampered one, and this code executes what it downloads.
      throw new Error(`release asset ${info.assetName} has no checksum; refusing to install unverified bytes`);
    }
    emit({ phase: "checking", percent: 0, message: `found ${info.latest}` });

    const workDir = await mkdtemp(join(tmpdir(), "lianrouter-update-"));
    stagingDir = workDir;
    const archivePath = join(workDir, info.assetName);
    const extractDir = join(workDir, "staged");

    emit({
      phase: "downloading",
      percent: 0,
      message: `downloading ${info.assetName}`,
      bytesReceived: 0,
    });
    const download = await downloadToFile({
      url: info.assetUrl,
      destination: archivePath,
      expectedChecksum: info.checksum,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      onProgress: ({ received, total, percent }) => {
        emit({
          phase: "downloading",
          percent: withinSlice(0, SLICE.downloadEnd, percent),
          message: `downloading ${info.assetName}`,
          bytesReceived: received,
          ...(total === undefined ? {} : { bytesTotal: total }),
        });
      },
    });

    // The download already verified the digest inline. This stage exists as an
    // explicit, visible step rather than a silent assertion: it is the moment the
    // artifact is declared trustworthy, and a user watching a bar should see it
    // happen before anything is unpacked.
    emit({
      phase: "verifying",
      percent: SLICE.downloadEnd,
      message: "verifying checksum",
    });
    emit({
      phase: "verifying",
      percent: SLICE.verifyEnd,
      message: `checksum ok (sha256 ${download.sha256.slice(0, 12)}…)`,
      bytesReceived: download.bytes,
    });

    emit({ phase: "extracting", percent: SLICE.verifyEnd, message: "extracting archive" });
    await extractArchive(archivePath, extractDir, ({ percent, message }) => {
      emit({
        phase: "extracting",
        percent: withinSlice(SLICE.verifyEnd, SLICE.extractEnd, percent),
        message,
      });
    });

    const replace = await payloadEntries(extractDir);
    if (replace.length === 0) {
      throw new Error("update payload is empty");
    }

    emit({ phase: "installing", percent: SLICE.extractEnd, message: "installing update" });
    await installAtomically({
      installRoot: opts.installRoot,
      stagedDir: extractDir,
      replace,
      onProgress: ({ percent, message }) => {
        emit({
          phase: "installing",
          percent: withinSlice(SLICE.extractEnd, SLICE.installEnd, percent),
          message,
        });
      },
    });

    // Recorded after the install committed: writing it earlier would claim a
    // version that a rollback then un-installed.
    await writeInstalledVersion(opts.installRoot, {
      version: info.latest,
      installedAt: new Date().toISOString(),
      assetName: info.assetName,
    });

    emit({ phase: "restarting", percent: SLICE.installEnd, message: "restarting gateway" });
    // Absent `restart` is not an error: a caller that supervises the process
    // itself (a wrapper script, a service manager) installs and lets its own
    // supervisor bring the gateway back. The phase is still emitted so the bar
    // reaches the same place either way.
    if (opts.restart !== undefined) {
      await opts.restart();
    }
    emit({ phase: "restarting", percent: 100, message: "restart complete" });
    emit({ phase: "done", percent: 100, message: `updated to ${info.latest}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = error instanceof ChecksumMismatchError
      ? `checksum mismatch: expected ${error.expected.slice(0, 12)}…, received ${error.actual.slice(0, 12)}…`
      : message;
    emit({ phase: "error", percent: highest, message: "update failed", error: reason });
    throw error;
  } finally {
    // The staged tree is scratch space in the temp dir; leaving it behind would
    // accumulate a full copy of the install on every update.
    if (stagingDir !== undefined) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
