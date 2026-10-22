import { describe, expect, test } from "bun:test";
import { compiledBinaryPath, resolveTarget } from "./build-binary";

describe("resolveTarget", () => {
  test("returns undefined when no target is requested, so the host platform wins", () => {
    expect(resolveTarget([])).toBeUndefined();
    expect(resolveTarget(["--outfile", "dist/app"])).toBeUndefined();
  });

  test("accepts a supported cross-compilation target", () => {
    expect(resolveTarget(["--target", "bun-linux-x64"])).toBe("bun-linux-x64");
    expect(resolveTarget(["--outfile", "dist/app", "--target", "bun-darwin-arm64"])).toBe(
      "bun-darwin-arm64",
    );
  });

  test("rejects a missing value rather than silently building for the host", () => {
    // A silent fallback here is how a Windows binary reached a Linux server.
    expect(() => resolveTarget(["--target"])).toThrow("--target requires a value");
  });

  test("rejects an unsupported target instead of passing it to Bun", () => {
    expect(() => resolveTarget(["--target", "bun-plan9-x64"])).toThrow("--target must be one of");
  });
});

describe("compiledBinaryPath", () => {
  test("appends .exe for a Windows target regardless of the build host", () => {
    expect(compiledBinaryPath("dist/app", "bun-windows-x64")).toBe("dist/app.exe");
  });

  test("leaves a Linux target extensionless even when built on Windows", () => {
    // This is the regression that mattered: cross-compiling Linux from Windows
    // must not be reported as `dist/app.exe`, which never gets written.
    expect(compiledBinaryPath("dist/app", "bun-linux-x64")).toBe("dist/app");
  });

  test("keeps an explicit .exe suffix from doubling up", () => {
    expect(compiledBinaryPath("dist/app.exe", "bun-windows-x64")).toBe("dist/app.exe");
  });

  test("falls back to the host platform when no target is given", () => {
    const expected = process.platform === "win32" ? "dist/app.exe" : "dist/app";
    expect(compiledBinaryPath("dist/app")).toBe(expected);
  });
});
