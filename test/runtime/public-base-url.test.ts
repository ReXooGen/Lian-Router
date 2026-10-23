import { afterEach, describe, expect, test } from "bun:test";
import {
  getRuntimePublicBaseUrl,
  resolveEffectivePublicBaseUrl,
  setRuntimePublicBaseUrl,
} from "../../src/runtime/public-base-url";

const ENV = "LIANROUTER_PUBLIC_BASE_URL";

afterEach(() => {
  delete process.env[ENV];
  setRuntimePublicBaseUrl(null);
});

describe("resolveEffectivePublicBaseUrl", () => {
  test("falls back to the configured env value when no tunnel is running", () => {
    process.env[ENV] = "https://router.example.com/";

    expect(getRuntimePublicBaseUrl()).toBeNull();
    expect(resolveEffectivePublicBaseUrl()).toBe("https://router.example.com");
  });

  test("prefers the runtime tunnel over the env value", () => {
    process.env[ENV] = "https://router.example.com";
    setRuntimePublicBaseUrl("https://remainder-portsmouth-roman-sends.trycloudflare.com");

    expect(resolveEffectivePublicBaseUrl()).toBe(
      "https://remainder-portsmouth-roman-sends.trycloudflare.com",
    );
  });

  test("clearing the override restores the env value", () => {
    process.env[ENV] = "https://router.example.com";
    setRuntimePublicBaseUrl("https://tunnel.trycloudflare.com");

    setRuntimePublicBaseUrl(null);

    expect(getRuntimePublicBaseUrl()).toBeNull();
    expect(resolveEffectivePublicBaseUrl()).toBe("https://router.example.com");
  });

  test("is undefined when neither a tunnel nor an env value exists", () => {
    delete process.env[ENV];

    expect(resolveEffectivePublicBaseUrl()).toBeUndefined();
  });

  test("trims trailing slashes so links never get a double slash", () => {
    setRuntimePublicBaseUrl("https://tunnel.trycloudflare.com/");

    expect(getRuntimePublicBaseUrl()).toBe("https://tunnel.trycloudflare.com");
  });
});
