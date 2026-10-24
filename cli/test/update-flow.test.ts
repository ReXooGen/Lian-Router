import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UpdateSnapshot } from "../src/control-server";
import type { UpdateFlowDeps, UpdateFlowProgress } from "../src/update-flow";
import { runUpdateSequence } from "../src/update-flow";
import type { RawRelease, UpdateChannel, UpdateSource } from "../update/contracts";
import { checkForUpdate } from "../update/engine";

/**
 * The ordering that makes console progress possible.
 *
 * The gateway serves the console, so a stop before the download kills the page
 * showing the bar. These tests drive the real sequence with a fake engine and a
 * fake supervisor, recording every observable event into one list, and assert on
 * that list — not on internals.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Asset name matching this host, so the engine's selection finds it. */
const HOST_ASSET = `lianrouter-${process.platform}-${process.arch}.zip`;

/**
 * A real install root, because the sequence reads `version.json` from disk.
 * Omitting `version` leaves the record absent — the fresh-install case.
 */
async function tempInstallRoot(record?: { readonly version: string }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-update-flow-test-"));
  tempDirs.push(dir);
  if (record !== undefined) {
    await writeFile(
      join(dir, "version.json"),
      JSON.stringify({ version: record.version, installedAt: "2026-01-01T00:00:00.000Z", assetName: HOST_ASSET }),
    );
  }
  return dir;
}

/** Fake release source; the real one is exercised by its own suite. */
class FakeSource implements UpdateSource {
  readonly #release: RawRelease | null;

  constructor(release: RawRelease | null) {
    this.#release = release;
  }

  async fetchLatest(_channel: UpdateChannel): Promise<RawRelease | null> {
    return this.#release;
  }
}

interface Harness {
  readonly events: string[];
  readonly deps: UpdateFlowDeps;
  readonly progressFrames: string[];
  readonly snapshots: Array<UpdateSnapshot>;
  /** Every version the sequence asked the engine to compare against. */
  readonly checkedVersions: string[];
  /** Every version the sequence handed to `runUpdate`. */
  readonly runVersions: string[];
}

interface HarnessOptions {
  readonly available?: boolean;
  /** Progress frames the fake engine emits, in order, before its own work. */
  readonly frames?: readonly UpdateFlowProgress[];
  /** Throws instead of reaching the `restart` hook. */
  readonly failAt?: string;
  /** Install root the sequence reads `version.json` from. */
  readonly installRoot?: string;
  /** The launcher's own version, used only as the fallback. */
  readonly launcherVersion?: string;
  /** Latest release the fake engine offers. */
  readonly latest?: string;
}

function harness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const progressFrames: string[] = [];
  const snapshots: Array<{ current: string; latest: string; available: boolean }> = [];
  const checkedVersions: string[] = [];
  const runVersions: string[] = [];
  const latest = options.latest ?? "2.0.5";
  const frames = options.frames ?? [
    { phase: "checking", percent: 0, message: "checking for updates" },
    { phase: "downloading", percent: 10, message: "downloading asset" },
    { phase: "downloading", percent: 70, message: "downloading asset" },
    { phase: "verifying", percent: 78, message: "verifying checksum" },
    { phase: "extracting", percent: 85, message: "extracting archive" },
    { phase: "installing", percent: 90, message: "installing update" },
    { phase: "installing", percent: 95, message: "installed lianrouter.exe" },
    { phase: "restarting", percent: 97, message: "restarting gateway" },
    { phase: "done", percent: 100, message: `updated to ${latest}` },
  ];

  const deps: UpdateFlowDeps = {
    launcherVersion: options.launcherVersion ?? "2.0.0",
    installRoot: options.installRoot ?? "/install",
    checkForUpdate: async (checkOptions) => {
      events.push("check");
      checkedVersions.push(checkOptions.currentVersion);
      return {
        current: checkOptions.currentVersion,
        latest,
        available: options.available ?? true,
        notesUrl: `https://example.test/v${latest}`,
        publishedAt: "2026-10-20T10:00:00Z",
      };
    },
    runUpdate: async (runOptions) => {
      runVersions.push(runOptions.currentVersion);
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

  return { events, deps, progressFrames, snapshots, checkedVersions, runVersions };
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

/**
 * Which version the sequence compares against.
 *
 * The sequence installs a gateway archive, and the launcher and the gateway are
 * versioned independently. Handing the sequence the launcher's own version made
 * `lianrouter update` report "up to date" on a machine whose `version.json`
 * still named an older gateway, because the release matched the launcher and so
 * looked not-newer. These tests drive the real `checkForUpdate` predicate with a
 * fake source, so the comparison under test is the shipped one.
 */
describe("update sequence version comparison", () => {
  test("offers the release when the launcher is newer than the installed gateway", async () => {
    const installRoot = await tempInstallRoot({ version: "v2.0.0" });
    const release: RawRelease = {
      version: "2.1.0",
      assets: [{ name: HOST_ASSET, url: "https://example.invalid/never-fetched.zip", size: 1 }],
    };
    const source = new FakeSource(release);
    const { events, deps, snapshots, runVersions } = harness({
      installRoot,
      launcherVersion: "2.1.0",
      latest: "2.1.0",
    });

    await runUpdateSequence({
      ...deps,
      checkForUpdate: (options) => checkForUpdate({ ...options, source }),
      runUpdate: async (options) => {
        runVersions.push(options.currentVersion);
        events.push("install");
      },
    });

    // The launcher's own 2.1.0 must not satisfy the comparison; the gateway's
    // recorded v2.0.0 is what makes 2.1.0 an update. The record on disk still
    // carries the old tag form, so this also pins the read-side normalization:
    // the snapshot names the version bare, never `v2.0.0`.
    expect(snapshots).toEqual([
      {
        current: "2.0.0",
        latest: "2.1.0",
        available: true,
      },
    ]);
    expect(runVersions).toEqual(["2.0.0"]);
    expect(events).toContain("install");
  });

  test("reports up to date and installs nothing when the gateway is already current", async () => {
    const installRoot = await tempInstallRoot({ version: "v2.1.0" });
    const release: RawRelease = {
      version: "2.1.0",
      assets: [{ name: HOST_ASSET, url: "https://example.invalid/never-fetched.zip", size: 1 }],
    };
    const { events, deps, snapshots, runVersions } = harness({
      installRoot,
      launcherVersion: "2.1.0",
      latest: "2.1.0",
    });

    await runUpdateSequence({
      ...deps,
      checkForUpdate: (options) => checkForUpdate({ ...options, source: new FakeSource(release) }),
    });

    expect(snapshots).toEqual([
      {
        current: "2.1.0",
        latest: "2.1.0",
        available: false,
      },
    ]);
    expect(runVersions).toEqual([]);
    expect(events).not.toContain("install");
    expect(events).not.toContain("stop");
    expect(events).not.toContain("start");
  });

  test("falls back to the launcher version when no install record exists", async () => {
    const installRoot = await tempInstallRoot();
    const release: RawRelease = {
      version: "2.1.0",
      assets: [{ name: HOST_ASSET, url: "https://example.invalid/never-fetched.zip", size: 1 }],
    };
    const { deps, snapshots } = harness({ installRoot, launcherVersion: "2.0.0" });

    await runUpdateSequence({
      ...deps,
      checkForUpdate: (options) => checkForUpdate({ ...options, source: new FakeSource(release) }),
      runUpdate: async () => undefined,
    });

    // A fresh install has no recorded gateway version, so the launcher's own is
    // the only number available — and the update is still offered.
    expect(snapshots[0]?.current).toBe("2.0.0");
    expect(snapshots[0]?.available).toBe(true);
  });
});
