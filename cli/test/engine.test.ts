import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RawRelease, UpdateChannel, UpdateInfo, UpdateProgress, UpdateSource } from "../update/contracts";
import { checkForUpdate, runUpdate } from "../update/engine";
import { readInstalledVersion } from "../update/version-file";

const tempDirs: string[] = [];
const servers: { stop: (force?: boolean) => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-engine-test-"));
  tempDirs.push(dir);
  return dir;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a stored (uncompressed) zip in memory.
 *
 * Written by hand rather than shelled out to `tar -a`: the test must produce the
 * same archive on every host, and a compressed archive would make the byte
 * offsets and the expected checksum depend on the local compressor's version.
 * Stored entries need no codec, so the bytes are fully determined by the input.
 */
function buildStoredZip(files: readonly { readonly name: string; readonly content: string }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, 0, true); // method: stored
    localView.setUint16(10, 0, true); // mod time
    localView.setUint16(12, 0, true); // mod date
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.byteLength);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }

  const centralSize = centrals.reduce((total, entry) => total + entry.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const parts = [...locals, ...centrals, end];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const archive = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    archive.set(part, cursor);
    cursor += part.byteLength;
  }
  return archive;
}

/** Asset name matching the host, so the engine's platform selection finds it. */
const HOST_ASSET = `lianrouter-${process.platform}-${process.arch}.zip`;

function serveArchive(bytes: Uint8Array<ArrayBuffer>): string {
  // `Uint8Array<ArrayBufferLike>` is not a `BodyInit` under this lib set, and a
  // blob copies once at server start — cheaper than a per-request conversion.
  const body = new Blob([bytes]);
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, {
        headers: { "content-type": "application/zip", "content-length": String(bytes.byteLength) },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/${HOST_ASSET}`;
}

/** Fake source; the real one is exercised only by its pure helpers in tests. */
class FakeSource implements UpdateSource {
  readonly #release: RawRelease | null;
  readonly channels: UpdateChannel[] = [];

  constructor(release: RawRelease | null) {
    this.#release = release;
  }

  async fetchLatest(channel: UpdateChannel): Promise<RawRelease | null> {
    this.channels.push(channel);
    return this.#release;
  }
}

async function fixture(): Promise<{
  installRoot: string;
  archive: Uint8Array;
  checksum: string;
  release: RawRelease;
}> {
  const installRoot = join(await tempDir(), "install");
  await mkdir(join(installRoot, "migrations"), { recursive: true });
  await writeFile(join(installRoot, "lianrouter.exe"), "OLD BINARY");
  await writeFile(join(installRoot, "migrations", "0001_init.sql"), "OLD MIGRATION");

  const archive = buildStoredZip([
    { name: "lianrouter.exe", content: "NEW BINARY" },
    { name: "migrations/0001_init.sql", content: "NEW MIGRATION" },
  ]);
  const checksum = createHash("sha256").update(archive).digest("hex");
  const url = serveArchive(archive);

  const release: RawRelease = {
    version: "2.1.0",
    notesUrl: "https://example.invalid/releases/2.1.0",
    publishedAt: "2026-01-01T00:00:00Z",
    assets: [{ name: HOST_ASSET, url, size: archive.byteLength, checksum }],
  };

  return { installRoot, archive, checksum, release };
}

describe("checkForUpdate", () => {
  it("reports an available update with the host asset resolved", async () => {
    const { release } = await fixture();
    const info = await checkForUpdate({ currentVersion: "2.0.0", source: new FakeSource(release) });

    expect(info.current).toBe("2.0.0");
    expect(info.latest).toBe("2.1.0");
    expect(info.available).toBe(true);
    expect(info.assetName).toBe(HOST_ASSET);
    expect(info.checksum).toBe(release.assets[0]!.checksum!);
  });

  it("reports no update when the running version is current", async () => {
    const { release } = await fixture();
    const info = await checkForUpdate({ currentVersion: "2.1.0", source: new FakeSource(release) });

    expect(info.available).toBe(false);
    expect(info.latest).toBe("2.1.0");
  });

  it("reports no update when the channel is empty", async () => {
    const info = await checkForUpdate({ currentVersion: "2.0.0", source: new FakeSource(null) });
    expect(info.available).toBe(false);
    expect(info.latest).toBe("2.0.0");
  });

  it("reports no update when the release has no asset for this host", async () => {
    const release: RawRelease = {
      version: "9.9.9",
      assets: [{ name: "lianrouter-plan9-x64.zip", url: "https://example.invalid/x.zip", size: 1 }],
    };
    const info = await checkForUpdate({ currentVersion: "2.0.0", source: new FakeSource(release) });

    // A newer release exists, but not for us — distinct from being current.
    expect(info.latest).toBe("9.9.9");
    expect(info.available).toBe(false);
    expect(info.assetName).toBeUndefined();
  });

  it("defaults to the stable channel", async () => {
    const { release } = await fixture();
    const source = new FakeSource(release);
    await checkForUpdate({ currentVersion: "2.0.0", source });
    expect(source.channels).toEqual(["stable"]);
  });
});

describe("runUpdate", () => {
  it("runs the full sequence, installs the payload, and records the version", async () => {
    const { installRoot, release } = await fixture();
    const events: UpdateProgress[] = [];
    let restarted = false;

    await runUpdate({
      installRoot,
      currentVersion: "2.0.0",
      source: new FakeSource(release),
      restart: async () => {
        restarted = true;
      },
      onProgress: (p) => events.push(p),
    });

    const phases = [...new Set(events.map((event) => event.phase))];
    expect(phases).toEqual([
      "checking",
      "downloading",
      "verifying",
      "extracting",
      "installing",
      "restarting",
      "done",
    ]);

    // Monotonic across the whole run, not just within a phase.
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.percent).toBeGreaterThanOrEqual(events[index - 1]!.percent);
    }
    expect(events.at(-1)?.percent).toBe(100);
    expect(events.some((event) => event.phase === "error")).toBe(false);

    expect(restarted).toBe(true);
    expect(await readFile(join(installRoot, "lianrouter.exe"), "utf-8")).toBe("NEW BINARY");
    expect(await readFile(join(installRoot, "migrations", "0001_init.sql"), "utf-8")).toBe("NEW MIGRATION");
    expect(await Bun.file(join(installRoot, ".backup")).exists()).toBe(false);

    const record = await readInstalledVersion(installRoot);
    expect(record?.version).toBe("2.1.0");
    expect(record?.assetName).toBe(HOST_ASSET);
  });

  it("reaches 100 percent even when the caller supplies no restart hook", async () => {
    const { installRoot, release } = await fixture();
    const events: UpdateProgress[] = [];

    await runUpdate({
      installRoot,
      currentVersion: "2.0.0",
      source: new FakeSource(release),
      onProgress: (p) => events.push(p),
    });

    expect(events.at(-1)?.phase).toBe("done");
    expect(events.at(-1)?.percent).toBe(100);
  });

  it("emits an error event and rethrows when the checksum does not match", async () => {
    const { installRoot, release } = await fixture();
    const tampered: RawRelease = {
      ...release,
      assets: [{ ...release.assets[0]!, checksum: "a".repeat(64) }],
    };
    const events: UpdateProgress[] = [];

    const error = await runUpdate({
      installRoot,
      currentVersion: "2.0.0",
      source: new FakeSource(tampered),
      onProgress: (p) => events.push(p),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const failure = events.at(-1);
    expect(failure?.phase).toBe("error");
    expect(failure?.error).toContain("checksum mismatch");
    // Nothing was installed and the previous bytes are intact.
    expect(await readFile(join(installRoot, "lianrouter.exe"), "utf-8")).toBe("OLD BINARY");
  });

  it("refuses a release asset that carries no checksum", async () => {
    const { installRoot, release } = await fixture();
    const unsigned: RawRelease = {
      ...release,
      assets: [{ name: HOST_ASSET, url: release.assets[0]!.url, size: release.assets[0]!.size }],
    };
    const events: UpdateProgress[] = [];

    const error = await runUpdate({
      installRoot,
      currentVersion: "2.0.0",
      source: new FakeSource(unsigned),
      onProgress: (p) => events.push(p),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("no checksum");
    expect(events.at(-1)?.phase).toBe("error");
  });

  it("refuses to run when there is nothing to install", async () => {
    const { installRoot } = await fixture();
    const events: UpdateProgress[] = [];
    const source = new FakeSource({
      version: "2.0.0",
      assets: [{ name: HOST_ASSET, url: "https://example.invalid/x.zip", size: 1 }],
    });

    const error = await runUpdate({
      installRoot,
      currentVersion: "2.0.0",
      source,
      onProgress: (p) => events.push(p),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("no update available");
    expect(events.at(-1)?.phase).toBe("error");
  });

  it("surfaces a source failure as an error phase", async () => {
    const { installRoot } = await fixture();
    const failing: UpdateSource = {
      fetchLatest: async () => {
        throw new Error("release feed rate limited");
      },
    };
    const events: UpdateProgress[] = [];

    const error = await runUpdate({
      installRoot,
      currentVersion: "2.0.0",
      source: failing,
      onProgress: (p) => events.push(p),
    }).catch((e: unknown) => e);

    expect((error as Error).message).toContain("rate limited");
    expect(events.at(-1)?.phase).toBe("error");
    expect(events.at(-1)?.error).toContain("rate limited");
  });
});

describe("checkForUpdate return shape", () => {
  it("omits optional fields instead of emitting undefined values", async () => {
    const release: RawRelease = {
      version: "3.0.0",
      assets: [{ name: HOST_ASSET, url: "https://example.invalid/x.zip", size: 10 }],
    };
    const info: UpdateInfo = await checkForUpdate({
      currentVersion: "2.0.0",
      source: new FakeSource(release),
    });

    // `exactOptionalPropertyTypes` makes `notesUrl: undefined` a different type
    // from an absent key, so the check must prove absence, not just falsiness.
    expect("notesUrl" in info).toBe(false);
    expect("publishedAt" in info).toBe(false);
    expect("checksum" in info).toBe(false);
  });
});
