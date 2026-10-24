/**
 * Streamed artifact download with one-pass hashing.
 *
 * The artifact is a program that will replace the running installation, so the
 * download path carries three requirements that shape the whole file:
 *
 * 1. **Never buffer the artifact.** It is tens of megabytes; holding it in
 *    memory to hash it would double peak usage and stall the console. Chunks go
 *    straight to disk while `createHash` consumes the same bytes, so the
 *    checksum costs one pass over data already in flight rather than a re-read.
 *
 * 2. **A failed or mismatched download must leave nothing behind.** A partial
 *    file at the destination is worse than no file: a later run could stage it,
 *    or a user could run it. Every failure path unlinks the destination.
 *
 * 3. **Progress is throttled, not per-chunk.** A fast local link delivers
 *    thousands of chunks per second; emitting each one floods the UI event loop
 *    with redraws it cannot render. The first chunk and the final byte always
 *    report, so the bar starts at 0 and lands on 100 instead of stopping wherever
 *    the last throttle window ended.
 */
import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";

/** Minimum gap between progress callbacks; the UI cannot render faster than this. */
const PROGRESS_INTERVAL_MS = 100;

export interface DownloadOptions {
  readonly url: string;
  readonly destination: string;
  readonly expectedSize?: number;
  readonly expectedChecksum?: string;
  readonly onProgress?: (p: { received: number; total: number | undefined; percent: number }) => void;
  readonly signal?: AbortSignal;
}

/**
 * Raised when the downloaded bytes do not hash to the expected digest. Typed
 * (rather than a bare `Error`) because the caller must distinguish "the network
 * dropped" — retryable — from "the bytes are not the bytes we asked for", which
 * is a supply-chain signal and must never be retried silently.
 */
export class ChecksumMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`checksum mismatch: expected ${expected}, received ${actual}`);
    this.name = "ChecksumMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Normalizes `sha256:<hex>`, bare `<hex>`, and mixed case to lowercase hex.
 * Both spellings appear in the wild (GitHub's API uses the prefix, hand-written
 * release notes usually do not), and comparing raw strings would reject a
 * correct artifact over formatting.
 */
export function normalizeChecksum(checksum: string): string {
  return checksum.trim().toLowerCase().replace(/^sha256:/, "");
}

/**
 * Streams `url` to `destination`, returning the byte count and hex sha256.
 *
 * Uses an explicit `FileHandle` rather than a stream: it gives precise control
 * over the close that must happen before hashing completes, and it avoids the
 * extra buffering layer a `WriteStream` adds on the same fd.
 */
export async function downloadToFile(options: DownloadOptions): Promise<{ bytes: number; sha256: string }> {
  const { url, destination, expectedSize, expectedChecksum, onProgress, signal } = options;

  const response = await fetch(url, {
    ...(signal === undefined ? {} : { signal }),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`.trim());
  }
  if (response.body === null) {
    throw new Error("download failed: response carried no body");
  }

  // Prefer the server's declared length, fall back to the release metadata. A
  // chunked response reports neither, in which case progress is a byte count
  // with an indeterminate percentage rather than a bar that lies.
  const headerLength = Number(response.headers.get("content-length"));
  const total = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : expectedSize;

  const hash = createHash("sha256");
  const handle = await open(destination, "w");
  const reader = response.body.getReader();
  let received = 0;
  let lastReport = 0;

  const report = (force: boolean): void => {
    if (onProgress === undefined) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) {
      return;
    }
    lastReport = now;
    const percent = total === undefined || total <= 0
      ? 0
      : Math.min(100, Math.floor((received / total) * 100));
    onProgress({ received, total, percent });
  };

  try {
    report(true);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (signal?.aborted === true) {
        throw new Error("download aborted");
      }
      // Hash and write the same chunk. Writing first would let a disk error
      // produce a file whose hash we already counted; hashing first would
      // advance the checksum for bytes that never landed.
      hash.update(value);
      await handle.write(value);
      received += value.byteLength;
      report(false);
    }
    await handle.close();
    report(true);
  } catch (error) {
    // Cancel the body explicitly: an aborted reader that is merely dropped
    // keeps the connection (and its buffer) alive until GC.
    await reader.cancel().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await rm(destination, { force: true });
    throw error;
  }

  const digest = hash.digest("hex");

  if (expectedChecksum !== undefined) {
    const expected = normalizeChecksum(expectedChecksum);
    if (expected !== digest) {
      // The file is removed here rather than left for the caller: nothing that
      // failed verification should exist on disk under a name that suggests it
      // is the update artifact.
      await rm(destination, { force: true });
      throw new ChecksumMismatchError(expected, digest);
    }
  }
  if (expectedSize !== undefined && expectedSize > 0 && received !== expectedSize) {
    await rm(destination, { force: true });
    throw new Error(`download truncated: expected ${expectedSize} bytes, received ${received}`);
  }

  return { bytes: received, sha256: digest };
}
