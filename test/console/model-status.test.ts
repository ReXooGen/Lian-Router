import { describe, expect, test } from "bun:test";
import {
  STATUS_BUCKET_COUNT,
  STATUS_WINDOW_HOURS,
  classifyFailureShare,
  classifyModelState,
} from "../../src/console/status/model-status";

/**
 * The window and its resolution are a contract with the page: sixty bars over a
 * day is what the timeline draws, and a bucket of zero minutes would divide by
 * zero when the page converts an index to a timestamp.
 */
describe("status window", () => {
  test("splits a 24-hour window into 60 buckets", () => {
    expect(STATUS_WINDOW_HOURS).toBe(24);
    expect(STATUS_BUCKET_COUNT).toBe(60);
  });
});

/**
 * These two thresholds are the whole policy of the page: which colour a bar
 * gets and which word a row carries. Pinned here so a colour change and a
 * policy change stay distinguishable.
 */
describe("failure-share classification", () => {
  test("a clean bucket is ok and a mostly-failing one is down", () => {
    expect(classifyFailureShare(0)).toBe("ok");
    expect(classifyFailureShare(1)).toBe("down");
  });

  test("the degraded band is a real interval, not a single value", () => {
    expect(classifyFailureShare(0.05)).toBe("degraded");
    expect(classifyFailureShare(0.2)).toBe("degraded");
    expect(classifyFailureShare(0.49)).toBe("degraded");
  });

  test("just below the degraded threshold still reads ok", () => {
    expect(classifyFailureShare(0.04)).toBe("ok");
  });

  test("half failing is down, not degraded", () => {
    expect(classifyFailureShare(0.5)).toBe("down");
  });
});

describe("model headline state", () => {
  /**
   * A cooling model is one the router has stopped dialling. Reporting it as
   * anything but down would describe a model as available while it refuses
   * traffic, which is exactly the confusion the page exists to remove.
   */
  test("a cooling model reads down even with perfect recent traffic", () => {
    expect(classifyModelState(100, 0, "2026-01-01T00:00:00.000Z")).toBe("down");
  });

  test("no traffic is idle, which is not a failure", () => {
    expect(classifyModelState(0, 0, null)).toBe("idle");
  });

  test("traffic without cooling derives from the failure share", () => {
    expect(classifyModelState(100, 0, null)).toBe("ok");
    expect(classifyModelState(100, 10, null)).toBe("degraded");
    expect(classifyModelState(100, 80, null)).toBe("down");
  });
});
