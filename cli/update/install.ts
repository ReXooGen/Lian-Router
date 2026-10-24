/**
 * Atomic replacement of the installation tree, with rollback.
 *
 * Replacing the binary and its data folders is the one irreversible step in the
 * update, and the process doing it is the process being replaced. Two policies
 * follow from that:
 *
 * **Move, then copy, then commit.** Each target is renamed into a timestamped
 * backup directory first. A rename on the same volume is a metadata operation —
 * it is fast, it does not duplicate the tree, and it means the old bytes still
 * exist untouched while the new ones are written. Copying the staged files in
 * afterwards leaves a window where a target is half-written, which is why the
 * window is bounded by the backup: any failure inside it restores every moved
 * path from the backup and the install is indistinguishable from never having
 * run.
 *
 * **Rollback is unconditional and ordered.** Restoration walks the same list in
 * reverse, removes whatever partial content the failed copy left at the
 * destination, and renames the original back. A rollback that stops at the first
 * error would leave the installation in a state that is neither old nor new.
 *
 * **A source checkout is not an installation.** Installing over the repository
 * would replace `src/` and the working tree with release artifacts, destroying
 * uncommitted work and leaving a tree that no longer builds. `assertNotDevCheckout`
 * refuses that case by name.
 */
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Directory (under the install root) holding rollback copies. */
const BACKUP_DIR_NAME = ".backup";

export interface InstallOptions {
  readonly installRoot: string;
  readonly stagedDir: string;
  /** Relative paths to replace, e.g. ["lianrouter.exe", "migrations", "dist/dashboard"] */
  readonly replace: readonly string[];
  readonly onProgress?: (p: { percent: number; message: string }) => void;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rejects a target that resolves outside `root`. The `replace` list is
 * configuration, but it is configuration that names files to delete and
 * overwrite, so a `..` in it must fail loudly rather than reach the filesystem.
 */
function assertRelativeTarget(root: string, target: string): void {
  const resolved = resolve(root, target);
  const resolvedRoot = resolve(root);
  if (resolved === resolvedRoot || !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error(`install target escapes the install root: ${target}`);
  }
}

/**
 * Refuses to install over a development checkout.
 *
 * Detection is deliberately narrow: a `.git` directory beside the install root
 * *and* a `src/main.ts` inside it. Either alone is not proof — a packaged
 * install could ship a `.git` for provenance, and a nested project could have
 * `src/main.ts` without being this repository — but together they identify the
 * shape of a source tree, and the cost of a false refusal is a clear message
 * versus the cost of a false accept being a destroyed working tree.
 */
export async function assertNotDevCheckout(installRoot: string): Promise<void> {
  const root = resolve(installRoot);
  const [hasGit, hasEntry] = await Promise.all([
    pathExists(join(root, ".git")),
    pathExists(join(root, "src", "main.ts")),
  ]);
  if (hasGit && hasEntry) {
    throw new Error(
      `refusing to self-update ${root}: it is a source checkout (.git and src/main.ts present). ` +
        "Build locally with `bun run build` instead of installing a release over the working tree.",
    );
  }
}

/**
 * Replaces `options.replace` inside `installRoot` with the matching entries from
 * `stagedDir`, atomically per the module comment.
 */
export async function installAtomically(options: InstallOptions): Promise<void> {
  const root = resolve(options.installRoot);
  const staged = resolve(options.stagedDir);
  const { replace, onProgress } = options;

  if (replace.length === 0) {
    throw new Error("nothing to install: replace list is empty");
  }
  await assertNotDevCheckout(root);

  // Timestamped rather than fixed so a previous crashed run's backup is never
  // overwritten by the next attempt; the stale one is left for the user to
  // inspect and is not deleted by this function.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(root, BACKUP_DIR_NAME, stamp);

  const moved: string[] = [];
  onProgress?.({ percent: 0, message: "preparing rollback copies" });

  try {
    for (const target of replace) {
      assertRelativeTarget(root, target);
      const destination = join(root, target);
      const backup = join(backupRoot, target);

      if (await pathExists(destination)) {
        await mkdir(dirname(backup), { recursive: true });
        await rename(destination, backup);
        moved.push(target);
      }
      // A target with no existing installation (first run, new folder in a
      // release) simply has nothing to back up; the copy below creates it.
    }

    const total = replace.length;
    for (const [index, target] of replace.entries()) {
      const destination = join(root, target);
      const source = join(staged, target);
      if (!(await pathExists(source))) {
        // Missing staged content is a broken release, not a recoverable state:
        // continuing would leave a target deleted and unreplaced.
        throw new Error(`staged payload is missing ${relative(staged, source)}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true, force: true });
      const percent = Math.floor(((index + 1) / total) * 100);
      onProgress?.({ percent, message: `installed ${target}` });
    }
  } catch (error) {
    // Reverse order so nested paths unwind before their parents, mirroring how
    // they were taken apart.
    for (const target of [...moved].reverse()) {
      const destination = join(root, target);
      const backup = join(backupRoot, target);
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      await rename(backup, destination).catch(() => undefined);
    }
    // Targets that had no original are removed: they did not exist before this
    // attempt, so leaving a partial copy behind would be a change we failed to
    // roll back.
    for (const target of replace) {
      if (!moved.includes(target)) {
        await rm(join(root, target), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    throw error;
  }

  onProgress?.({ percent: 100, message: "install complete" });
  // Only after every target landed. Deleting the backup earlier would remove the
  // rollback source while a later target could still fail.
  await rm(backupRoot, { recursive: true, force: true });
}
