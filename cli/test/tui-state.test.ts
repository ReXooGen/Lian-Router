import { describe, expect, test } from "bun:test";
import {
  createInitialView,
  reduceLogLine,
  reduceScroll,
  reduceServer,
  type TuiLogLine,
  type TuiViewState,
} from "../tui/state";

function line(index: number, level = "info"): TuiLogLine {
  return { at: 1_700_000_000_000 + index, level, text: `line ${index}` };
}

function withLogs(count: number): TuiViewState {
  let state = createInitialView();
  for (let index = 0; index < count; index += 1) state = reduceLogLine(state, line(index), 1000);
  return state;
}

describe("createInitialView", () => {
  test("starts empty with a zeroed server and counters", () => {
    const state = createInitialView();
    expect(state.logs).toEqual([]);
    expect(state.scrollOffset).toBe(0);
    expect(state.metrics).toEqual({ requests: 0, errors: 0, inflight: 0 });
    expect(state.server.state).toBe("unknown");
    expect(state.update.available).toBe(false);
  });
});

describe("reduceLogLine", () => {
  test("appends in order without mutating the previous state", () => {
    const first = reduceLogLine(createInitialView(), line(0), 10);
    const second = reduceLogLine(first, line(1), 10);
    expect(first.logs).toHaveLength(1);
    expect(second.logs.map((entry) => entry.text)).toEqual(["line 0", "line 1"]);
  });

  test("evicts the oldest line past capacity and keeps the newest", () => {
    let state = createInitialView();
    for (let index = 0; index < 5; index += 1) state = reduceLogLine(state, line(index), 3);
    expect(state.logs.map((entry) => entry.text)).toEqual(["line 2", "line 3", "line 4"]);
  });

  test("capacity of one keeps only the newest line", () => {
    let state = createInitialView();
    for (let index = 0; index < 4; index += 1) state = reduceLogLine(state, line(index), 1);
    expect(state.logs.map((entry) => entry.text)).toEqual(["line 3"]);
  });

  test("counts a request only for lines carrying a status code", () => {
    const state = reduceLogLine(createInitialView(), { at: 0, level: "info", text: "request routed status=200" }, 10);
    expect(state.metrics.requests).toBe(1);
    const chatter = reduceLogLine(state, { at: 0, level: "info", text: "cache warm" }, 10);
    expect(chatter.metrics.requests).toBe(1);
  });

  test("counts errors from the level and from 5xx statuses", () => {
    let state = reduceLogLine(createInitialView(), { at: 0, level: "error", text: "boom" }, 10);
    expect(state.metrics.errors).toBe(1);
    state = reduceLogLine(state, { at: 0, level: "info", text: "upstream failed status=503" }, 10);
    expect(state.metrics.errors).toBe(2);
    state = reduceLogLine(state, { at: 0, level: "info", text: "ok status=200" }, 10);
    expect(state.metrics.errors).toBe(2);
  });

  test("keeps a reader scrolled away from the tail pinned to a valid offset", () => {
    let state = withLogs(50);
    state = reduceScroll(state, 10, 20);
    expect(state.scrollOffset).toBe(10);
    state = reduceLogLine(state, line(50), 1000);
    expect(state.scrollOffset).toBe(10);
    // Shrinking the ring below the offset cannot leave it dangling.
    const tiny = reduceLogLine({ ...state, logs: state.logs.slice(-2) }, line(51), 1000);
    expect(tiny.scrollOffset).toBe(2);
  });
});

describe("reduceScroll", () => {
  const visible = 10;

  test("clamps at the tail", () => {
    const state = reduceScroll(withLogs(40), -5, visible);
    expect(state.scrollOffset).toBe(0);
  });

  test("clamps at the oldest reachable line", () => {
    const state = reduceScroll(withLogs(40), 10_000, visible);
    expect(state.scrollOffset).toBe(30);
  });

  test("clamps to zero when fewer lines than the viewport", () => {
    const state = reduceScroll(withLogs(4), 10_000, visible);
    expect(state.scrollOffset).toBe(0);
  });

  test("returns the same object when nothing moves", () => {
    const state = withLogs(40);
    expect(reduceScroll(state, 0, visible)).toBe(state);
    expect(reduceScroll(reduceScroll(state, 1000, visible), 1000, visible).scrollOffset).toBe(30);
  });

  test("collapses to the tail for a non-positive viewport", () => {
    const state = reduceScroll(reduceScroll(withLogs(40), 10, visible), -10, 0);
    expect(state.scrollOffset).toBe(0);
  });
});

describe("reduceServer", () => {
  test("replaces the server snapshot and preserves the rest", () => {
    const before = reduceLogLine(createInitialView(), line(0), 10);
    const after = reduceServer(before, { state: "running", port: 12800, pid: 4242, uptimeMs: 252_000, url: "http://localhost:12800" });
    expect(after.server).toEqual({ state: "running", port: 12800, pid: 4242, uptimeMs: 252_000, url: "http://localhost:12800" });
    expect(after.logs).toBe(before.logs);
    expect(after.metrics).toBe(before.metrics);
  });

  test("accepts an absent pid", () => {
    const after = reduceServer(createInitialView(), { state: "stopped", port: 0, pid: undefined, uptimeMs: 0, url: "" });
    expect(after.server.pid).toBeUndefined();
    expect(after.server.state).toBe("stopped");
  });
});
