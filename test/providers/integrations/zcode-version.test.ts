import { afterEach, describe, expect, test } from "bun:test";
import {
  VERSION_SOURCES,
  _resetZcodeVersion,
  getZcodeVersion,
  resolveZcodeVersion,
} from "../../../src/providers/operations/client-versions";
import { zcodeCampaignAppVersion } from "../../../src/providers/integrations/zcode/identity";

/** Atom feed shaped like GitHub's: newest entry first. */
function atomFeed(tags: string[]): string {
  const entries = tags.map((t) => `<entry><title>${t}</title></entry>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
}

function feedFetcher(tags: string[]): typeof fetch & { readonly urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(url);
    return new Response(atomFeed(tags), {
      status: 200,
      headers: { "content-type": "application/atom+xml" },
    });
  }) as unknown as typeof fetch & { readonly urls: string[] };
  Object.defineProperty(impl, "urls", { get: () => urls });
  return impl;
}

afterEach(() => {
  _resetZcodeVersion();
});

describe("ZCode client version", () => {
  test("pinned fallback is used before discovery", () => {
    // Relationship, not the literal: the fallback moves when the asset moves,
    // and pinning it turns every bump into a test edit.
    expect(getZcodeVersion()).toBe(VERSION_SOURCES.zcode.fallback);
    expect(VERSION_SOURCES.zcode.fallback).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("resolves the newest release tag from the publisher's atom feed", async () => {
    // The feed is the publisher's own record and costs no API quota, which is
    // why it is read instead of `/releases/latest`.
    const fetcher = feedFetcher(["v4.2.1", "v4.0.0", "v3.18.2"]);
    expect(await resolveZcodeVersion(fetcher)).toBe("4.2.1");
    expect(fetcher.urls[0]).toContain("zai-org/ZCode/releases.atom");
  });

  test("ignores a pre-release tag it cannot compare", async () => {
    // `v5.0.0-beta.1` is not a dotted triple, so it must fall through to the
    // next well-formed tag rather than being advertised as 5.0.0.
    const fetcher = feedFetcher(["v5.0.0-beta.1", "v4.1.0"]);
    expect(await resolveZcodeVersion(fetcher)).toBe("4.1.0");
  });

  test("campaign faces follow the resolver, so a new release needs no code change", async () => {
    // This is the property that keeps the campaign gate working: the vendor
    // serves marketing deliveries only to a recent client, and the value the
    // claim lane stamps comes from here.
    expect(zcodeCampaignAppVersion()).toBe(VERSION_SOURCES.zcode.fallback);
    await resolveZcodeVersion(feedFetcher(["v4.7.7"]));
    expect(zcodeCampaignAppVersion()).toBe("4.7.7");
  });

  test("an offline registry keeps the campaign face on the pinned fallback", async () => {
    const offline = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await resolveZcodeVersion(offline)).toBe(VERSION_SOURCES.zcode.fallback);
    expect(zcodeCampaignAppVersion()).toBe(VERSION_SOURCES.zcode.fallback);
  });
});
