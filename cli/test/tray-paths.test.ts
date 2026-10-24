import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { resolveInstallRoot as resolveLauncherRoot } from "../src/paths";
import { resolveInstallRoot as resolveTrayRoot } from "../tray/paths";

/**
 * The tray duplicates the launcher's install-root rule because importing the
 * launcher's module would pull the server graph into the tray bundle. Duplicated
 * rules drift — a lowercase app folder or a missing `XDG_DATA_HOME` branch is
 * enough to make the tray read a control file nobody wrote — so the two are
 * compared directly rather than trusted.
 */

const PLATFORMS: readonly NodeJS.Platform[] = ["win32", "darwin", "linux"];

/** Every combination the rule branches on. */
const ENVIRONMENTS: readonly (readonly [string, Readonly<Record<string, string | undefined>>])[] = [
  ["bare", {}],
  ["lianrouter-home", { LIANROUTER_HOME: "/custom/root" }],
  ["lianrouter-home-blank", { LIANROUTER_HOME: "   " }],
  ["xdg", { XDG_DATA_HOME: "/xdg/data" }],
  ["xdg-blank", { XDG_DATA_HOME: "  " }],
  ["localappdata", { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" }],
  ["localappdata-blank", { LOCALAPPDATA: "  " }],
  ["everything", { LIANROUTER_HOME: "/custom/root", XDG_DATA_HOME: "/xdg/data", LOCALAPPDATA: "C:\\appdata" }],
];

describe("install root parity", () => {
  for (const platform of PLATFORMS) {
    for (const [label, env] of ENVIRONMENTS) {
      it(`agrees on ${platform} / ${label}`, () => {
        expect(resolveTrayRoot(env, platform)).toBe(resolveLauncherRoot(env, platform));
      });
    }
  }

  it("resolves the documented Linux path when XDG_DATA_HOME is set", () => {
    // The specific drift that shipped: a lowercase folder and no XDG branch.
    expect(resolveTrayRoot({ XDG_DATA_HOME: "/xdg/data" }, "linux")).toBe(join("/xdg/data", "LianRouter"));
    expect(resolveTrayRoot({}, "linux")).toBe(join(homedir(), ".local", "share", "LianRouter"));
  });

  it("resolves a relative LIANROUTER_HOME against the cwd, once", () => {
    expect(resolveTrayRoot({ LIANROUTER_HOME: "relative/root" }, "linux")).toBe(resolve("relative/root"));
  });

  it("keeps the Windows and macOS folder names", () => {
    expect(resolveTrayRoot({ LOCALAPPDATA: "C:\\appdata" }, "win32")).toBe(join("C:\\appdata", "LianRouter"));
    expect(resolveTrayRoot({}, "darwin")).toBe(join(homedir(), "Library", "Application Support", "LianRouter"));
  });
});
