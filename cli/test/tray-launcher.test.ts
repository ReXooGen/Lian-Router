import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ControlHandshake } from "../src/control-server";
import { resolveTrayEntry, startTray, trayEntryCandidates } from "../src/tray-launcher";

/**
 * Entry resolution for the tray host.
 *
 * The bug these cover: the resolver looked in `<installRoot>/dist/tray.js`,
 * which nothing writes — the release archive carries only the gateway binary,
 * `migrations/`, and `dist/dashboard` — so every install from npm got "the tray
 * bundle is missing". A packaged install has the bundle beside `cli.js`, and
 * these cases pin that layout with a real temp directory rather than a mock.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `lianrouter-tray-launcher-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** Creates `<dir>/dist/tray.js` so the layout mirrors a published package. */
async function writeTrayBundle(dir: string): Promise<string> {
  const bundle = join(dir, "tray.js");
  await mkdir(dir, { recursive: true });
  await writeFile(bundle, "// tray fixture\n", "utf8");
  return bundle;
}

const HANDSHAKE: ControlHandshake = {
  port: 1,
  pid: process.pid,
  startedAt: Date.now(),
  token: "test-token",
};

describe("resolveTrayEntry", () => {
  it("resolves the bundle beside the launcher for a packaged install", async () => {
    const bundleDir = await tempDir("bundle");
    const expected = await writeTrayBundle(bundleDir);

    // The packaged shape: no checkout, and nothing in the install root. The
    // install-root candidate is gone from the list entirely, because the
    // release archive never carries a tray bundle.
    expect(resolveTrayEntry({ bundleDir })).toBe(expected);
    expect(trayEntryCandidates({ bundleDir })).toEqual([join(bundleDir, "tray.js")]);
  });

  it("prefers the dev-checkout build over a copy beside the launcher", async () => {
    const repoRoot = await tempDir("repo");
    const bundleDir = await tempDir("bundle");
    const devBundle = join(repoRoot, "cli", "dist", "tray.js");
    await mkdir(join(repoRoot, "cli", "dist"), { recursive: true });
    await writeFile(devBundle, "// dev tray fixture\n", "utf8");
    await writeTrayBundle(bundleDir);

    expect(resolveTrayEntry({ devRepoRoot: repoRoot, bundleDir })).toBe(devBundle);
    expect(trayEntryCandidates({ devRepoRoot: repoRoot, bundleDir })).toEqual([
      devBundle,
      join(bundleDir, "tray.js"),
    ]);
  });

  it("names both looked paths when neither exists in a packaged install", async () => {
    const installRoot = await tempDir("install");
    const bundleDir = await tempDir("bundle");

    const result = await startTray({ installRoot, bundleDir, control: HANDSHAKE });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a missing-bundle failure");
    }
    expect(result.error).toContain(join(bundleDir, "tray.js"));
    // A packaged user has no checkout to build in, so the dev advice is wrong
    // and must not appear.
    expect(result.error).not.toContain("bun run build:cli");
    expect(result.error).toContain("reinstall");
  });

  it("names both looked paths and the build command in a checkout", async () => {
    const installRoot = await tempDir("install");
    const repoRoot = await tempDir("repo");
    const bundleDir = await tempDir("bundle");

    const result = await startTray({ installRoot, devRepoRoot: repoRoot, bundleDir, control: HANDSHAKE });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a missing-bundle failure");
    }
    expect(result.error).toContain(join(repoRoot, "cli", "dist", "tray.js"));
    expect(result.error).toContain(join(bundleDir, "tray.js"));
    expect(result.error).toContain("bun run build:cli");
  });
});
