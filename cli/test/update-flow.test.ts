import { describe, expect, test } from "bun:test";
import type { UpdateSnapshot } from "../src/control-server";
import type { UpdateFlowDeps, UpdateFlowProgress } from "../src/update-flow";
import { runUpdateSequence } from "../src/update-flow";

/**
 * The ordering that makes console progress possible.
 *
 * The gateway serves the console, so a stop before the download kills the page
 * showing the bar. These tests drive the real sequence with a fake engine and a
 * fake supervisor, recording every observable event into one list, and assert on
 * that list — not on internals.
 */

interface Harness {
  readonly events: string[];
  readonly deps: UpdateFlowDeps;
  readonly progressFrames: string[];
  readonly snapshots: Array<UpdateSnapshot>;
}

interface HarnessOptions {
  readonly available?: boolean;
  /** Progress frames the fake engine emits, in order, before its own work. */
  readonly frames?: readonly UpdateFlowProgress[];
  /** Throws instead of reaching the `restart` hook. */
  readonly failAt?: string;
}

function harness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const progressFrames: string[] = [];
  const snapshots: Array<{ current: string; latest: string; available: boolean }> = [];
  const frames = options.frames ?? [
    { phase: "checking", percent: 0, message: "checking for updates" },
    { phase: "downloading", percent: 10, message: "downloading asset" },
    { phase: "downloading", percent: 70, message: "downloading asset" },
    { phase: "verifying", percent: 78, message: "verifying checksum" },
    { phase: "extracting", percent: 85, message: "extracting archive" },
    { phase: "installing", percent: 90, message: "installing update" },
    { phase: "installing", percent: 95, message: "installed lianrouter.exe" },
    { phase: "restarting", percent: 97, message: "restarting gateway" },
    { phase: "done", percent: 100, message: "updated to 2.0.5" },
  ];

  const deps: UpdateFlowDeps = {
    currentVersion: "2.0.0",
    installRoot: "/install",
    checkForUpdate: async () => {
      events.push("check");
      return {
        current: "2.0.0",
        latest: "2.0.5",
        available: options.available ?? true,
        notesUrl: "https://example.test/v2.0.5",
        publishedAt: "2026-10-20T10:00:00Z",
      };
    },
    runUpdate: async (runOptions) => {
      for (const frame of frames) {
        events.push(`progress:${frame.phase}`);
        runOptions.onProgress(frame);
        if (options.failAt === "downloading" && frame.phase === "verifying") {
          throw new Error("checksum mismatch");
        }
        if (options.failAt === "installing" && frame.phase === "installing") {
          throw new Error("rename failed: file in use");
        }
      }
      if (options.failAt === "restarting") {
        throw new Error("start failed");
      }
      events.push("restart-hook");
      await runOptions.restart?.();
    },
    stopGateway: async () => {
      events.push("stop");
    },
    startGateway: async () => {
      events.push("start");
    },
    publish: (snapshot) => {
      snapshots.push(snapshot);
      events.push("snapshot");
    },
    publishProgress: (progress) => {
      progressFrames.push(progress.phase);
      events.push(`publish:${progress.phase}`);
    },
  };

  return { events, deps, progressFrames, snapshots };
}

describe("update sequence ordering", () => {
  test("keeps the gateway up through check/download/verify/extract", async () => {
    const { events, deps, progressFrames, snapshots } = harness();

    await runUpdateSequence(deps);

    // Nothing stopped the gateway before the first downloading frame.
    const firstDownload = events.indexOf("progress:downloading");
    const firstStop = events.indexOf("stop");
    expect(firstDownload).toBeGreaterThan(-1);
    expect(firstStop).toBeGreaterThan(firstDownload);

    // Exactly one stop, at the install boundary: after `extracting` has been
    // published to the console, before the engine reaches `restarting`.
    expect(events.filter((event) => event === "stop")).toHaveLength(1);
    const lastExtract = events.lastIndexOf("publish:extracting");
    const firstRestart = events.indexOf("progress:restarting");
    expect(firstStop).toBeGreaterThan(lastExtract);
    expect(firstStop).toBeLessThan(firstRestart);
    // It is triggered by the `installing` frame, not by the extraction.
    expect(events.indexOf("progress:installing")).toBeLessThan(firstStop);

    // The stop lands once even though `installing` fires twice.
    expect(events.filter((event) => event === "stop")).toHaveLength(1);

    // Every phase the engine emitted reached the publisher, in order.
    expect(progressFrames).toEqual([
      "checking",
      "downloading",
      "downloading",
      "verifying",
      "extracting",
      "installing",
      "installing",
      "restarting",
      "done",
    ]);

    // The snapshot carries the release metadata the console renders.
    expect(snapshots).toEqual([
      {
        current: "2.0.0",
        latest: "2.0.5",
        available: true,
        notesUrl: "https://example.test/v2.0.5",
        publishedAt: "2026-10-20T10:00:00Z",
      },
    ]);

    // The new binary comes up after the install.
    expect(events.indexOf("start")).toBeGreaterThan(events.indexOf("restart-hook"));
  });

  test("stops nothing when the install is already current", async () => {
    const { events, deps } = harness({ available: false });

    await runUpdateSequence(deps);

    expect(events).toEqual(["check", "snapshot"]);
  });

  test("keeps the gateway up when the update fails before installing", async () => {
    const { events, deps } = harness({ failAt: "downloading" });

    await expect(runUpdateSequence(deps)).rejects.toThrow("checksum mismatch");

    // The console stayed reachable: no stop, no recovery start.
    expect(events).not.toContain("stop");
    expect(events).not.toContain("start");
  });

  test("restarts the gateway when the install itself fails", async () => {
    const { events, deps } = harness({ failAt: "installing" });

    await expect(runUpdateSequence(deps)).rejects.toThrow("rename failed: file in use");

    // The child was stopped to release the executable, so the failure path has
    // to bring one back or the console has nothing to serve it.
    expect(events.filter((event) => event === "stop")).toHaveLength(1);
    expect(events.filter((event) => event === "start")).toHaveLength(1);
    expect(events.indexOf("start")).toBeGreaterThan(events.indexOf("stop"));
  });
});
