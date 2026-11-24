import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  VERSION_SOURCES,
  _resetCodexVersion,
  getCodexVersion,
  resolveCodexVersion,
} from "../../../../src/providers/operations/client-versions";
import { jsonResponse } from "../../../helpers/sse-fixtures";


describe("Codex CLI client version", () => {
  beforeEach(() => {
    _resetCodexVersion();
  });

  afterEach(() => {
    _resetCodexVersion();
  });

  test("pinned fallback is used before discovery", () => {
    // Relationship, not the literal: the fallback moves with every release
    // refresh, and pinning it here turned each bump into a test edit — the same
    // edit as deleting the assertion.
    expect(getCodexVersion()).toBe(VERSION_SOURCES.codex.fallback);
    expect(VERSION_SOURCES.codex.fallback).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("resolves from the npm registry", async () => {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).includes("registry.npmjs.org")
        ? jsonResponse({ version: "0.155.0" })
        : new Response("missing", { status: 404 })) as unknown as typeof fetch;

    await resolveCodexVersion(fetcher);
    expect(getCodexVersion()).toBe("0.155.0");
  });

  test("keeps the pinned fallback when the registry fails", async () => {
    const fetcher = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    await resolveCodexVersion(fetcher);
    expect(getCodexVersion()).toBe(VERSION_SOURCES.codex.fallback);
  });

  test("serves a cached result without re-fetching", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return jsonResponse({ version: "0.156.0" });
    }) as unknown as typeof fetch;

    await resolveCodexVersion(fetcher);
    await resolveCodexVersion(fetcher);
    expect(calls).toBe(1);
    expect(getCodexVersion()).toBe("0.156.0");
  });
});