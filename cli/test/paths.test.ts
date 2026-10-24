import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDevRepoRoot } from "../src/paths";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-paths-test-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Writes the files that make `dir` look like a launcher package: an entry point
 * and a manifest named `lianrouter`. That is exactly the shape of `cli/`, which
 * is why `src/app.ts` has to be the discriminator.
 */
async function writeLauncherShaped(dir: string): Promise<void> {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "main.ts"), "export {};\n", "utf8");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "lianrouter" }), "utf8");
}

/** Adds the gateway markers on top: `src/app.ts` plus a migrations tree. */
async function writeGatewayShaped(dir: string): Promise<void> {
  await writeLauncherShaped(dir);
  await writeFile(join(dir, "src", "app.ts"), "export {};\n", "utf8");
  await mkdir(join(dir, "drizzle", "migrations"), { recursive: true });
}

describe("resolveDevRepoRoot", () => {
  it("returns the gateway repository root from a checkout, not the launcher package", () => {
    // `import.meta.dir` is `cli/src`, which is where the real launcher lives.
    const root = resolveDevRepoRoot(import.meta.dir);
    expect(root).toBeDefined();
    if (root === undefined) return;

    expect(existsSync(join(root, "src", "app.ts"))).toBe(true);
    expect(existsSync(join(root, "drizzle", "migrations"))).toBe(true);
    // The launcher package sits below it and must not be the answer.
    expect(root).not.toBe(join(import.meta.dir, ".."));
  });

  it("walks past a launcher-shaped decoy to the real gateway root", async () => {
    const fixture = await tempDir();
    await writeGatewayShaped(fixture);

    // The decoy is the shape of `cli/`: entry point plus a `lianrouter`
    // manifest, with no `src/app.ts`.
    const decoy = join(fixture, "cli");
    await writeLauncherShaped(decoy);

    const found = resolveDevRepoRoot(join(decoy, "src"));
    expect(found).toBe(fixture);
  });

  it("returns undefined when no ancestor is a gateway tree", async () => {
    const fixture = await tempDir();
    await writeLauncherShaped(join(fixture, "cli"));
    expect(resolveDevRepoRoot(join(fixture, "cli", "src"))).toBeUndefined();
  });

  it("rejects a tree whose manifest is not named lianrouter", async () => {
    const fixture = await tempDir();
    await mkdir(join(fixture, "src"), { recursive: true });
    await writeFile(join(fixture, "src", "main.ts"), "export {};\n", "utf8");
    await writeFile(join(fixture, "src", "app.ts"), "export {};\n", "utf8");
    await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "something-else" }), "utf8");
    expect(resolveDevRepoRoot(join(fixture, "src"))).toBeUndefined();
  });
});
