import { describe, expect, test } from "bun:test";
import { renderView } from "../tui/render";
import { createInitialView, reduceLogLine, reduceScroll, reduceServer, type TuiLogLine, type TuiViewState } from "../tui/state";
import { displayWidth, stripAnsi } from "../tui/terminal";

const SIZE = { rows: 24, cols: 80 };

function line(index: number, level = "info", text = `line ${index}`): TuiLogLine {
  return { at: 1_700_000_000_000 + index * 1000, level, text };
}

function withLogs(count: number, capacity = 5000): TuiViewState {
  let state = createInitialView();
  for (let index = 0; index < count; index += 1) state = reduceLogLine(state, line(index), capacity);
  return state;
}

function running(): TuiViewState {
  return reduceServer(withLogs(0), {
    state: "running",
    port: 12800,
    pid: 12345,
    uptimeMs: 252_000,
    url: "http://localhost:12800",
  });
}

describe("frame geometry", () => {
  test("every line is exactly cols wide, plain and coloured", () => {
    for (const cols of [40, 80, 121, 200]) {
      const state = withLogs(30);
      for (const color of [false, true]) {
        const frame = renderView(state, { rows: 24, cols }, { color });
        expect(frame).toHaveLength(24);
        for (const row of frame) expect(displayWidth(row)).toBe(cols);
      }
    }
  });

  test("emits exactly rows lines at the minimum height", () => {
    const frame = renderView(running(), { rows: 9, cols: 60 }, { color: false });
    expect(frame).toHaveLength(9);
    for (const row of frame) expect(displayWidth(row)).toBe(60);
  });

  test("the plain form contains no escape sequences", () => {
    const frame = renderView(withLogs(20), SIZE, { color: false });
    for (const row of frame) expect(row.includes("\x1b")).toBe(false);
  });
});

describe("header and footer content", () => {
  test("shows the URL, version, and key hints", () => {
    const plain = renderView(running(), SIZE, { color: false, version: "2.0.0" }).join("\n");
    expect(plain).toContain("http://localhost:12800");
    expect(plain).toContain("v2.0.0");
    expect(plain).toContain("pid 12345");
    expect(plain).toContain("r restart");
    expect(plain).toContain("s stop");
    expect(plain).toContain("o open web");
    expect(plain).toContain("u update");
    expect(plain).toContain("q quit");
  });

  test("right-aligns the version against the title bar's closing corner", () => {
    const [title] = renderView(running(), SIZE, { color: false, version: "9.9.9" });
    expect(title?.endsWith(" v9.9.9 ┐")).toBe(true);
    expect(title?.startsWith("┌ LianRouter ─")).toBe(true);
  });

  test("renders uptime and counters", () => {
    let state = running();
    state = reduceLogLine(state, line(1, "info", "routed status=200"), 5000);
    state = reduceLogLine(state, line(2, "info", "routed status=200"), 5000);
    state = reduceLogLine(state, line(3, "error", "upstream 500"), 5000);
    state = reduceLogLine(state, line(4, "info", "cache warm"), 5000);
    const plain = stripAnsi(renderView(state, SIZE, { color: true }).join("\n"));
    expect(plain).toContain("uptime 00:04:12");
    // Three lines carry a status code; the fourth is chatter and must not count.
    expect(plain).toContain("requests 3");
    expect(plain).toContain("errors 1");
  });

  test("marks an unreachable server with a hollow dot", () => {
    const state = reduceServer(createInitialView(), { state: "unreachable", port: 0, pid: undefined, uptimeMs: 0, url: "" });
    const plain = renderView(state, SIZE, { color: false }).join("\n");
    expect(plain).toContain("○ unreachable");
    expect(plain).toContain("control server offline");
  });
});

describe("log area", () => {
  test("renders exactly rows - 6 log rows for a 1000-line buffer", () => {
    const state = withLogs(1000);
    const frame = renderView(state, SIZE, { color: false });
    expect(frame).toHaveLength(24);
    const logRows = frame.slice(3, 21);
    expect(logRows).toHaveLength(18);
    expect(logRows.every((row) => row.includes("line "))).toBe(true);
  });

  test("shows the newest line at the tail", () => {
    const frame = renderView(withLogs(1000), SIZE, { color: false });
    expect(frame[20]).toContain("line 999");
    expect(frame[3]).toContain("line 982");
    expect(frame.join("\n")).not.toContain("line 981 ");
  });

  test("honours scrollOffset by walking back from the tail", () => {
    const state = reduceScroll(withLogs(100), 18, 18);
    const frame = renderView(state, SIZE, { color: false });
    expect(frame[3]).toContain("line 64");
    expect(frame[20]).toContain("line 81");
    expect(frame.join("\n")).toContain("[scrolled 18]");
  });

  test("pads a short buffer with blank rows so the footer stays fixed", () => {
    const frame = renderView(withLogs(2), SIZE, { color: false });
    expect(frame).toHaveLength(24);
    expect(frame[3]).toContain("line 0");
    expect(frame[4]).toContain("line 1");
    expect(frame[5]).toBe(`│ ${" ".repeat(76)} │`);
  });

  test("truncates a CJK line without exceeding the frame width", () => {
    let state = running();
    state = reduceLogLine(state, line(0, "info", "日".repeat(200)), 10);
    const frame = renderView(state, { rows: 24, cols: 40 }, { color: false });
    for (const row of frame) expect(displayWidth(row)).toBe(40);
    expect(frame[3]).toContain("日");
    expect(frame[3]?.includes("\n")).toBe(false);
  });
});

describe("colour", () => {
  test("wraps an error line in the red SGR sequence", () => {
    let state = running();
    state = reduceLogLine(state, line(0, "error", "boom"), 10);
    const coloured = renderView(state, SIZE, { color: true });
    const errorRow = coloured.find((row) => row.includes("boom"));
    expect(errorRow).toBeDefined();
    expect(errorRow?.includes("\x1b[31m")).toBe(true);
    expect(errorRow?.includes("\x1b[0m")).toBe(true);
    expect(displayWidth(errorRow ?? "")).toBe(80);
  });

  test("uses yellow for warn and dim for debug", () => {
    let state = running();
    state = reduceLogLine(state, line(0, "warn", "careful"), 10);
    state = reduceLogLine(state, line(1, "debug", "noise"), 10);
    const coloured = renderView(state, SIZE, { color: true }).join("\n");
    expect(coloured).toContain("\x1b[33m");
    expect(coloured).toContain("\x1b[2m");
  });

  test("plain mode never emits the level sequences", () => {
    let state = running();
    state = reduceLogLine(state, line(0, "error", "boom"), 10);
    const plain = renderView(state, SIZE, { color: false }).join("\n");
    expect(plain).not.toContain("\x1b[31m");
    expect(plain).toContain("ERROR boom");
  });
});
