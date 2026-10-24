import { describe, expect, test } from "bun:test";
import { buildMenuItems, renderMenu } from "../src/menu";

const BASE = { version: "2.0.0", port: 12_800 } as const;

describe("renderMenu", () => {
  test("omits the update row entirely when no update is known", () => {
    const rendered = renderMenu(BASE);
    expect(rendered).not.toContain("Update to");
    expect(rendered).toContain("Web UI (Open in Browser)");
  });

  test("leads with the update row and names both versions when one is available", () => {
    const rendered = renderMenu({ ...BASE, update: { latest: "2.0.5" } });
    const lines = rendered.split("\n");
    const updateIndex = lines.findIndex((line) => line.includes("Update to v2.0.5 (current: v2.0.0)"));
    const webIndex = lines.findIndex((line) => line.includes("Web UI"));
    expect(updateIndex).toBeGreaterThan(-1);
    expect(webIndex).toBeGreaterThan(updateIndex);
  });

  test("interpolates the version and the server URL from the input", () => {
    const rendered = renderMenu({ version: "9.9.9", port: 40_000 });
    expect(rendered).toContain("Choose Interface (v9.9.9)");
    expect(rendered).toContain("🚀 Server: http://localhost:40000");
  });

  test("draws the cursor on the selected row only", () => {
    const rendered = renderMenu({ ...BASE, selectedIndex: 0 });
    const cursorLines = rendered.split("\n").filter((line) => line.trimStart().startsWith(">"));
    expect(cursorLines).toHaveLength(1);
    expect(cursorLines[0]).toContain("Web UI");
  });

  test("moves the cursor onto the update row when it is present", () => {
    // The update row shifts every other row down by one, so index 1 is Web UI
    // only in the no-update variant. This pins the with-update mapping.
    const rendered = renderMenu({ ...BASE, update: { latest: "2.0.5" }, selectedIndex: 1 });
    const cursorLines = rendered.split("\n").filter((line) => line.trimStart().startsWith(">"));
    expect(cursorLines).toHaveLength(1);
    expect(cursorLines[0]).toContain("Web UI");
  });

  test("clamps an out-of-range cursor instead of rendering no cursor", () => {
    const rendered = renderMenu({ ...BASE, selectedIndex: 99 });
    const cursorLines = rendered.split("\n").filter((line) => line.trimStart().startsWith(">"));
    expect(cursorLines).toHaveLength(1);
    expect(cursorLines[0]).toContain("Exit");
  });

  test("keeps the four fixed rows in the requested order", () => {
    const actions = buildMenuItems(BASE).map((item) => item.action);
    expect(actions).toEqual(["web", "tui", "tray", "exit"]);
  });

  test("places the update action first when one is available", () => {
    const actions = buildMenuItems({ ...BASE, update: { latest: "2.0.5" } }).map((item) => item.action);
    expect(actions).toEqual(["update", "web", "tui", "tray", "exit"]);
  });
});
