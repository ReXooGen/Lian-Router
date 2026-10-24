import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayNotInstalledError, ensureGatewayInstalled } from "../src/bootstrap";
import { resolveBinaryPath } from "../src/paths";
import type { RawRelease, UpdateChannel, UpdateSource } from "../update/contracts";

/**
 * First-run bootstrap, exercised end to end against a real archive.
 *
 * The release feed is the only thing faked: `UpdateSource` is the engine's own
 * injection point, so a fake there proves the real download, checksum, extract,
 * and atomic-install path runs. Mocking `downloadToFile` instead would prove the
 * mock, and the case that matters most — an archive whose payload is nested —
 * only fails after a real extraction.
 */

const tempDirs: string[] = [];
const servers: { stop: (force?: boolean) => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-bootstrap-test-"));
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
 * Stored (uncompressed) zip writer. Deterministic bytes matter here: the fixture
 * checksum must be computable without depending on a local compressor version,
 * and the extractor's own suite already proves this format is readable.
 */
function buildStoredZip(
  files: readonly { readonly name: string; readonly content: string }[],
): Uint8Array<ArrayBuffer> {
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
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.byteLength);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
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
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, end];
  const archive = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let cursor = 0;
  for (const part of parts) {
    archive.set(part, cursor);
    cursor += part.byteLength;
  }
  return archive;
}

/** Asset name matching this host, so the engine's selection finds it. */
const HOST_ASSET = `lianrouter-${process.platform}-${process.arch}.zip`;

/** Gateway executable name, mirroring `resolveBinaryName()`. */
const BINARY_NAME = process.platform === "win32" ? "lianrouter.exe" : "lianrouter";

function serveArchive(bytes: Uint8Array<ArrayBuffer>): string {
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

/**
 * Fake feed. Counts construction and calls separately: the fast path must not
 * construct a source at all, and a fake created by the test cannot prove that.
 */
class FakeSource implements UpdateSource {
  readonly #release: RawRelease | null;
  calls = 0;
  readonly channels: UpdateChannel[] = [];

  constructor(release: RawRelease | null) {
    this.#release = release;
  }

  async fetchLatest(channel: UpdateChannel): Promise<RawRelease | null> {
    this.calls += 1;
    this.channels.push(channel);
    return this.#release;
  }
}

interface ReleaseFixture {
  readonly installRoot: string;
  readonly release: RawRelease;
}

/**
 * Builds an install root with no binary plus a servable release.
 *
 * `files` are the archive entries, so a caller can nest the payload to prove the
 * post-install assertion fires.
 */
async function releaseFixture(
  files: readonly { readonly name: string; readonly content: string }[],
  options: { readonly version?: string } = {},
): Promise<ReleaseFixture> {
  const installRoot = join(await tempDir(), "install");
  const archive = buildStoredZip(files);
  const checksum = createHash("sha256").update(archive).digest("hex");
  const url = serveArchive(archive);
  const version = options.version ?? "2.0.1";

  const release: RawRelease = {
    version,
    notesUrl: "https://example.invalid/releases/v2.0.1",
    publishedAt: "2026-01-01T00:00:00Z",
    assets: [{ name: HOST_ASSET, url, size: archive.byteLength, checksum }],
  };
  return { installRoot, release };
}

const FLAT_PAYLOAD = [
  { name: BINARY_NAME, content: "NEW BINARY" },
  { name: "migrations/0000_baseline.sql", content: "BASELINE" },
  { name: "dist/dashboard/index.html", content: "<html></html>" },
];

describe("ensureGatewayInstalled", () => {
  it("returns the installed binary without constructing a release source", async () => {
    const installRoot = join(await tempDir(), "install");
    await mkdir(installRoot, { recursive: true });
    await writeFile(resolveBinaryPath(installRoot), "EXISTING BINARY");
    await writeFile(
      join(installRoot, "version.json"),
      JSON.stringify({ version: "2.0.3", installedAt: "2025-12-01T00:00:00Z", assetName: HOST_ASSET }),
    );

    const source = new FakeSource(null);
    const lines: string[] = [];
    const result = await ensureGatewayInstalled({
      installRoot,
      currentVersion: "2.0.0",
      source,
      log: (line) => lines.push(line),
    });

    expect(result.binaryPath).toBe(resolveBinaryPath(installRoot));
    // `resolveCurrentVersion` prefers the compiled-in version while it is real;
    // the on-disk record only wins for a placeholder build (dev/0.0.0).
    expect(result.version).toBe("2.0.0");
    expect(source.calls).toBe(0);
    expect(lines).toEqual([]);
    expect(await readFile(resolveBinaryPath(installRoot), "utf8")).toBe("EXISTING BINARY");

    // Same fast path, placeholder compiled version: the record is what the
    // launcher reports, and still no feed is contacted.
    const fromRecord = await ensureGatewayInstalled({
      installRoot,
      currentVersion: "0.0.0",
      source,
      log: (line) => lines.push(line),
    });
    expect(fromRecord.version).toBe("2.0.3");
    expect(source.calls).toBe(0);
  });

  it("downloads, verifies, extracts and installs a flat release archive", async () => {
    const { installRoot, release } = await releaseFixture(FLAT_PAYLOAD);
    const source = new FakeSource(release);
    const lines: string[] = [];

    const result = await ensureGatewayInstalled({
      installRoot,
      currentVersion: "2.0.0",
      source,
      log: (line) => lines.push(line),
    });

    expect(result.binaryPath).toBe(resolveBinaryPath(installRoot));
    expect(result.version).toBe("2.0.1");
    expect(await readFile(resolveBinaryPath(installRoot), "utf8")).toBe("NEW BINARY");
    expect(await readFile(join(installRoot, "migrations", "0000_baseline.sql"), "utf8")).toBe("BASELINE");
    expect(await readFile(join(installRoot, "dist", "dashboard", "index.html"), "utf8")).toBe("<html></html>");

    const record = JSON.parse(await readFile(join(installRoot, "version.json"), "utf8")) as {
      version: string;
      assetName: string;
    };
    expect(record.version).toBe("2.0.1");
    expect(record.assetName).toBe(HOST_ASSET);
    expect(lines).toEqual([
      "gateway not installed; fetching the latest release",
      `installing LianRouter 2.0.1 for ${process.platform}-${process.arch}`,
    ]);
    expect(source.calls).toBe(1);
  });

  it("installs when the release version equals the launcher's own version", async () => {
    // The regression that the old `checkForUpdate` gate could not survive: the
    // natural first release is tagged with the same version as the launcher, so
    // `available` was false and a fresh machine refused a release that exists.
    const { installRoot, release } = await releaseFixture(FLAT_PAYLOAD, { version: "2.0.0" });
    const source = new FakeSource(release);
    const lines: string[] = [];

    const result = await ensureGatewayInstalled({
      installRoot,
      currentVersion: "2.0.0",
      source,
      log: (line) => lines.push(line),
    });

    expect(result.version).toBe("2.0.0");
    expect(await readFile(resolveBinaryPath(installRoot), "utf8")).toBe("NEW BINARY");
    const record = JSON.parse(await readFile(join(installRoot, "version.json"), "utf8")) as {
      version: string;
      assetName: string;
    };
    expect(record.version).toBe("2.0.0");
    expect(record.assetName).toBe(HOST_ASSET);
    expect(lines).toContain(`installing LianRouter 2.0.0 for ${process.platform}-${process.arch}`);
    expect(source.calls).toBe(1);
  });

  it("installs a release older than the launcher when it is the only build", async () => {
    // There is no gateway on disk, so "older" is not a downgrade — it is the
    // only thing the operator can run. Refusing it leaves them with nothing.
    const { installRoot, release } = await releaseFixture(FLAT_PAYLOAD, { version: "1.9.0" });
    const lines: string[] = [];

    const result = await ensureGatewayInstalled({
      installRoot,
      currentVersion: "2.0.0",
      source: new FakeSource(release),
      log: (line) => lines.push(line),
    });

    expect(result.version).toBe("1.9.0");
    expect(await readFile(resolveBinaryPath(installRoot), "utf8")).toBe("NEW BINARY");
    const record = JSON.parse(await readFile(join(installRoot, "version.json"), "utf8")) as {
      version: string;
    };
    expect(record.version).toBe("1.9.0");
    expect(lines).toContain(`installing LianRouter 1.9.0 for ${process.platform}-${process.arch}`);
  });

  it("reports a published release with no asset for this host", async () => {
    const installRoot = join(await tempDir(), "install");
    const release: RawRelease = {
      version: "2.1.0",
      assets: [{ name: "lianrouter-plan9-x64.zip", url: "https://example.invalid/x.zip", size: 1 }],
    };

    const error = await ensureGatewayInstalled({
      installRoot,
      currentVersion: "2.0.0",
      source: new FakeSource(release),
      log: () => undefined,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayNotInstalledError);
    const failure = error as GatewayNotInstalledError;
    expect(failure.message).toContain(`${process.platform}-${process.arch}`);
    expect(failure.message).toContain("2.1.0");
    expect(failure.message).toContain("no build for");
    expect(failure.releaseUrl).toBe("https://github.com/ReXooGen/Lian-Router/releases");
    expect(failure.message).toContain(failure.releaseUrl);
  });

  it("reports an empty feed as unpublished, not as a platform gap", async () => {
    const installRoot = join(await tempDir(), "install");

    const error = await ensureGatewayInstalled({
      installRoot,
      currentVersion: "2.0.0",
      source: new FakeSource(null),
      log: () => undefined,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayNotInstalledError);
    const failure = error as GatewayNotInstalledError;
    expect(failure.message).toContain("no LianRouter release published");
    expect(failure.message).toContain(`${process.platform}-${process.arch}`);
    expect(failure.message).toContain("https://github.com/ReXooGen/Lian-Router/releases");
    expect(failure.message).not.toContain("no build for");
  });

  it("refuses an asset without a digest", async () => {
    const installRoot = join(await tempDir(), "install");
    const archive = buildStoredZip(FLAT_PAYLOAD);
    const release: RawRelease = {
      version: "2.0.1",
      assets: [{ name: HOST_ASSET, url: serveArchive(archive), size: archive.byteLength }],
    };

    const error = await ensureGatewayInstalled({
      installRoot,
      currentVersion: "2.0.0",
      source: new FakeSource(release),
      log: () => undefined,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayNotInstalledError);
    expect((error as GatewayNotInstalledError).message).toContain("no sha256 digest");
    expect(existsSync(resolveBinaryPath(installRoot))).toBe(false);
  });

  it("names the archive entries when the payload is nested one level deep", async () => {
    const nested = FLAT_PAYLOAD.map((file) => ({ name: `lianrouter/${file.name}`, content: file.content }));
    const { installRoot, release } = await releaseFixture(nested);

    const error = await ensureGatewayInstalled({
      installRoot,
      currentVersion: "2.0.0",
      source: new FakeSource(release),
      log: () => undefined,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GatewayNotInstalledError);
    const message = (error as GatewayNotInstalledError).message;
    // The "silent loop" guard: the install itself succeeds, so only this
    // assertion can turn a spawn-time ENOENT into an actionable message.
    expect(message).toContain("is missing");
    expect(message).toContain("lianrouter");
    expect(message).toContain("nested one level deep");
    // No runnable file at the launcher's spawn path. The nested payload does
    // leave a *directory* named `lianrouter` there on POSIX hosts, so asserting
    // bare existence would encode a Windows-only shape; what the launcher needs
    // is that nothing executable sits at the path it will spawn.
    expect(statSync(resolveBinaryPath(installRoot), { throwIfNoEntry: false })?.isFile()).not.toBe(true);
    // The archive's actual top-level entry is named, so the operator can see
    // that the release was built with the payload under `lianrouter/`.
    expect(message).toContain("the archive's top-level entries were lianrouter");
    // No version was recorded: nothing usable was installed.
    expect(existsSync(join(installRoot, "version.json"))).toBe(false);
  });
});
