import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readInstalledVersion, resolveCurrentVersion, writeInstalledVersion } from "../update/version-file";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-version-file-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("version file", () => {
  it("round-trips a written record", async () => {
    const root = await tempDir();
    await writeInstalledVersion(root, {
      version: "2.1.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      assetName: "lianrouter-win32-x64.zip",
    });

    expect(await readInstalledVersion(root)).toEqual({
      version: "2.1.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      assetName: "lianrouter-win32-x64.zip",
    });
  });

  it("returns undefined for a missing file", async () => {
    const root = await tempDir();
    expect(await readInstalledVersion(root)).toBeUndefined();
  });

  it("returns undefined for a corrupt file instead of throwing", async () => {
    const root = await tempDir();
    await writeFile(join(root, "version.json"), "{ this is not json");
    expect(await readInstalledVersion(root)).toBeUndefined();
  });

  it("returns undefined when version is missing or not a string", async () => {
    const root = await tempDir();
    await writeFile(join(root, "version.json"), JSON.stringify({ version: 5 }));
    expect(await readInstalledVersion(root)).toBeUndefined();

    await writeFile(join(root, "version.json"), JSON.stringify({ installedAt: "x" }));
    expect(await readInstalledVersion(root)).toBeUndefined();

    await writeFile(join(root, "version.json"), JSON.stringify({ version: "   " }));
    expect(await readInstalledVersion(root)).toBeUndefined();
  });

  it("returns undefined for a non-object payload", async () => {
    const root = await tempDir();
    await writeFile(join(root, "version.json"), JSON.stringify(["2.0.0"]));
    expect(await readInstalledVersion(root)).toBeUndefined();
  });

  it("defaults absent optional fields to empty strings", async () => {
    const root = await tempDir();
    await writeFile(join(root, "version.json"), JSON.stringify({ version: "3.0.0" }));
    expect(await readInstalledVersion(root)).toEqual({
      version: "3.0.0",
      installedAt: "",
      assetName: "",
    });
  });

  it("reads a legacy tag-prefixed record as a bare version", async () => {
    // Records written before the version seam existed hold the release tag. They
    // are on disk today (a 2.2.0 launcher with `{"version":"v2.0.0"}`), so the
    // read side has to normalize or every display site prints `vv2.0.0`.
    const root = await tempDir();
    await writeFile(
      join(root, "version.json"),
      JSON.stringify({ version: "v2.0.0", installedAt: "x", assetName: "y" }),
    );
    expect((await readInstalledVersion(root))?.version).toBe("2.0.0");
  });

  it("stores a tag-prefixed version bare on write", async () => {
    const root = await tempDir();
    await writeInstalledVersion(root, {
      version: "v2.1.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      assetName: "lianrouter-win32-x64.zip",
    });
    const raw = JSON.parse(await Bun.file(join(root, "version.json")).text()) as { version: string };
    expect(raw.version).toBe("2.1.0");
    expect((await readInstalledVersion(root))?.version).toBe("2.1.0");
  });

  it("rejects a record whose version is only a tag prefix", async () => {
    const root = await tempDir();
    await writeFile(join(root, "version.json"), JSON.stringify({ version: "v" }));
    expect(await readInstalledVersion(root)).toBeUndefined();
  });
});

describe("resolveCurrentVersion", () => {
  it("prefers the compiled-in version when it is real", async () => {
    const root = await tempDir();
    await writeInstalledVersion(root, { version: "9.9.9", installedAt: "", assetName: "" });
    expect(await resolveCurrentVersion(root, "2.0.0")).toBe("2.0.0");
  });

  it("falls back to the on-disk record when the compiled version is a placeholder", async () => {
    const root = await tempDir();
    await writeInstalledVersion(root, {
      version: "2.1.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      assetName: "x.zip",
    });
    // A binary built with a placeholder version that then installed an update
    // must report the installed release, not the placeholder.
    expect(await resolveCurrentVersion(root, "0.0.0")).toBe("2.1.0");
    expect(await resolveCurrentVersion(root, "dev")).toBe("2.1.0");
    expect(await resolveCurrentVersion(root, "unknown")).toBe("2.1.0");
    expect(await resolveCurrentVersion(root, "")).toBe("2.1.0");
  });

  it("returns the placeholder when there is no record either", async () => {
    const root = await tempDir();
    expect(await resolveCurrentVersion(root, "0.0.0")).toBe("0.0.0");
  });

  it("does not treat a nested directory as a record", async () => {
    const root = await tempDir();
    await mkdir(join(root, "version.json"), { recursive: true });
    expect(await resolveCurrentVersion(root, "0.0.0")).toBe("0.0.0");
  });
});
