import { describe, expect, test } from "bun:test";

import {
  AUTOCLAW_SPEC,
  autoClawAppHeaders,
  autoClawAppSignature,
} from "../../../../src/providers/integrations/autoclaw/spec";

/**
 * The AutoClaw gateway authenticates the *app* before it reads the account: a
 * request whose app signature is absent is answered with a 405 HTML page, not a
 * JSON error. The signature is therefore part of the wire contract, and these
 * tests pin the exact digest so a refactor cannot silently change it.
 */
describe("AutoClaw app signature", () => {
  test("is MD5 over appid&timestamp&appkey, in that order", () => {
    // A fixed timestamp makes the digest deterministic; the expected value is
    // the documented construction, recomputed here independently.
    const timestamp = "1794478118";
    const expected = new Bun.CryptoHasher("md5")
      .update("100003&1794478118&38d2391985e2369a5fb8227d8e6cd5e5")
      .digest("hex");
    expect(autoClawAppSignature("100003", timestamp, "38d2391985e2369a5fb8227d8e6cd5e5")).toBe(expected);
  });

  test("is 32 lowercase hex characters", () => {
    expect(autoClawAppSignature("100003", "1", "k")).toMatch(/^[0-9a-f]{32}$/);
  });

  test("changes when the timestamp changes, so a replayed signature cannot be reused", () => {
    const a = autoClawAppSignature("100003", "1794478118", "k");
    const b = autoClawAppSignature("100003", "1794478119", "k");
    expect(a).not.toBe(b);
  });
});

describe("AutoClaw app headers", () => {
  test("carries the timestamp the signature was computed from", () => {
    const headers = autoClawAppHeaders(1_800_000_000);
    expect(headers["x-auth-timestamp"]).toBe("1800000000");
    expect(headers["x-auth-sign"]).toBe(
      autoClawAppSignature(headers["x-auth-appid"]!, "1800000000", "38d2391985e2369a5fb8227d8e6cd5e5"),
    );
  });

  /**
   * `accept` is load-bearing. Without it the runtime's default reaches the
   * gateway and the answer is a 405 HTML page before the body is read —
   * verified live against the real host. Every identity field below is checked
   * because the vendor treats a foreign client signature as a foreign harness.
   */
  test("declares the full client identity the gateway expects", () => {
    const headers = autoClawAppHeaders(1_800_000_000, "linux");
    expect(headers["accept"]).toBe("*/*");
    expect(headers["user-agent"]).toBe("AutoClaw/1.17.9");
    expect(headers["x-version"]).toBe("1.17.9");
    expect(headers["x-product"]).toBe("autoclaw");
    expect(headers["x-channel"]).toBe("official");
    expect(headers["x-client-type"]).toBe("pc");
    expect(headers["x-lang"]).toBe("en");
  });

  test("reports the platform token the client sends", () => {
    expect(autoClawAppHeaders(1, "linux")["x-tm"]).toBe("linux");
    expect(autoClawAppHeaders(1, "win32")["x-tm"]).toBe("win");
  });
});

describe("AutoClaw dispatch spec", () => {
  test("serves the chat wire on the client's own proxy path", () => {
    expect(AUTOCLAW_SPEC.endpoint_paths_by_wire_family?.["chat"]).toBe(
      "/autoclaw-proxy/proxy/autoclaw/chat/completions",
    );
    expect(AUTOCLAW_SPEC.supported_wire_families).toEqual(["chat"]);
  });

  /**
   * The account JWT rides in `X-Authorization`. Forwarding it as a standard
   * `Authorization: Bearer` too would send two credentials, so credential
   * forwarding stays off and the header hook is the only source of auth.
   */
  test("withholds the standard Authorization header", () => {
    expect(AUTOCLAW_SPEC.credential_forwarding).toBe("never");
  });
});
