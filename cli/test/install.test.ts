import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertNotDevCheckout, installAtomically, sweepBackups } from "../update/install";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-install-test-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Builds an install root and a staged payload that both contain the same layout,
 * with distinguishable content, so a test can prove which one ended up on disk.
 */
async function fixture(): Promise<{ root: string; staged: string }> {
  const base = await tempDir();
  const root = join(base, "install");
  const staged = join(base, "staged");

  await mkdir(join(root, "migrations"), { recursive: true });
  await mkdir(join(staged, "migrations"), { recursive: true });

  await writeFile(join(root, "lianrouter.exe"), "OLD BINARY BYTES");
  await writeFile(join(root, "migrations", "0001_init.sql"), "OLD MIGRATION");

  await writeFile(join(staged, "lianrouter.exe"), "NEW BINARY BYTES");
  await writeFile(join(staged, "migrations", "0001_init.sql"), "NEW MIGRATION");

  return { root, staged };
}

/** True for a file *or* a directory: `Bun.file().exists()` is false for dirs. */
async function exists(target: string): Promise<boolean> {
  return existsSync(target);
}

describe("installAtomically", () => {
  it("replaces every listed target and deletes the backup directory", async () => {
    const { root, staged } = await fixture();
    const progress: number[] = [];

    await installAtomically({
      installRoot: root,
      stagedDir: staged,
      replace: ["lianrouter.exe", "migrations"],
      onProgress: (p) => progress.push(p.percent),
    });

    expect(await readFile(join(root, "lianrouter.exe"), "utf-8")).toBe("NEW BINARY BYTES");
    expect(await readFile(join(root, "migrations", "0001_init.sql"), "utf-8")).toBe("NEW MIGRATION");
    // The rollback source must not survive a successful install.
    expect(await exists(join(root, ".backup"))).toBe(false);
    expect(progress.at(-1)).toBe(100);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]!).toBeGreaterThanOrEqual(progress[index - 1]!);
    }
  });

  it("creates a target that did not exist in the previous installation", async () => {
    const { root, staged } = await fixture();
    await mkdir(join(staged, "dist", "dashboard"), { recursive: true });
    await writeFile(join(staged, "dist", "dashboard", "index.html"), "<html>new</html>");

    await installAtomically({
      installRoot: root,
      stagedDir: staged,
      replace: ["dist"],
    });

    expect(await readFile(join(root, "dist", "dashboard", "index.html"), "utf-8")).toBe("<html>new</html>");
  });

  it("restores the original bytes exactly when the payload is missing a target", async () => {
    const { root, staged } = await fixture();
    // `migrations` is listed but absent from the staged tree: the install moves
    // the original aside, then fails while copying, which is exactly the window
    // the backup exists to cover.
    await rm(join(staged, "migrations"), { recursive: true, force: true });

    const error = await installAtomically({
      installRoot: root,
      stagedDir: staged,
      replace: ["lianrouter.exe", "migrations"],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("migrations");

    expect(await readFile(join(root, "lianrouter.exe"), "utf-8")).toBe("OLD BINARY BYTES");
    expect(await readFile(join(root, "migrations", "0001_init.sql"), "utf-8")).toBe("OLD MIGRATION");
  });

  it("removes a newly created target on rollback instead of leaving a partial copy", async () => {
    const { root, staged } = await fixture();
    await mkdir(join(staged, "dist"), { recursive: true });
    await writeFile(join(staged, "dist", "keep.txt"), "staged");
    // The second target is broken, so the first (a brand-new path) must be undone.
    await rm(join(staged, "migrations"), { recursive: true, force: true });

    await installAtomically({
      installRoot: root,
      stagedDir: staged,
      replace: ["dist", "migrations"],
    }).catch(() => undefined);

    expect(await exists(join(root, "dist"))).toBe(false);
    expect(await readFile(join(root, "lianrouter.exe"), "utf-8")).toBe("OLD BINARY BYTES");
  });

  it("refuses a target that escapes the install root", async () => {
    const { root, staged } = await fixture();

    const error = await installAtomically({
      installRoot: root,
      stagedDir: staged,
      replace: ["../outside.txt"],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("escapes the install root");
  });

  it("refuses an empty replace list", async () => {
    const { root, staged } = await fixture();
    const error = await installAtomically({ installRoot: root, stagedDir: staged, replace: [] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("replace list is empty");
  });

  it("resolves after the install commits even when the backup cannot be removed", async () => {
    // The Windows case: the backup holds the image of the running process, so
    // `rm` fails with EPERM. Cleanup is garbage collection, not part of the
    // transaction — a throw here used to escape `installAtomically`, skip
    // `writeInstalledVersion`, and leave a new tree with a stale record.
    const { root, staged } = await fixture();
    const attempted: string[] = [];

    await expect(
      installAtomically({
        installRoot: root,
        stagedDir: staged,
        replace: ["lianrouter.exe", "migrations"],
        remove: async (target) => {
          attempted.push(target);
          throw Object.assign(new Error(`EPERM: operation not permitted, rm '${target}'`), {
            code: "EPERM",
          });
        },
      }),
    ).resolves.toBeUndefined();

    // The new content is the installation, regardless of the failed sweep.
    expect(await readFile(join(root, "lianrouter.exe"), "utf-8")).toBe("NEW BINARY BYTES");
    expect(await readFile(join(root, "migrations", "0001_init.sql"), "utf-8")).toBe("NEW MIGRATION");
    // Every entry was attempted: one undeletable binary must not strand the rest.
    expect(attempted).toHaveLength(1);
    expect(attempted[0]).toContain(".backup");
  });

  it("rolls back and rethrows when a copy fails, without sweeping the backup", async () => {
    // The commit boundary must not swallow the transaction: a failure *inside*
    // the copy loop still restores the old bytes and still rejects.
    const { root, staged } = await fixture();
    await rm(join(staged, "migrations"), { recursive: true, force: true });
    const attempted: string[] = [];

    const error = await installAtomically({
      installRoot: root,
      stagedDir: staged,
      replace: ["lianrouter.exe", "migrations"],
      remove: async (target) => {
        attempted.push(target);
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("migrations");
    expect(attempted).toEqual([]);
    expect(await readFile(join(root, "lianrouter.exe"), "utf-8")).toBe("OLD BINARY BYTES");
    expect(await readFile(join(root, "migrations", "0001_init.sql"), "utf-8")).toBe("OLD MIGRATION");
  });
});

describe("sweepBackups", () => {
  it("removes every timestamped directory under .backup", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".backup", "2026-01-01T00-00-00-000Z"), { recursive: true });
    await mkdir(join(root, ".backup", "2026-01-02T00-00-00-000Z"), { recursive: true });
    await writeFile(join(root, ".backup", "2026-01-01T00-00-00-000Z", "lianrouter.exe"), "old");

    await sweepBackups(root);

    // Every entry went, so the container goes too: a clean install leaves no
    // `.backup` at all, which is what the install test pins as well.
    expect(await exists(join(root, ".backup"))).toBe(false);
    expect(await exists(join(root, ".backup", "2026-01-01T00-00-00-000Z"))).toBe(false);
    expect(await exists(join(root, ".backup", "2026-01-02T00-00-00-000Z"))).toBe(false);
  });

  it("keeps the container when an entry survives, so a later run can retry", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".backup", "locked"), { recursive: true });
    await mkdir(join(root, ".backup", "free"), { recursive: true });

    await sweepBackups(root, async (target, options) => {
      if (target.endsWith("locked")) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      await rm(target, options);
    });

    expect(await exists(join(root, ".backup", "locked"))).toBe(true);
    expect(await exists(join(root, ".backup", "free"))).toBe(false);
  });

  it("swallows a throwing remover and still attempts every entry", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".backup", "a"), { recursive: true });
    await mkdir(join(root, ".backup", "b"), { recursive: true });
    const attempted: string[] = [];

    await expect(
      sweepBackups(root, async (target) => {
        attempted.push(target);
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }),
    ).resolves.toBeUndefined();

    expect(attempted.map((target) => target.split(/[\\/]/).pop()).sort()).toEqual(["a", "b"]);
  });

  it("does nothing when there is no backup directory", async () => {
    const root = await tempDir();
    await expect(sweepBackups(root)).resolves.toBeUndefined();
  });
});

describe("assertNotDevCheckout", () => {
  it("refuses a directory that looks like a source checkout", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "// entry");

    const error = await assertNotDevCheckout(root).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("source checkout");
  });

  it("allows a packaged install that has no .git", async () => {
    const root = await tempDir();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "// entry");
    await expect(assertNotDevCheckout(root)).resolves.toBeUndefined();
  });

  it("allows a directory with .git but no src/main.ts", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".git"), { recursive: true });
    await expect(assertNotDevCheckout(root)).resolves.toBeUndefined();
  });

  it("blocks installAtomically against a source checkout", async () => {
    const { root, staged } = await fixture();
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "// entry");

    const error = await installAtomically({
      installRoot: root,
      stagedDir: staged,
      replace: ["lianrouter.exe"],
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("source checkout");
    expect(await readFile(join(root, "lianrouter.exe"), "utf-8")).toBe("OLD BINARY BYTES");
  });
});
