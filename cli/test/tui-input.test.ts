import { describe, expect, test } from "bun:test";
import { flushPending, parseKey, parseKeys } from "../tui/input";

const ESC = "\x1b";

describe("parseKey", () => {
  test("maps arrow keys", () => {
    expect(parseKey(Buffer.from(`${ESC}[A`))).toEqual({ type: "up" });
    expect(parseKey(Buffer.from(`${ESC}[B`))).toEqual({ type: "down" });
    expect(parseKey(Buffer.from(`${ESC}[C`))).toEqual({ type: "right" });
    expect(parseKey(Buffer.from(`${ESC}[D`))).toEqual({ type: "left" });
  });

  test("maps application-mode arrows", () => {
    expect(parseKey(Buffer.from(`${ESC}OA`))).toEqual({ type: "up" });
    expect(parseKey(Buffer.from(`${ESC}OD`))).toEqual({ type: "left" });
  });

  test("maps page and home/end variants", () => {
    expect(parseKey(Buffer.from(`${ESC}[5~`))).toEqual({ type: "pageup" });
    expect(parseKey(Buffer.from(`${ESC}[6~`))).toEqual({ type: "pagedown" });
    expect(parseKey(Buffer.from(`${ESC}[H`))).toEqual({ type: "home" });
    expect(parseKey(Buffer.from(`${ESC}[F`))).toEqual({ type: "end" });
    expect(parseKey(Buffer.from(`${ESC}[1~`))).toEqual({ type: "home" });
    expect(parseKey(Buffer.from(`${ESC}[4~`))).toEqual({ type: "end" });
  });

  test("maps control keys and printable letters", () => {
    expect(parseKey(Buffer.from([0x03]))).toEqual({ type: "ctrl-c" });
    expect(parseKey(Buffer.from("\r"))).toEqual({ type: "enter" });
    expect(parseKey(Buffer.from("\n"))).toEqual({ type: "enter" });
    expect(parseKey(Buffer.from([0x7f]))).toEqual({ type: "backspace" });
    expect(parseKey(Buffer.from("q"))).toEqual({ type: "char", char: "q" });
    expect(parseKey(Buffer.from("R"))).toEqual({ type: "char", char: "R" });
  });

  test("decodes several keys arriving in one chunk", () => {
    const { keys, pending } = parseKeys(Buffer.from("ru"));
    expect(keys).toEqual([
      { type: "char", char: "r" },
      { type: "char", char: "u" },
    ]);
    expect(pending.length).toBe(0);
  });
});

describe("split escape sequences", () => {
  test("holds a lone ESC as pending, then completes the arrow", () => {
    const first = parseKeys(Buffer.from(ESC));
    expect(first.keys).toEqual([]);
    expect(first.pending.toString("utf8")).toBe(ESC);

    const second = parseKeys(Buffer.concat([first.pending, Buffer.from("[A")]));
    expect(second.keys).toEqual([{ type: "up" }]);
    expect(second.pending.length).toBe(0);
  });

  test("holds an incomplete CSI parameter run", () => {
    const partial = parseKeys(Buffer.from(`${ESC}[5`));
    expect(partial.keys).toEqual([]);
    expect(partial.pending.toString("utf8")).toBe(`${ESC}[5`);

    const done = parseKeys(Buffer.concat([partial.pending, Buffer.from("~")]));
    expect(done.keys).toEqual([{ type: "pageup" }]);
  });

  test("keeps keys decoded before the split and buffers only the tail", () => {
    const { keys, pending } = parseKeys(Buffer.from(`r${ESC}[`));
    expect(keys).toEqual([{ type: "char", char: "r" }]);
    expect(pending.toString("utf8")).toBe(`${ESC}[`);
  });

  test("a still-dangling ESC flushes as the Escape key", () => {
    const pending = parseKeys(Buffer.from(ESC)).pending;
    expect(flushPending(pending)).toEqual({ type: "escape" });
  });

  test("a bare ESC followed by a non-sequence byte is Escape then that byte", () => {
    const { keys } = parseKeys(Buffer.from(`${ESC}x`));
    expect(keys).toEqual([{ type: "escape" }, { type: "char", char: "x" }]);
  });
});
