import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * `retry-after` is the only signal a lockout gives, and the login form cannot
 * read response headers from a thrown error. These tests pin the extraction
 * path that carries the wait from the wire into `ApiErrorShape`.
 */
const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");

describe("console error retry-after extraction", () => {
  test("reads the seconds from the response body", () => {
    expect(source).toContain("payload.retry_after_seconds ?? payload.retryAfterSeconds");
  });

  test("falls back to the retry-after header", () => {
    // The header is what a 429 always carries; the body field is our addition.
    expect(source).toContain('response.headers.get("retry-after")');
  });

  test("exposes the value on the thrown error", () => {
    expect(source).toContain("retryAfterSeconds");
  });
});

describe("login lockout countdown", () => {
  const login = readFileSync(new URL("../routes/Login.tsx", import.meta.url), "utf8");

  test("renders the remaining wait instead of a bare message", () => {
    expect(login).toContain("Try again in");
    expect(login).toContain("formatWait(secondsLeft)");
  });

  test("disables submit while locked so a retry cannot extend the window", () => {
    expect(login).toContain("disabled={pending || lockedUntil !== null}");
  });

  test("ticks once per second", () => {
    expect(login).toContain("window.setInterval(tick, 1000)");
  });
});
