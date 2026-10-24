import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractArchive } from "../update/extract";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-extract-test-"));
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
 * Minimal stored-zip writer. Hand-rolled so an entry name can be hostile: no
 * archive tool will *create* a `../` entry, which is exactly the case the
 * extractor must reject, so the fixture has to be assembled byte by byte.
 */
function zipWithEntries(entries: readonly { readonly name: string; readonly content: string }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
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

    parts.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }

  const centralSize = centrals.reduce((total, entry) => total + entry.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const all = [...parts, ...centrals, end];
  const total = all.reduce((sum, part) => sum + part.byteLength, 0);
  const archive = new Uint8Array(total);
  let cursor = 0;
  for (const part of all) {
    archive.set(part, cursor);
    cursor += part.byteLength;
  }
  return archive;
}

async function writeArchive(entries: readonly { readonly name: string; readonly content: string }[]): Promise<string> {
  const dir = await tempDir();
  const archivePath = join(dir, "payload.zip");
  await Bun.write(archivePath, zipWithEntries(entries));
  return archivePath;
}

describe("extractArchive", () => {
  it("extracts a normal payload and reports monotonic progress", async () => {
    const archivePath = await writeArchive([
      { name: "lianrouter.exe", content: "NEW BINARY" },
      { name: "migrations/0001_init.sql", content: "NEW MIGRATION" },
    ]);
    const staging = join(await tempDir(), "staged");

    const percents: number[] = [];
    await extractArchive(archivePath, staging, (p) => percents.push(p.percent));

    expect(await Bun.file(join(staging, "lianrouter.exe")).text()).toBe("NEW BINARY");
    expect(await Bun.file(join(staging, "migrations", "0001_init.sql")).text()).toBe("NEW MIGRATION");
    expect(percents.at(-1)).toBe(100);
    for (let index = 1; index < percents.length; index += 1) {
      expect(percents[index]!).toBeGreaterThanOrEqual(percents[index - 1]!);
    }
  });

  it("rejects a parent-traversal entry before writing anything", async () => {
    const archivePath = await writeArchive([
      { name: "lianrouter.exe", content: "NEW BINARY" },
      { name: "../escaped.txt", content: "owned" },
    ]);
    const base = await tempDir();
    const staging = join(base, "staged");

    const error = await extractArchive(archivePath, staging).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("escape the staging directory");
    // The decisive assertion: the hostile write never happened, and the benign
    // sibling entry was not extracted either — the archive is refused whole.
    expect(await Bun.file(join(base, "escaped.txt")).exists()).toBe(false);
    expect(await Bun.file(join(staging, "lianrouter.exe")).exists()).toBe(false);
  });

  it("rejects an absolute entry", async () => {
    const archivePath = await writeArchive([{ name: "/tmp/absolute-escape.txt", content: "owned" }]);
    const staging = join(await tempDir(), "staged");

    const error = await extractArchive(archivePath, staging).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("escape the staging directory");
  });

  it("rejects a nested traversal that climbs out from a subdirectory", async () => {
    const archivePath = await writeArchive([
      { name: "dist/../../escaped.txt", content: "owned" },
    ]);
    const base = await tempDir();
    const staging = join(base, "staged");

    const error = await extractArchive(archivePath, staging).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("escape the staging directory");
    expect(await Bun.file(join(base, "escaped.txt")).exists()).toBe(false);
  });

  it("rejects an unsupported archive format by name", async () => {
    const dir = await tempDir();
    const archivePath = join(dir, "payload.rar");
    await Bun.write(archivePath, "not really a rar");

    const error = await extractArchive(archivePath, join(dir, "staged")).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("unsupported archive format");
  });

  it("creates the staging directory when it does not exist", async () => {
    const archivePath = await writeArchive([{ name: "only.txt", content: "x" }]);
    const staging = join(await tempDir(), "deep", "staged");

    await extractArchive(archivePath, staging);

    expect(await readdir(staging)).toContain("only.txt");
  });
});
