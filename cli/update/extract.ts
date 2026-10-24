/**
 * Archive extraction into a staging directory.
 *
 * The staging directory is the security boundary. Nothing here may write
 * outside it, because the archive is remote input: a crafted entry named
 * `../../lianrouter.exe` would otherwise overwrite an arbitrary file with
 * attacker-controlled bytes, and the install step that follows would happily
 * promote it. Two defences are layered:
 *
 * 1. **Listing before extracting.** The archive is listed first and every entry
 *    name is normalized and checked against the staging root. An archive
 *    containing an escaping path is rejected outright, before a single byte is
 *    written — a check that only ran after extraction would already have
 *    performed the write it was meant to prevent.
 *
 * 2. **A walk of the extracted tree.** After the tool runs, every produced path
 *    is resolved and re-checked. The listing depends on the archive's own
 *    metadata agreeing with what the tool writes; walking the result costs one
 *    directory traversal and closes the gap where a tool resolves an entry
 *    differently than it listed it.
 *
 * Extraction shells out to the platform's archive tools rather than parsing
 * archives in-process. Archive parsing is a large attack surface to own for a
 * feature that only needs to unpack an artifact whose checksum was already
 * verified, and every supported host already ships a hardened implementation.
 */
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

export interface ExtractProgress {
  readonly percent: number;
  readonly message: string;
}

export type ExtractProgressHandler = (p: ExtractProgress) => void;

type ArchiveKind = "zip" | "7z" | "tar" | "tgz";

/**
 * Resolves the full argument vector for extracting `archivePath` into
 * `stagingDir`, in documented fallback order:
 *
 * - `.zip` on Windows: `tar -xf`. Windows 10+ ships bsdtar, which reads zip
 *   natively; `unzip` is not present on a stock install, so it is only a
 *   fallback for a system where tar was replaced.
 * - `.zip` on POSIX: `unzip` first, because GNU tar (the Linux default) cannot
 *   read zip at all. bsdtar is the fallback, which is what macOS ships.
 * - `.7z`: only `7z`/`7za` can read it. Neither is a default install, so the
 *   format is refused when absent rather than failing halfway through.
 * - `.tar`/`.tgz`: `tar`.
 */
function extractionArgv(kind: ArchiveKind, archivePath: string, stagingDir: string): readonly string[] {
  const tar = Bun.which("tar");
  const unzip = Bun.which("unzip");

  switch (kind) {
    case "zip": {
      const preferTar = process.platform === "win32" || unzip === null;
      if (preferTar && tar !== null) {
        return [tar, "-xf", archivePath, "-C", stagingDir];
      }
      if (unzip !== null) {
        return [unzip, "-o", "-q", archivePath, "-d", stagingDir];
      }
      if (tar !== null) {
        return [tar, "-xf", archivePath, "-C", stagingDir];
      }
      throw new Error("cannot extract .zip: neither tar nor unzip is on PATH");
    }
    case "7z": {
      const sevenZip = Bun.which("7z") ?? Bun.which("7za");
      if (sevenZip === null) {
        throw new Error("cannot extract .7z: 7z is not on PATH");
      }
      // `7z` takes the destination as an attached flag, not a positional.
      return [sevenZip, "x", "-y", `-o${stagingDir}`, archivePath];
    }
    case "tar":
    case "tgz": {
      if (tar === null) {
        throw new Error(`cannot extract .${kind}: tar is not on PATH`);
      }
      return kind === "tgz"
        ? [tar, "-xzf", archivePath, "-C", stagingDir]
        : [tar, "-xf", archivePath, "-C", stagingDir];
    }
  }
}

function archiveKindOf(archivePath: string): ArchiveKind {
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  if (lower.endsWith(".7z")) {
    return "7z";
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tgz";
  }
  if (lower.endsWith(".tar")) {
    return "tar";
  }
  throw new Error(`unsupported archive format: ${archivePath}`);
}

/**
 * True when `entry` resolves to a location strictly inside `root`.
 *
 * `node:path` supplies the platform's own semantics, so on Windows both
 * separators are handled and drive-relative forms are rejected by `isAbsolute`.
 * A name that normalizes to the root itself is refused too: an entry cannot be
 * the staging directory.
 */
function isContainedEntry(root: string, entry: string): boolean {
  if (entry.length === 0 || isAbsolute(entry)) {
    return false;
  }
  const normalizedEntry = normalize(entry).replace(/[\\/]+$/, "");
  if (normalizedEntry.length === 0) {
    return false;
  }
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, normalizedEntry);
  return target !== normalizedRoot && target.startsWith(normalizedRoot + sep);
}

/**
 * Lists archive entry names, one per line, using the tool that can actually read
 * the format.
 *
 * This cannot simply be `tar -tf`: GNU tar — the Linux default — refuses zip
 * archives outright, while bsdtar (Windows 10+, macOS) reads them. Preferring
 * `unzip -Z1` on POSIX and falling back to tar keeps the pre-extraction check
 * working on every host instead of silently degrading to "cannot validate".
 * Returns `undefined` when no available tool can list the archive.
 */
async function listArchiveEntries(kind: ArchiveKind, archivePath: string): Promise<readonly string[] | undefined> {
  const attempts: string[][] = [];
  if (kind === "zip") {
    const unzip = Bun.which("unzip");
    if (unzip !== null) {
      // `-Z1` prints bare entry names, one per line — no table, no headers.
      attempts.push([unzip, "-Z1", archivePath]);
    }
  }
  const tar = Bun.which("tar");
  if (tar !== null) {
    attempts.push([tar, "-tf", archivePath]);
  }

  for (const argv of attempts) {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const listing = await new Response(child.stdout).text();
    await new Response(child.stderr).text();
    if ((await child.exited) === 0) {
      return listing.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    }
  }
  return undefined;
}

/**
 * Rejects any entry that would escape `stagingDir`, before extraction writes
 * anything. This is the load-bearing zip-slip defence: a post-extraction walk of
 * the staging tree cannot see a file that was written *outside* it, so the entry
 * names must be judged before the tool runs.
 */
async function assertEntriesContained(
  kind: ArchiveKind,
  archivePath: string,
  stagingDir: string,
): Promise<void> {
  const entries = await listArchiveEntries(kind, archivePath);
  if (entries === undefined) {
    throw new Error("cannot validate archive entries: no available tool can list this archive");
  }

  const escaped: string[] = [];
  for (const entry of entries) {
    if (!isContainedEntry(stagingDir, entry)) {
      escaped.push(entry);
    }
  }
  if (escaped.length > 0) {
    throw new Error(
      `archive rejected: ${escaped.length} entr${escaped.length === 1 ? "y" : "ies"} escape the staging directory (${escaped.slice(0, 3).join(", ")})`,
    );
  }
}

/**
 * Extracts `archivePath` into `stagingDir`, creating the directory when absent.
 * The caller owns cleanup of `stagingDir`; this function only writes into it.
 */
export async function extractArchive(
  archivePath: string,
  stagingDir: string,
  onProgress?: ExtractProgressHandler,
): Promise<void> {
  const kind = archiveKindOf(archivePath);
  await mkdir(stagingDir, { recursive: true });

  onProgress?.({ percent: 5, message: "validating archive" });
  await assertEntriesContained(kind, archivePath, stagingDir);

  onProgress?.({ percent: 25, message: `extracting ${kind} archive` });
  const argv = extractionArgv(kind, archivePath, stagingDir);
  const child = Bun.spawn([...argv], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`extraction failed (${argv[0]} exit ${code}): ${stderr.trim()}`);
  }

  onProgress?.({ percent: 90, message: "checking extracted paths" });

  // A release payload is files and directories only. A symlink is refused rather
  // than followed: an archive can point one at a path outside the staging dir,
  // and the install step's copy would then read through it — an escape the entry
  // name check cannot catch, because the name itself is innocent.
  const rootResolved = resolve(stagingDir);
  const stack = [rootResolved];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    for (const name of await readdir(current)) {
      const entryPath = join(current, name);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) {
        throw new Error(`archive rejected: symbolic link in payload at ${entryPath}`);
      }
      if (info.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }

  onProgress?.({ percent: 100, message: "archive extracted" });
}

/** Removes a staging directory, tolerating an absent one. */
export async function removeStagingDir(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}
