import { describe, expect, test } from "bun:test";

import type { UpdateStatus } from "./contracts";
import { updateButtonState, versionLabel } from "./update-view";

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    launcher: true,
    current: "2.2.2",
    latest: null,
    available: false,
    notesUrl: null,
    publishedAt: null,
    running: false,
    progress: null,
    ...overrides,
  };
}

describe("versionLabel", () => {
  test("names the running gateway rather than the build constant", () => {
    expect(versionLabel(status({ current: "2.2.2" }), "v2.2.0")).toBe("v2.2.2");
  });

  test("does not double the prefix when the gateway already reports one", () => {
    expect(versionLabel(status({ current: "v2.2.2" }), "v2.2.0")).toBe("v2.2.2");
  });

  test("falls back to the build label while the status is unavailable", () => {
    expect(versionLabel(undefined, "v2.2.2")).toBe("v2.2.2");
    expect(versionLabel(status({ current: "  " }), "v2.2.2")).toBe("v2.2.2");
  });
});

describe("updateButtonState", () => {
  test("reports an enabled but hidden control before the status loads", () => {
    expect(updateButtonState(undefined)).toEqual({
      disabled: false,
      available: false,
      title: "Check for updates",
      hidden: true,
    });
  });

  test("disables and explains itself when no launcher is attached", () => {
    const state = updateButtonState(status({ launcher: false, available: false }));
    expect(state.disabled).toBe(true);
    expect(state.available).toBe(false);
    expect(state.title).toContain("not started by the lianrouter launcher");
  });

  test("signals an available release without opening the modal", () => {
    const state = updateButtonState(
      status({ available: true, latest: "2.3.0", current: "2.2.2" }),
    );
    expect(state.disabled).toBe(false);
    expect(state.available).toBe(true);
    expect(state.title).toContain("2.3.0");
  });

  test("signals a running install and names the current version when idle", () => {
    expect(updateButtonState(status({ running: true })).available).toBe(true);
    const idle = updateButtonState(status({ current: "2.2.2" }));
    expect(idle.disabled).toBe(false);
    expect(idle.available).toBe(false);
    expect(idle.title).toContain("v2.2.2");
  });
});

describe("updateButtonState.hidden", () => {
  test("hides before the status loads rather than flashing a control", () => {
    expect(updateButtonState(undefined).hidden).toBe(true);
  });

  test("hides when up to date — no control beside the version badge", () => {
    const state = updateButtonState(status({ launcher: true, running: false, available: false }));
    expect(state.hidden).toBe(true);
  });

  test("shows when a release is installable", () => {
    expect(updateButtonState(status({ available: true, latest: "2.3.0" })).hidden).toBe(false);
  });

  test("shows mid-install so the operator can get back to the progress bar", () => {
    // `available` is false here on purpose: hiding a running install would
    // strand the operator with no route back to the progress view.
    const state = updateButtonState(status({ running: true, available: false }));
    expect(state.hidden).toBe(false);
  });

  test("hides when no launcher can apply a release", () => {
    expect(updateButtonState(status({ launcher: false })).hidden).toBe(true);
  });
});
