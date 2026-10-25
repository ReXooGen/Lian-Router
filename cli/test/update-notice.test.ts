import { describe, expect, it } from "bun:test";

import { renderUpdateNotices } from "../src/update-notice";

/**
 * Rendering is pure, so every case here is a plain call: no terminal, no clock,
 * no network. What is asserted is the wording and the order, because the line
 * is the only thing the operator sees — a wrong command in it costs a support
 * round trip, and a wrong order points them at the inner artifact first.
 */

const LAUNCHER = { current: "2.2.1", latest: "2.3.0" } as const;
const GATEWAY = { current: "2.2.0", latest: "2.3.0" } as const;

describe("renderUpdateNotices", () => {
  it("prints only the launcher line when only the package is newer", () => {
    const lines = renderUpdateNotices({ launcher: LAUNCHER });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "lianrouter: a newer launcher is published (2.2.1 \u2192 2.3.0). Run: bun add -g lianrouter@latest",
    );
  });

  it("prints only the gateway line when only the archive is newer", () => {
    const lines = renderUpdateNotices({ gateway: GATEWAY });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "lianrouter: a gateway update is available (2.2.0 \u2192 2.3.0). Run: lianrouter update",
    );
  });

  it("prints both, launcher first", () => {
    // The launcher is the outer artifact: a newer package may carry a newer
    // update path, so its instruction has to be read first.
    const lines = renderUpdateNotices({ launcher: LAUNCHER, gateway: GATEWAY });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("a newer launcher is published");
    expect(lines[1]).toContain("a gateway update is available");
  });

  it("prints nothing when neither artifact is behind", () => {
    expect(
      renderUpdateNotices({
        launcher: { current: "2.3.0", latest: "2.3.0" },
        gateway: { current: "2.3.0", latest: "2.3.0" },
      }),
    ).toEqual([]);
  });

  it("prints nothing when the published version is older", () => {
    // A rollback in the registry, or a stale mirror, must not advertise a
    // downgrade as an update.
    expect(
      renderUpdateNotices({
        launcher: { current: "2.3.0", latest: "2.2.0" },
        gateway: { current: "2.3.0", latest: "2.2.0" },
      }),
    ).toEqual([]);
  });

  it("prints nothing for an absent input", () => {
    expect(renderUpdateNotices({})).toEqual([]);
  });

  it("uses the arrow and the exact command text", () => {
    const [launcherLine, gatewayLine] = renderUpdateNotices({
      launcher: LAUNCHER,
      gateway: GATEWAY,
    });
    // The arrow is U+2192, the one the menu labels and the update output use;
    // a hyphen or an ASCII arrow reads as a different tool's output.
    expect(launcherLine).toContain("\u2192");
    expect(gatewayLine).toContain("\u2192");
    expect(launcherLine).toContain("bun add -g lianrouter@latest");
    expect(gatewayLine).toContain("lianrouter update");
    // No ANSI, no emoji, no trailing newline: these lines go into pipes.
    for (const line of [launcherLine, gatewayLine]) {
      expect(line).not.toMatch(/\u001b\[/);
      expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(line).not.toMatch(/\n$/);
    }
  });
});
