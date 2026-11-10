import { describe, expect, test } from "bun:test";

import { resolveDashboardApp } from "./app-entry";

describe("dashboard app entry resolution", () => {
  test("uses the console app for console roots and deep links", () => {
    expect(resolveDashboardApp("/console")).toBe("console");
    expect(resolveDashboardApp("/console/")).toBe("console");
    expect(resolveDashboardApp("/console/share")).toBe("console");
  });

  test("uses the share app for enrollment roots and deep links", () => {
    expect(resolveDashboardApp("/share")).toBe("share");
    expect(resolveDashboardApp("/share/token")).toBe("share");
    expect(resolveDashboardApp("/share/token/issue")).toBe("share");
  });

  test("routes the root document to the landing page", () => {
    expect(resolveDashboardApp("/")).toBe("landing");
    expect(resolveDashboardApp("/index.html")).toBe("landing");
  });

  test("uses the status app for status roots and deep links", () => {
    expect(resolveDashboardApp("/status")).toBe("status");
    expect(resolveDashboardApp("/status/models")).toBe("status");
  });
});
