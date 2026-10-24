import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChecksumMismatchError, downloadToFile, normalizeChecksum } from "../update/download";

const PAYLOAD = new TextEncoder().encode("lianrouter update artifact\n".repeat(4096));
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

/** Chunk size for the served body; small enough to guarantee many chunks. */
const CHUNK = 4096;

const servers: { stop: (force?: boolean) => Promise<void> }[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-download-test-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Serves `body` in chunks with a declared content-length so the download has a
 * known total. A second path serves the same bytes without a length, which is
 * the chunked-transfer case where progress cannot compute a percentage.
 */
function servePayload(): { url: string; chunkedUrl: string } {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/chunked") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < PAYLOAD.byteLength; offset += CHUNK) {
              controller.enqueue(PAYLOAD.subarray(offset, offset + CHUNK));
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
      }
      if (url.pathname === "/missing") {
        return new Response("not found", { status: 404 });
      }
      return new Response(PAYLOAD, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(PAYLOAD.byteLength),
        },
      });
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return { url: `${base}/artifact.zip`, chunkedUrl: `${base}/chunked` };
}

describe("downloadToFile", () => {
  it("writes the exact bytes and reports the sha256 of what landed", async () => {
    const { url } = servePayload();
    const dir = await tempDir();
    const destination = join(dir, "artifact.zip");

    const result = await downloadToFile({ url, destination, expectedSize: PAYLOAD.byteLength });

    expect(result.bytes).toBe(PAYLOAD.byteLength);
    expect(result.sha256).toBe(PAYLOAD_SHA);
    expect(new Uint8Array(await readFile(destination))).toEqual(PAYLOAD);
  });

  it("fires progress callbacks that start at 0, end at 100, and never decrease", async () => {
    const { url } = servePayload();
    const dir = await tempDir();
    const destination = join(dir, "artifact.zip");

    const percents: number[] = [];
    const totals: (number | undefined)[] = [];
    const received: number[] = [];
    await downloadToFile({
      url,
      destination,
      onProgress: (p) => {
        percents.push(p.percent);
        totals.push(p.total);
        received.push(p.received);
      },
    });

    expect(percents.length).toBeGreaterThanOrEqual(2);
    expect(percents[0]).toBe(0);
    expect(percents.at(-1)).toBe(100);
    for (let index = 1; index < percents.length; index += 1) {
      expect(percents[index]!).toBeGreaterThanOrEqual(percents[index - 1]!);
      expect(received[index]!).toBeGreaterThanOrEqual(received[index - 1]!);
    }
    expect(totals.every((total) => total === PAYLOAD.byteLength)).toBe(true);
  });

  it("reports bytes without a percentage when the server sends no length", async () => {
    const { chunkedUrl } = servePayload();
    const dir = await tempDir();
    const destination = join(dir, "artifact.zip");

    const samples: { received: number; total: number | undefined }[] = [];
    const result = await downloadToFile({
      url: chunkedUrl,
      destination,
      onProgress: (p) => samples.push({ received: p.received, total: p.total }),
    });

    expect(result.bytes).toBe(PAYLOAD.byteLength);
    expect(result.sha256).toBe(PAYLOAD_SHA);
    expect(samples.every((sample) => sample.total === undefined)).toBe(true);
    expect(samples.at(-1)?.received).toBe(PAYLOAD.byteLength);
  });

  it("accepts a sha256: prefixed and uppercase checksum", async () => {
    const { url } = servePayload();
    const dir = await tempDir();
    const destination = join(dir, "artifact.zip");

    await downloadToFile({ url, destination, expectedChecksum: `sha256:${PAYLOAD_SHA.toUpperCase()}` });

    expect((await stat(destination)).size).toBe(PAYLOAD.byteLength);
  });

  it("throws ChecksumMismatchError and removes the partial file on a wrong checksum", async () => {
    const { url } = servePayload();
    const dir = await tempDir();
    const destination = join(dir, "artifact.zip");
    const wrong = "0".repeat(64);

    const error = await downloadToFile({ url, destination, expectedChecksum: wrong }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChecksumMismatchError);
    expect((error as ChecksumMismatchError).expected).toBe(wrong);
    expect((error as ChecksumMismatchError).actual).toBe(PAYLOAD_SHA);
    // The whole point: a failed verification leaves nothing on disk to run.
    expect(await Bun.file(destination).exists()).toBe(false);
  });

  it("throws and leaves no file when the server returns an error status", async () => {
    const { url } = servePayload();
    const dir = await tempDir();
    const destination = join(dir, "artifact.zip");

    const error = await downloadToFile({ url: url.replace("/artifact.zip", "/missing"), destination }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("404");
    expect(await Bun.file(destination).exists()).toBe(false);
  });

  it("throws and removes the partial file when the size does not match", async () => {
    const { url } = servePayload();
    const dir = await tempDir();
    const destination = join(dir, "artifact.zip");

    const error = await downloadToFile({
      url,
      destination,
      expectedSize: PAYLOAD.byteLength + 1024,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("truncated");
    expect(await Bun.file(destination).exists()).toBe(false);
  });

  it("aborts mid-stream and cleans up the partial file", async () => {
    const { url } = servePayload();
    const dir = await tempDir();
    const destination = join(dir, "artifact.zip");

    const controller = new AbortController();
    const error = await downloadToFile({
      url,
      destination,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(await Bun.file(destination).exists()).toBe(false);
  });
});

describe("normalizeChecksum", () => {
  it("lowercases and strips the sha256: prefix", () => {
    expect(normalizeChecksum(`sha256:${PAYLOAD_SHA.toUpperCase()}`)).toBe(PAYLOAD_SHA);
    expect(normalizeChecksum(`  ${PAYLOAD_SHA}  `)).toBe(PAYLOAD_SHA);
    expect(normalizeChecksum(`SHA256:${PAYLOAD_SHA}`)).toBe(PAYLOAD_SHA);
  });
});
