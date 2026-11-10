import { describe, expect, it } from "bun:test";

import {
  assertVersionMatch,
  extractBakedVersion,
  releaseAssetName,
  releaseBinaryName,
  releaseEntries,
  releaseLayout,
} from "./build-release";

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

/**
 * The version guard exists because a stale `dist/` once shipped a 2.2.0 binary
 * inside a 2.2.2 release. These cases pin the failure modes that made that
 * possible: an absent needle must not pass, and an ambiguous binary must not
 * pass either.
 */
describe("extractBakedVersion", () => {
  const wrap = (body: string): Uint8Array => Buffer.from(`\x00junk\x00${body}\x00tail`, "latin1");

  it("reads the version the compiler inlined", () => {
    expect(extractBakedVersion(wrap('name:"lianrouter",version:"2.2.2",private:!0'))).toBe("2.2.2");
  });

  it("reports the stale version rather than the manifest one", () => {
    expect(extractBakedVersion(wrap('name:"lianrouter",version:"2.2.0",private:!0'))).toBe("2.2.0");
  });

  it("returns undefined when no needle is present, so the caller can fail", () => {
    expect(extractBakedVersion(wrap('name:"other",version:"2.2.2"'))).toBeUndefined();
    expect(extractBakedVersion(Buffer.from("not an executable"))).toBeUndefined();
  });

  it("rejects a binary carrying two different versions", () => {
    const bytes = Buffer.from(
      'name:"lianrouter",version:"2.2.0"name:"lianrouter",version:"2.2.2"',
      "latin1",
    );
    expect(() => extractBakedVersion(bytes)).toThrow(/more than one baked version/);
  });

  it("accepts the same version repeated", () => {
    const bytes = Buffer.from(
      'name:"lianrouter",version:"2.2.2"name:"lianrouter",version:"2.2.2"',
      "latin1",
    );
    expect(extractBakedVersion(bytes)).toBe("2.2.2");
  });

  it("rejects an empty buffer", () => {
    expect(() => extractBakedVersion(new Uint8Array(0))).toThrow(/empty binary/);
  });

  it("rejects a needle with no version behind it", () => {
    expect(() => extractBakedVersion(Buffer.from('name:"lianrouter",version:"",x'))).toThrow(
      /no version behind it/,
    );
  });
});

/**
 * The guard's decision, independent of any 90 MB artifact. This is the branch
 * that was missing when 2.2.2 shipped with a 2.2.0 binary: nothing compared the
 * baked version to the manifest, so nothing could fail.
 */
describe("assertVersionMatch", () => {
  it("accepts a binary built from the current manifest", () => {
    expect(() => assertVersionMatch("2.2.2", "2.2.2")).not.toThrow();
  });

  it("names both versions and the fix when the binary is stale", () => {
    expect(() => assertVersionMatch("2.2.0", "2.2.2")).toThrow(
      "dist/lianrouter.exe reports version 2.2.0 but package.json is 2.2.2 — run `bun run build` before staging a release",
    );
  });

  it("treats a missing baked version as a failure, not a pass", () => {
    expect(() => assertVersionMatch(undefined, "2.2.2")).toThrow(/reports no baked version/);
  });
});
