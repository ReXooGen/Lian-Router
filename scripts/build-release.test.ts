import { describe, expect, it } from "bun:test";

import { releaseAssetName, releaseBinaryName, releaseEntries, releaseLayout } from "./build-release";

/**
 * The release archive's name and shape are a contract with two consumers that
 * cannot be changed independently: `pickAssetForPlatform()` selects the file by
 * exact token, and `ensureGatewayInstalled()` fails when the gateway executable
 * is not one of the archive's top-level entries. These are the pure parts; the
 * zip invocation itself is verified by running the script.
 */

describe("releaseAssetName", () => {
  it("matches the engine's platform-arch vocabulary", () => {
    expect(releaseAssetName({ platform: "win32", arch: "x64" })).toBe("lianrouter-win32-x64.zip");
    expect(releaseAssetName({ platform: "linux", arch: "arm64" })).toBe("lianrouter-linux-arm64.zip");
    expect(releaseAssetName({ platform: "darwin", arch: "arm64" })).toBe("lianrouter-darwin-arm64.zip");
  });

  it("lowercases a platform that arrives in mixed case", () => {
    expect(releaseAssetName({ platform: "WIN32", arch: "X64" })).toBe("lianrouter-win32-x64.zip");
  });

  it("refuses a platform the engine would never select", () => {
    expect(() => releaseAssetName({ platform: "freebsd", arch: "x64" })).toThrow(/no release archive for platform/);
  });

  it("refuses an arch the engine would never select", () => {
    expect(() => releaseAssetName({ platform: "linux", arch: "riscv64" })).toThrow(/no release archive for arch/);
  });
});

describe("releaseBinaryName", () => {
  it("uses the .exe suffix on Windows only", () => {
    expect(releaseBinaryName("win32")).toBe("lianrouter.exe");
    expect(releaseBinaryName("linux")).toBe("lianrouter");
    expect(releaseBinaryName("darwin")).toBe("lianrouter");
  });
});

describe("releaseEntries", () => {
  it("lists the binary, migrations and dist at the archive root", () => {
    // Flat on purpose: a nested payload installs "successfully" and then leaves
    // the launcher spawning a path that does not exist.
    expect(releaseEntries({ platform: "win32", arch: "x64" })).toEqual(["lianrouter.exe", "migrations", "dist"]);
    expect(releaseEntries({ platform: "linux", arch: "x64" })).toEqual(["lianrouter", "migrations", "dist"]);
  });

  it("puts the binary name first so a reader sees the required entry", () => {
    const layout = releaseLayout({ platform: "darwin", arch: "arm64" });
    expect(layout.entries[0]).toBe(layout.binaryName);
    expect(layout.assetName).toBe("lianrouter-darwin-arm64.zip");
  });
});
