import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONFIG_SPEC_KEYS,
  decodeEncryptionKey,
  oauthCallbackUrl,
  requireEncryptionKeyEnv,
  requirePublicOrigin,
  resolveDashboardDist,
  resolveFallbackRetryBaseMs,
  resolveFallbackRetryCapMs,
  resolveOpenCodeFtBaseUrl,
  resolvePort,
  resolveSsrfPolicy,
  resolveStreamFirstChunkTimeoutMs,
  resolveStreamStallTimeoutMs,
  resolveTelemetryRetentionDays,
  resolveTrustedProxyBoundary,
  resolveUpstreamTimeoutMs,
} from "../src/config";
import { MODEL_CATALOG_CACHE_MAX_ENTRIES } from "../src/providers/operations/model-catalog-cache";
import { providerBaseUrl, providerUpstreamHost } from "../src/providers/provider-metadata";

function withEnvironment<T>(name: string, value: string | undefined, run: () => T): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

describe("HTTP listener + dashboard runtime", () => {
  test("resolvePort uses the stable development default", () => {
    withEnvironment("PORT", undefined, () => {
      expect(resolvePort()).toBe(12800);
    });
  });

  test("resolvePort and resolveDashboardDist use explicit environment values", () => {
    withEnvironment("PORT", "12900", () =>
      withEnvironment("DASHBOARD_DIST", "./tmp/dashboard", () => {
        expect(resolvePort()).toBe(12900);
        expect(resolveDashboardDist()).toBe("./tmp/dashboard");
      }),
    );
  });

  test("resolveDashboardDist uses the compiled dashboard default", () => {
    withEnvironment("DASHBOARD_DIST", undefined, () => {
      expect(resolveDashboardDist()).toBe("./dist/dashboard");
    });
  });
});

describe("Telemetry metadata retention", () => {
  test("defaults to 30 days and accepts an operator override", () => {
    withEnvironment("LIANROUTER_TELEMETRY_RETENTION_DAYS", undefined, () => {
      expect(resolveTelemetryRetentionDays()).toBe(30);
    });
    withEnvironment("LIANROUTER_TELEMETRY_RETENTION_DAYS", "90", () => {
      expect(resolveTelemetryRetentionDays()).toBe(90);
    });
  });

  test("rejects retention windows outside the supported range", () => {
    withEnvironment("LIANROUTER_TELEMETRY_RETENTION_DAYS", "2", () => {
      expect(() => resolveTelemetryRetentionDays()).toThrow(
        "LIANROUTER_TELEMETRY_RETENTION_DAYS must be an integer between 3 and 365",
      );
    });
  });
});

describe("Network policy — trusted proxy + SSRF", () => {
  test("resolveTrustedProxyBoundary trims and filters configured peers", () => {
    withEnvironment("TRUSTED_PROXY_CIDRS", " 10.0.0.0/8, , 192.0.2.10 ", () => {
      expect(resolveTrustedProxyBoundary()).toEqual({
        mode: "trusted",
        allowlist: ["10.0.0.0/8", "192.0.2.10"],
      });
    });
  });

  test("resolveTrustedProxyBoundary disables forwarded addresses by default", () => {
    withEnvironment("TRUSTED_PROXY_CIDRS", undefined, () => {
      expect(resolveTrustedProxyBoundary()).toEqual({ mode: "disabled" });
    });
  });

  test("resolveSsrfPolicy preserves network and private-destination settings", () => {
    withEnvironment("LIANROUTER_ALLOWED_NETWORKS", " 10.0.0.0/8,192.0.2.0/24 ", () =>
      withEnvironment("LIANROUTER_MAX_REDIRECTS", "0", () =>
        withEnvironment("LIANROUTER_ALLOW_PRIVATE_UPSTREAMS", "true", () => {
          expect(resolveSsrfPolicy()).toEqual({
            allowedNetworks: ["10.0.0.0/8", "192.0.2.0/24"],
            maxRedirects: 0,
            allowPrivate: true,
          });
        }),
      ),
    );
  });

  test("resolveSsrfPolicy rejects redirect limits outside the contract", () => {
    for (const value of ["-1", "11", "1.5", "not-a-number"]) {
      withEnvironment("LIANROUTER_MAX_REDIRECTS", value, () => {
        expect(() => resolveSsrfPolicy()).toThrow(
          "LIANROUTER_MAX_REDIRECTS must be an integer between 0 and 10",
        );
      });
    }
  });
});

describe("Proxy pool config", () => {
  test("pool egress has no child-process config-file or binary resolvers", () => {
    // The child-process pool flavor was removed; its resolvers must not creep
    // back without the daemon that consumed them. Pool egress is dialed
    // in-process by `network/pool/agent.ts`.
    const source = readFileSync(resolve(import.meta.dir, "../src/config.ts"), "utf8");
    for (const gone of [
      "resolveProxyPortRange",
      "resolveProxyChildUid",
      "resolveProxyChildGid",
      "proxyBinaryFilename",
    ]) {
      expect(source).not.toContain(gone);
    }
  });
});

describe("Security — encryption key + public origin", () => {
  test("encryption key config accepts hex and base64 256-bit values", () => {
    const key = Buffer.alloc(32, 7);
    expect(decodeEncryptionKey(key.toString("hex"))).toEqual(key);
    expect(decodeEncryptionKey(key.toString("base64"))).toEqual(key);
  });

  test("encryption key config rejects missing and wrong-size values", () => {
    withEnvironment("LIANROUTER_ENCRYPTION_KEY", undefined, () => {
      expect(() => requireEncryptionKeyEnv()).toThrow(
        "LIANROUTER_ENCRYPTION_KEY is required to encrypt credentials and hash API keys",
      );
    });
    expect(() => decodeEncryptionKey("not-a-256-bit-key")).toThrow(
      "LIANROUTER_ENCRYPTION_KEY must decode to exactly 32 bytes",
    );
  });

  test("public origin config normalizes callback origins", () => {
    withEnvironment("LIANROUTER_PUBLIC_ORIGIN", "https://lianrouter.example.com///", () => {
      expect(requirePublicOrigin()).toBe("https://lianrouter.example.com");
      expect(oauthCallbackUrl("codex")).toBe(
        "https://lianrouter.example.com/console/api/providers/codex/oauth/callback",
      );
    });
  });

  test("public origin config fails closed when unset", () => {
    withEnvironment("LIANROUTER_PUBLIC_ORIGIN", undefined, () => {
      expect(() => requirePublicOrigin()).toThrow(
        "LIANROUTER_PUBLIC_ORIGIN is required to build OAuth redirect URIs",
      );
    });
  });
});

describe("config spec", () => {
  test("declares every knob this module reads", () => {
    // Guards against a resolver being added without a spec row: the drift test
    // derives the documented variable set from this list.
    expect(CONFIG_SPEC_KEYS.length).toBeGreaterThan(0);
    expect(CONFIG_SPEC_KEYS).toContain("PORT");
    expect(CONFIG_SPEC_KEYS).toContain("LIANROUTER_ENCRYPTION_KEY");
    expect(new Set(CONFIG_SPEC_KEYS).size).toBe(CONFIG_SPEC_KEYS.length);
  });
});

describe("opencodeft upstream override", () => {
  test("unset reads as the bundled opencode.ai origin", () => {
    withEnvironment("LIANROUTER_OPENCODEFT_BASE_URL", undefined, () => {
      expect(resolveOpenCodeFtBaseUrl()).toBeUndefined();
      expect(providerBaseUrl("opencodeft")).toBe("https://opencode.ai");
    });
  });

  test("an absolute http URL overrides the bundled origin and strips the trailing slash", () => {
    withEnvironment("LIANROUTER_OPENCODEFT_BASE_URL", "http://127.0.0.1:8910/", () => {
      expect(resolveOpenCodeFtBaseUrl()).toBe("http://127.0.0.1:8910");
      expect(providerBaseUrl("opencodeft")).toBe("http://127.0.0.1:8910");
      // The SSRF host binding follows the same source: dispatch to the
      // override must never dial the bundled origin.
      expect(providerUpstreamHost("opencodeft")).toEqual({
        hostname: "127.0.0.1",
        port: 8910,
      });
    });
  });

  test("a non-http value is rejected loudly instead of poisoning dispatch", () => {
    withEnvironment("LIANROUTER_OPENCODEFT_BASE_URL", "ftp://127.0.0.1:8910", () => {
      expect(() => resolveOpenCodeFtBaseUrl()).toThrow(
        "LIANROUTER_OPENCODEFT_BASE_URL must use http or https",
      );
    });
  });

  test("other bundled providers ignore the override", () => {
    withEnvironment("LIANROUTER_OPENCODEFT_BASE_URL", "http://127.0.0.1:8910", () => {
      expect(providerBaseUrl("opencodezen")).toBe("https://opencode.ai");
    });
  });
});

describe("process-lifetime cache bounds", () => {
  test("the model catalog cache has a fixed bound", () => {
    expect(MODEL_CATALOG_CACHE_MAX_ENTRIES).toBe(64);
  });
});

describe("upstream timeout + retry backoff", () => {
  test("resolvers fall back to the previously hardcoded defaults", () => {
    withEnvironment("LIANROUTER_UPSTREAM_TIMEOUT_MS", undefined, () => {
      expect(resolveUpstreamTimeoutMs()).toBe(120_000);
    });
    withEnvironment("LIANROUTER_STREAM_STALL_TIMEOUT_MS", undefined, () => {
      expect(resolveStreamStallTimeoutMs()).toBe(360_000);
    });
    withEnvironment("LIANROUTER_STREAM_FIRST_CHUNK_TIMEOUT_MS", undefined, () => {
      expect(resolveStreamFirstChunkTimeoutMs()).toBe(200_000);
    });
    withEnvironment("LIANROUTER_FALLBACK_RETRY_BASE_MS", undefined, () => {
      expect(resolveFallbackRetryBaseMs()).toBe(100);
    });
    withEnvironment("LIANROUTER_FALLBACK_RETRY_CAP_MS", undefined, () => {
      expect(resolveFallbackRetryCapMs()).toBe(2_000);
    });
  });

  test("resolvers honor explicit overrides", () => {
    withEnvironment("LIANROUTER_UPSTREAM_TIMEOUT_MS", "45000", () => {
      expect(resolveUpstreamTimeoutMs()).toBe(45_000);
    });
    withEnvironment("LIANROUTER_STREAM_STALL_TIMEOUT_MS", "120000", () => {
      expect(resolveStreamStallTimeoutMs()).toBe(120_000);
    });
    withEnvironment("LIANROUTER_STREAM_FIRST_CHUNK_TIMEOUT_MS", "60000", () => {
      expect(resolveStreamFirstChunkTimeoutMs()).toBe(60_000);
    });
    withEnvironment("LIANROUTER_FALLBACK_RETRY_BASE_MS", "250", () => {
      expect(resolveFallbackRetryBaseMs()).toBe(250);
    });
    withEnvironment("LIANROUTER_FALLBACK_RETRY_CAP_MS", "5000", () => {
      expect(resolveFallbackRetryCapMs()).toBe(5_000);
    });
  });

  test("resolvers reject out-of-range and malformed values", () => {
    for (const value of ["0", "-1", "1.5", "not-a-number"]) {
      withEnvironment("LIANROUTER_UPSTREAM_TIMEOUT_MS", value, () => {
        expect(() => resolveUpstreamTimeoutMs()).toThrow(
          "LIANROUTER_UPSTREAM_TIMEOUT_MS must be an integer between 5000 and 600000",
        );
      });
      withEnvironment("LIANROUTER_STREAM_STALL_TIMEOUT_MS", value, () => {
        expect(() => resolveStreamStallTimeoutMs()).toThrow(
          "LIANROUTER_STREAM_STALL_TIMEOUT_MS must be an integer between 60000 and 600000",
        );
      });
      withEnvironment("LIANROUTER_STREAM_FIRST_CHUNK_TIMEOUT_MS", value, () => {
        expect(() => resolveStreamFirstChunkTimeoutMs()).toThrow(
          "LIANROUTER_STREAM_FIRST_CHUNK_TIMEOUT_MS must be an integer between 30000 and 300000",
        );
      });
    }
    // The retry backoff bounds admit 0 (immediate retry), so they reject only
    // negatives and non-integers.
    for (const value of ["-1", "1.5", "not-a-number"]) {
      withEnvironment("LIANROUTER_FALLBACK_RETRY_BASE_MS", value, () => {
        expect(() => resolveFallbackRetryBaseMs()).toThrow(
          "LIANROUTER_FALLBACK_RETRY_BASE_MS must be an integer between 0 and 60000",
        );
      });
      withEnvironment("LIANROUTER_FALLBACK_RETRY_CAP_MS", value, () => {
        expect(() => resolveFallbackRetryCapMs()).toThrow(
          "LIANROUTER_FALLBACK_RETRY_CAP_MS must be an integer between 0 and 300000",
        );
      });
    }
  });
});
