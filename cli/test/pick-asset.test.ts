import { describe, expect, it } from "bun:test";

import type { ReleaseAsset } from "../update/contracts";
import { pickAssetForPlatform } from "../update/github-source";

function asset(name: string, size = 1024): ReleaseAsset {
  return { name, url: `https://example.invalid/${name}`, size };
}

const RELEASE_ASSETS: readonly ReleaseAsset[] = [
  asset("lianrouter-linux-x64.zip"),
  asset("lianrouter-linux-arm64.zip"),
  asset("lianrouter-darwin-x64.zip"),
  asset("lianrouter-darwin-arm64.zip"),
  asset("lianrouter-win32-x64.zip"),
  asset("lianrouter-win32-arm64.zip"),
  asset("checksums.txt", 256),
  asset("release-notes.md", 512),
];

describe("pickAssetForPlatform", () => {
  it("selects the asset matching both platform and arch", () => {
    expect(pickAssetForPlatform(RELEASE_ASSETS, "win32", "x64")?.name).toBe("lianrouter-win32-x64.zip");
    expect(pickAssetForPlatform(RELEASE_ASSETS, "linux", "arm64")?.name).toBe("lianrouter-linux-arm64.zip");
    expect(pickAssetForPlatform(RELEASE_ASSETS, "darwin", "arm64")?.name).toBe("lianrouter-darwin-arm64.zip");
  });

  it("does not match x64 inside arm64", () => {
    const onlyArm = [asset("lianrouter-win32-arm64.zip")];
    expect(pickAssetForPlatform(onlyArm, "win32", "x64")).toBeUndefined();
  });

  it("does not match a platform token that only appears as a substring", () => {
    // "win32" must not be found inside a hypothetical longer token.
    const tricky = [asset("lianrouter-notwin32-x64.zip")];
    expect(pickAssetForPlatform(tricky, "win32", "x64")).toBeUndefined();
  });

  it("returns undefined when the release ships nothing for the host", () => {
    expect(pickAssetForPlatform(RELEASE_ASSETS, "freebsd", "x64")).toBeUndefined();
    expect(pickAssetForPlatform(RELEASE_ASSETS, "linux", "riscv64")).toBeUndefined();
  });

  it("returns undefined for an empty asset list", () => {
    expect(pickAssetForPlatform([], "win32", "x64")).toBeUndefined();
  });

  it("prefers a zip over another archive for the same host", () => {
    const mixed = [
      asset("lianrouter-win32-x64.7z"),
      asset("lianrouter-win32-x64.zip"),
    ];
    expect(pickAssetForPlatform(mixed, "win32", "x64")?.name).toBe("lianrouter-win32-x64.zip");
  });

  it("ignores unrelated release metadata files", () => {
    const onlyMetadata = [asset("checksums.txt", 100), asset("release-notes.md", 100)];
    expect(pickAssetForPlatform(onlyMetadata, "win32", "x64")).toBeUndefined();
  });

  it("is case-insensitive about the asset name", () => {
    const upper = [asset("LianRouter-WIN32-X64.ZIP")];
    expect(pickAssetForPlatform(upper, "win32", "x64")?.name).toBe("LianRouter-WIN32-X64.ZIP");
  });
});
