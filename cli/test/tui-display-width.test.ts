import { describe, expect, test } from "bun:test";
import { displayWidth, padToWidth, stripAnsi, truncateToWidth } from "../tui/terminal";

describe("displayWidth", () => {
  test("counts ASCII one cell per character", () => {
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("GET /v1/chat")).toBe(12);
  });

  test("counts CJK as two cells", () => {
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("a日b")).toBe(4);
    expect(displayWidth("한국어")).toBe(6);
  });

  test("counts emoji as two cells, including surrogate pairs", () => {
    expect(displayWidth("😀")).toBe(2);
    expect(displayWidth("a😀b")).toBe(4);
    expect(displayWidth("🎉🎉")).toBe(4);
  });

  test("counts combining marks as zero cells", () => {
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("a\u0300\u0301b")).toBe(2);
  });

  test("ignores ANSI escape sequences", () => {
    expect(displayWidth("\x1b[31merror\x1b[0m")).toBe(5);
    expect(displayWidth("\x1b[2J\x1b[1;1Habc")).toBe(3);
  });
});

describe("truncateToWidth", () => {
  test("returns the text unchanged when it fits", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc");
    expect(truncateToWidth("abc", 3)).toBe("abc");
  });

  test("never splits a wide glyph across the boundary", () => {
    expect(truncateToWidth("日本語", 5)).toBe("日本");
    expect(truncateToWidth("日本語", 3)).toBe("日");
    expect(displayWidth(truncateToWidth("日本語", 3))).toBeLessThanOrEqual(3);
  });

  test("collapses to empty for a non-positive width", () => {
    expect(truncateToWidth("abc", 0)).toBe("");
    expect(truncateToWidth("abc", -4)).toBe("");
  });

  test("strips escapes from the retained text", () => {
    expect(truncateToWidth("\x1b[31mabcdef\x1b[0m", 3)).toBe("abc");
  });
});

describe("padToWidth", () => {
  test("pads with spaces to the exact cell count", () => {
    expect(padToWidth("ab", 5)).toBe("ab   ");
    expect(displayWidth(padToWidth("日本", 6))).toBe(6);
  });

  test("pads a wide glyph to the requested width without exceeding it", () => {
    const padded = padToWidth("日本", 5);
    expect(displayWidth(padded)).toBe(5);
    expect(padded).toBe("日本 ");
  });
});

describe("stripAnsi", () => {
  test("removes SGR and cursor sequences but keeps box drawing", () => {
    expect(stripAnsi("\x1b[33m│ hi │\x1b[0m")).toBe("│ hi │");
  });
});
