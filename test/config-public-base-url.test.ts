import { afterEach, describe, expect, test } from "bun:test";
import { resolvePublicBaseUrl } from "../src/config";

const ENV = "LIANROUTER_PUBLIC_BASE_URL";

afterEach(() => {
  delete process.env[ENV];
});

describe("resolvePublicBaseUrl", () => {
  test("is unset by default so the request origin stays authoritative", () => {
    delete process.env[ENV];
    expect(resolvePublicBaseUrl()).toBeUndefined();
  });

  test("returns the configured origin without a trailing slash", () => {
    // Enrollment links are built as `${origin}/share/<token>`, so a stored
    // trailing slash produced `https://host//share/<token>`.
    process.env[ENV] = "https://router.example.com/";
    expect(resolvePublicBaseUrl()).toBe("https://router.example.com");
  });

  test("keeps a base path intact", () => {
    // A tunnel can mount the gateway under a prefix; stripping the path would
    // silently point recipients at the wrong route.
    process.env[ENV] = "https://example.com/lianrouter/";
    expect(resolvePublicBaseUrl()).toBe("https://example.com/lianrouter");
  });

  test("rejects a bare host instead of emitting relative links", () => {
    // `example.com/share/...` resolves as a path on whatever host the operator
    // happens to be on, so the failure has to be loud at boot.
    process.env[ENV] = "router.example.com";
    expect(() => resolvePublicBaseUrl()).toThrow(/absolute URL/);
  });

  test("rejects a non-http scheme", () => {
    process.env[ENV] = "ftp://router.example.com";
    expect(() => resolvePublicBaseUrl()).toThrow(/http or https/);
  });

  test("accepts plain http for a local tunnel", () => {
    process.env[ENV] = "http://localhost:12800";
    expect(resolvePublicBaseUrl()).toBe("http://localhost:12800");
  });
});
