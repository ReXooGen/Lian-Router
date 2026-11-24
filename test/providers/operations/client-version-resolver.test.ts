import { describe, expect, test, vi } from "bun:test";
import {
  createClientVersionResolver,
  isSemverish,
} from "../../../src/providers/operations/client-version-resolver";
import { startIdentityVersionRefresh } from "../../../src/providers/operations/client-versions";

/** Fake fetch that answers each URL from a map; records the urls it saw. */
function fakeFetch(responses: Record<string, string>): typeof fetch & { readonly urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(url);
    const body = responses[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch & { readonly urls: string[] };
  Object.defineProperty(impl, "urls", { get: () => urls });
  return impl;
}

const EXTENSION_URL = "https://raw.githubusercontent.com/cline/cline/main/apps/vscode/package.json";
const NPM_URL = "https://registry.npmjs.org/cline/latest";

describe("createClientVersionResolver", () => {
  test("ignores a discovered version below minVersion", async () => {
    const fetcher = fakeFetch({
      [NPM_URL]: JSON.stringify({ version: "3.0.62" }),
    });
    const resolver = createClientVersionResolver({
      key: "test-cline-min",
      fallback: "4.1.18",
      minVersion: "4.1.18",
      sources: [{ url: NPM_URL }],
    });

    await resolver.ensure(fetcher);
    // The registry published the CLI (3.x), not the artifact the API gates on
    // (4.x). Accepting it would downgrade the client and break every request.
    expect(resolver.get()).toBe("4.1.18");
  });

  test("accepts a discovered version at or above minVersion", async () => {
    const fetcher = fakeFetch({
      [EXTENSION_URL]: JSON.stringify({ version: "4.1.19" }),
      [NPM_URL]: JSON.stringify({ version: "3.0.62" }),
    });
    const resolver = createClientVersionResolver({
      key: "test-cline-upgrade",
      fallback: "4.1.18",
      minVersion: "4.1.18",
      // Extension manifest first: it is the artifact the API gates on.
      sources: [{ url: EXTENSION_URL }, { url: NPM_URL }],
    });

    await resolver.ensure(fetcher);
    expect(resolver.get()).toBe("4.1.19");
    // The authoritative source answered, so the CLI registry is never probed.
    expect(fetcher.urls).toEqual([EXTENSION_URL]);
  });

  test("falls through to the next source when the first is below minVersion", async () => {
    const fetcher = fakeFetch({
      [NPM_URL]: JSON.stringify({ version: "3.0.62" }),
      [EXTENSION_URL]: JSON.stringify({ version: "4.2.0" }),
    });
    const resolver = createClientVersionResolver({
      key: "test-cline-fallthrough",
      fallback: "4.1.18",
      minVersion: "4.1.18",
      sources: [{ url: NPM_URL }, { url: EXTENSION_URL }],
    });

    await resolver.ensure(fetcher);
    expect(resolver.get()).toBe("4.2.0");
  });

  test("falls back when every source fails", async () => {
    const resolver = createClientVersionResolver({
      key: "test-cline-offline",
      fallback: "4.1.18",
      minVersion: "4.1.18",
      sources: [{ url: "https://example.invalid/latest" }],
    });
    await resolver.ensure(fakeFetch({}));
    expect(resolver.get()).toBe("4.1.18");
  });

  test("re-probes after the TTL window instead of latching forever", async () => {
    // The regression this pins: `ensure` used to latch on its first success, so
    // the boot warm froze every preset at the version the registry happened to
    // return at start-up. A client shipping a new release kept being advertised
    // at the old number until the gateway restarted.
    vi.useFakeTimers();
    try {
      let published = "1.0.0";
      const urls: string[] = [];
      const fetcher = (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ version: published }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const resolver = createClientVersionResolver({
        key: "test-ttl-refresh",
        fallback: "0.0.1",
        sources: [{ url: "https://example.invalid/latest" }],
        ttlMs: 1_000,
      });

      await resolver.ensure(fetcher);
      expect(resolver.get()).toBe("1.0.0");

      published = "1.1.0";
      // Inside the window: no second fetch, the cached value stands.
      vi.advanceTimersByTime(500);
      await resolver.ensure(fetcher);
      expect(urls.length).toBe(1);
      expect(resolver.get()).toBe("1.0.0");

      vi.advanceTimersByTime(1_000);
      await resolver.ensure(fetcher);
      expect(urls.length).toBe(2);
      expect(resolver.get()).toBe("1.1.0");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed probe still stamps the window so dispatch does not retry it", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;

    const resolver = createClientVersionResolver({
      key: "test-ttl-failure",
      fallback: "2.0.0",
      sources: [{ url: "https://example.invalid/latest" }],
      ttlMs: 60_000,
    });

    await resolver.ensure(fetcher);
    await resolver.ensure(fetcher);
    expect(resolver.get()).toBe("2.0.0");
    expect(urls.length).toBe(1);
  });
});

describe("isSemverish", () => {
  test("accepts dotted triples and rejects the rest", () => {
    expect(isSemverish("4.1.19")).toBe(true);
    expect(isSemverish("1.0.0-rc.1")).toBe(true);
    expect(isSemverish("latest")).toBe(false);
    expect(isSemverish("")).toBe(false);
    expect(isSemverish(undefined)).toBe(false);
  });
});

describe("startIdentityVersionRefresh", () => {
  test("re-warms the cache on each tick and stops cleanly", async () => {
    // The bug this pins: nothing re-read the resolvers after the boot warm, so
    // a preset whose client shipped a new release kept advertising the number
    // captured at start-up. A ticking refresh is the only thing that moves it.
    vi.useFakeTimers();
    try {
      const urls: string[] = [];
      const fetcher = (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ version: "3.0.0" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const stop = startIdentityVersionRefresh(1_000, fetcher);
      expect(urls.length).toBe(0);

      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      expect(urls.length).toBeGreaterThan(0);

      const afterFirst = urls.length;
      stop();
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      expect(urls.length).toBe(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });
});
