import { describe, expect, it } from "bun:test";

import type { BootstrapProgress } from "../src/bootstrap";
import { createProgressReporter, formatBytes, formatProgressLine } from "../src/progress";

/**
 * The renderer is the only part of the first-run flow the operator watches, and
 * its two output shapes have opposite requirements: a TTY must rewrite one line
 * in place, a pipe must not emit a line per percent. Both are asserted on the
 * emitted chunks, because "how many lines land in a CI log" is the behavior.
 */

function progress(overrides: Partial<BootstrapProgress> = {}): BootstrapProgress {
  return { phase: "downloading", percent: 42, message: "downloading archive.zip", ...overrides };
}

interface Capture {
  readonly chunks: string[];
  readonly text: string;
  readonly sink: { write: (chunk: string) => void; isTTY: boolean };
}

function capture(isTTY: boolean): Capture {
  const chunks: string[] = [];
  return {
    chunks,
    get text(): string {
      return chunks.join("");
    },
    sink: {
      write: (chunk: string) => {
        chunks.push(chunk);
      },
      isTTY,
    },
  };
}

describe("formatBytes", () => {
  it("uses one decimal and the unit the size belongs to", () => {
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(44.7 * 1024 ** 2)).toBe("44.7 MB");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
  });
});

describe("formatProgressLine", () => {
  it("shows received and total during the download", () => {
    const line = formatProgressLine(
      progress({ bytesReceived: 19.2 * 1024 ** 2, bytesTotal: 44.7 * 1024 ** 2 }),
    );
    expect(line).toContain("42%");
    expect(line).toContain("19.2 MB / 44.7 MB");
  });

  it("shows received alone when the total is unknown", () => {
    const line = formatProgressLine(progress({ bytesReceived: 5 * 1024 ** 2 }));
    expect(line).toContain("5.0 MB");
    expect(line).not.toContain("/");
  });

  it("keeps the engine's message for phases without byte counters", () => {
    const line = formatProgressLine(
      progress({ phase: "verifying", percent: 78, message: "checksum ok (sha256 0123456789ab…)" }),
    );
    expect(line).toContain("checksum ok");
    expect(line).toContain("78%");
  });
});

describe("createProgressReporter", () => {
  it("rewrites one line in place on a TTY", () => {
    const out = capture(true);
    const reporter = createProgressReporter(out.sink);

    reporter.update(progress({ percent: 10, bytesReceived: 1024 ** 2, bytesTotal: 10 * 1024 ** 2 }));
    reporter.update(progress({ percent: 42, bytesReceived: 4.2 * 1024 ** 2, bytesTotal: 10 * 1024 ** 2 }));
    reporter.finish();

    // Every update starts with a carriage return: that is what keeps the line
    // from filling the scrollback.
    expect(out.chunks.filter((chunk) => chunk.startsWith("\r"))).toHaveLength(2);
    // Exactly one newline for the whole download phase, at the end.
    expect(out.chunks.filter((chunk) => chunk === "\n")).toHaveLength(1);
    // The frames are cumulative in the captured buffer (a terminal overwrites
    // them visually), so the last frame is what the operator is looking at.
    const frames = out.chunks.filter((chunk) => chunk.startsWith("\r"));
    expect(frames.at(-1)).toContain("42%");
    expect(frames.at(-1)).toContain("4.2 MB / 10.0 MB");
  });

  it("starts a new line when the phase changes", () => {
    const out = capture(true);
    const reporter = createProgressReporter(out.sink);

    reporter.update(progress({ percent: 70, bytesReceived: 44.7 * 1024 ** 2, bytesTotal: 44.7 * 1024 ** 2 }));
    reporter.update(progress({ phase: "verifying", percent: 78, message: "verifying checksum" }));
    reporter.finish();

    // The completed download line is closed, then the verify line is rewritten
    // in place, then closed once by finish().
    expect(out.chunks.filter((chunk) => chunk === "\n")).toHaveLength(2);
    expect(out.text).toContain("downloading");
    expect(out.text).toContain("verifying");
  });

  it("emits one line per phase, never per percent, off a TTY", () => {
    const out = capture(false);
    const reporter = createProgressReporter(out.sink);

    for (const percent of [0, 5, 10, 42, 69]) {
      reporter.update(progress({ percent, bytesReceived: percent * 1024 ** 2, bytesTotal: 100 * 1024 ** 2 }));
    }
    reporter.update(progress({ phase: "extracting", percent: 80, message: "extracting archive" }));
    reporter.update(progress({ phase: "installing", percent: 90, message: "installed lianrouter.exe" }));
    reporter.update(progress({ phase: "done", percent: 100, message: "installed 2.1.0" }));
    reporter.finish();

    const lines = out.text.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("downloading");
    expect(lines.at(-1)).toContain("done");
    // No carriage returns at all: a redirected log has no cursor to move.
    expect(out.text).not.toContain("\r");
  });

  it("finish is idempotent and safe before any update", () => {
    const out = capture(true);
    const reporter = createProgressReporter(out.sink);
    reporter.finish();
    reporter.finish();
    expect(out.text).toBe("");

    reporter.update(progress());
    reporter.finish();
    reporter.finish();
    expect(out.chunks.filter((chunk) => chunk === "\n")).toHaveLength(1);
  });
});
