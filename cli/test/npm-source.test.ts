import { describe, expect, it } from "bun:test";

import { checkLauncherVersion, updateCheckDisabled } from "../update/npm-source";

/**
 * The registry check is exercised through its two seams — `fetchImpl` and
 * `registryUrl` — so no case here touches the network. The production path is a
 * real `fetch` against the real manifest URL; the shape it must parse is pinned
 * below, and the failure arms are what keep a startup notice from turning a
 * network problem into "you are current".
 */

const REGISTRY = "https://registry.test.invalid/lianrouter/latest";

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("checkLauncherVersion", () => {
  it("reports outdated when the published version is newer", async () => {
    const result = await checkLauncherVersion({
      currentVersion: "2.2.2",
      registryUrl: REGISTRY,
      fetchImpl: jsonFetch({ name: "lianrouter", version: "9.9.9" }),
    });

    expect(result).toEqual({ status: "outdated", latest: "9.9.9", current: "2.2.2" });
  });

  it("reports current when the published version matches", async () => {
    const result = await checkLauncherVersion({
      currentVersion: "2.2.2",
      registryUrl: REGISTRY,
      fetchImpl: jsonFetch({ name: "lianrouter", version: "2.2.2" }),
    });

    expect(result).toEqual({ status: "current", latest: "2.2.2" });
  });

  it("reports current when the registry is behind", async () => {
    // A mirror that has not caught up, or a yanked release: never offer a
    // downgrade as an update.
    const result = await checkLauncherVersion({
      currentVersion: "2.2.2",
      registryUrl: REGISTRY,
      fetchImpl: jsonFetch({ version: "2.0.0" }),
    });

    expect(result).toEqual({ status: "current", latest: "2.0.0" });
  });

  it("returns unavailable when the request rejects", async () => {
    const result = await checkLauncherVersion({
      currentVersion: "2.2.2",
      registryUrl: REGISTRY,
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND registry.test.invalid");
      }) as unknown as typeof fetch,
    });

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" ? result.reason : "").toContain("unreachable");
  });

  it("returns unavailable on a non-2xx response", async () => {
    const result = await checkLauncherVersion({
      currentVersion: "2.2.2",
      registryUrl: REGISTRY,
      fetchImpl: jsonFetch({ error: "not_found" }, 404),
    });

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" ? result.reason : "").toContain("404");
  });

  it("returns unavailable when the body is not JSON", async () => {
    const result = await checkLauncherVersion({
      currentVersion: "2.2.2",
      registryUrl: REGISTRY,
      fetchImpl: (async () =>
        new Response("<html>maintenance</html>", {
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    });

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" ? result.reason : "").toContain("non-JSON");
  });

  it("returns unavailable when the version is not semver-ish", async () => {
    // A manifest with a nonsense version must not be coerced into 0.0.0 and
    // reported as a downgrade, nor into "newer" and advertised as an update.
    const result = await checkLauncherVersion({
      currentVersion: "2.2.2",
      registryUrl: REGISTRY,
      fetchImpl: jsonFetch({ name: "lianrouter", version: "latest" }),
    });

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" ? result.reason : "").toContain("no usable version");
  });

  it("returns unavailable when the body carries no version", async () => {
    const result = await checkLauncherVersion({
      currentVersion: "2.2.2",
      registryUrl: REGISTRY,
      fetchImpl: jsonFetch({ name: "lianrouter" }),
    });

    expect(result.status).toBe("unavailable");
  });

  it("gives up at its own deadline instead of waiting for the registry", async () => {
    // A registry that accepts the request and then hangs is the case the
    // deadline exists for: the startup path must reach the menu regardless.
    const started = Date.now();
    const result = await checkLauncherVersion({
      currentVersion: "2.2.2",
      registryUrl: REGISTRY,
      // Ignores the abort signal on purpose: the deadline races the request, so
      // an implementation that never settles still returns.
      fetchImpl: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    });
    const elapsed = Date.now() - started;

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" ? result.reason : "").toContain("within");
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(elapsed).toBeLessThan(6_000);
  }, 15_000);
});

describe("updateCheckDisabled", () => {
  it("is off unless the variable is exactly 1", () => {
    // Pinned because the launcher uses this as the single authority for both
    // checks: a looser truthiness rule would make `LIANROUTER_NO_UPDATE_CHECK=0`
    // disable the notices.
    const original = process.env.LIANROUTER_NO_UPDATE_CHECK;
    try {
      delete process.env.LIANROUTER_NO_UPDATE_CHECK;
      expect(updateCheckDisabled()).toBe(false);
      process.env.LIANROUTER_NO_UPDATE_CHECK = "0";
      expect(updateCheckDisabled()).toBe(false);
      process.env.LIANROUTER_NO_UPDATE_CHECK = "1";
      expect(updateCheckDisabled()).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.LIANROUTER_NO_UPDATE_CHECK;
      } else {
        process.env.LIANROUTER_NO_UPDATE_CHECK = original;
      }
    }
  });
});
