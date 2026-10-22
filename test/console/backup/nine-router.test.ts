import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { detectFormat, validateRestorePayload } from "../../../src/console/backup/validate";
import { convert9RouterBackup } from "../../../src/console/backup/nine-router";
import { decryptCredentialToString, hashSecret } from "../../../src/security/crypto";
import { isBackupBytes, isBackupDate } from "../../../src/console/backup/contracts";
import { createBackupRoutes } from "../../../src/console/backup/routes";
import type { BackupService } from "../../../src/console/backup/service";
import type { AccessDecision, AccessScope } from "../../../src/security/access-control";

/**
 * The router-export importer.
 *
 * The tests that matter here are the *refusals*: an id we cannot map must be
 * reported, never attached to a provider that merely looks similar, because a
 * credential bound to the wrong upstream looks like a working account and sends
 * traffic somewhere the operator did not intend.
 */
describe("router backup detection", () => {
  test("detects a native backup by its app marker", () => {
    const result = detectFormat({
      app: "lianrouter",
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      sections: {},
    });
    expect(result.kind).toBe("native");
  });

  test("detects a router export by the tables it dumps", () => {
    const result = detectFormat({
      providerConnections: [],
      providerNodes: [],
      apiKeys: [],
      combos: [],
    });
    expect(result.kind).toBe("nine_router");
  });

  test("unwraps a payload nested under `backup`, as the UI form posts it", () => {
    const result = detectFormat({
      backup: { app: "lianrouter", version: 1, exportedAt: "x", sections: {} },
    });
    expect(result.kind).toBe("native");
  });

  test("names the foreign application rather than saying the field is wrong", () => {
    const result = detectFormat({ app: "some-other-router", version: 1 });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") expect(result.reason).toContain("some-other-router");
  });

  test("refuses a file with only one router marker, which could be anything", () => {
    const result = detectFormat({ apiKeys: [] });
    expect(result.kind).toBe("unknown");
  });

  test("refuses a non-object", () => {
    expect(detectFormat([]).kind).toBe("unknown");
    expect(detectFormat("hello").kind).toBe("unknown");
    expect(detectFormat(null).kind).toBe("unknown");
  });
});

describe("router export conversion", () => {
  const tenantId = randomUUID();

  function exportFixture() {
    return {
      providerConnections: [
        {
          id: "c1",
          provider: "claude",
          authType: "oauth",
          name: "Claude main",
          apiKey: "sk-ant-oat-EXAMPLE",
          isActive: true,
          createdAt: "2026-01-02T03:04:05.000Z",
        },
        {
          id: "c2",
          provider: "opencode-free",
          name: "Free tier",
          accessToken: "free-token",
          isActive: false,
        },
        {
          id: "c3",
          provider: "windsurf",
          name: "Windsurf acct",
          apiKey: "ws-token",
        },
        {
          id: "c4",
          provider: "claude",
          name: "No credential row",
        },
      ],
      providerNodes: [
        {
          id: "n1",
          type: "openai-compatible",
          prefix: "my-custom",
          name: "My Custom",
          baseUrl: "https://custom.example.com/v1",
          models: [{ id: "gpt-x" }, { id: "gpt-y" }],
        },
        {
          id: "n2",
          type: "custom-embedding",
          prefix: "embed",
          baseUrl: "https://embed.example.com",
        },
      ],
      apiKeys: [{ id: "k1", key: "rk_router_key_123", name: "Router key", isActive: true }],
      combos: [
        { id: "b1", name: "fast-pool", kind: "round-robin", models: ["claude/claude-opus-5", "opencode-free/gpt-5"] },
        { id: "b2", name: "one-member", kind: "fallback", models: ["claude/claude-opus-5"] },
      ],
      modelAliases: {
        "my-fast": "claude/claude-sonnet-4-5",
        "unsupported": "windsurf/some-model",
      },
      proxyPools: [{ id: "p1", name: "pool", proxyUrl: "socks5://host:1080" }],
      customModels: [{ provider: "opencode-free", id: "custom-model-1" }],
      pricing: { "claude/claude-opus-5": { input: 1 } },
      mitmAlias: { x: "y" },
      settings: { someSetting: true },
    };
  }

  test("imports mapped accounts, decrypting to the original credential", () => {
    const { payload, report } = convert9RouterBackup(exportFixture(), tenantId);
    expect(report.imported.accounts).toBe(2); // claude + opencode-free

    const accounts = payload.sections.config?.provider_accounts ?? [];
    const claude = accounts.find((a) => a.provider_id === "claude");
    expect(claude).toBeDefined();
    expect(claude?.tenant_id).toBe(tenantId);
    expect(claude?.credential_kind).toBe("oauth");
    // The credential must be encrypted with this instance's key, not stored raw.
    const bytes = (claude?.credential_ciphertext as { __bytes: string }).__bytes;
    expect(decryptCredentialToString(Buffer.from(bytes, "base64"))).toBe("sk-ant-oat-EXAMPLE");

    const free = accounts.find((a) => a.provider_id === "opencodeft");
    expect(free?.status).toBe("disabled");
  });

  test("reports every account it refused, with a reason", () => {
    const { report } = convert9RouterBackup(exportFixture(), tenantId);
    const joined = report.skipped.join("\n");
    expect(joined).toContain("windsurf"); // known-unsupported provider
    expect(joined).toContain("no credential"); // credential-less row
  });

  test("refuses an entirely unknown provider id rather than importing it as-is", () => {
    // The dangerous case: an id we have never heard of. Importing it verbatim
    // would create a provider row for a slug nothing serves, and — worse — if
    // it ever collided with a real id the credential would land on the wrong
    // upstream. It must be reported, and it must not appear in the payload.
    const { payload, report } = convert9RouterBackup(
      {
        providerConnections: [
          { id: "c1", provider: "totally-unknown-router", name: "Mystery", apiKey: "secret" },
        ],
      },
      tenantId,
    );
    expect(report.imported.accounts).toBe(0);
    expect(report.skipped.join("\n")).toContain("totally-unknown-router");
    expect(payload.sections.config?.provider_accounts).toBeUndefined();
  });

  test("records each provider id it remapped instead of doing it silently", () => {
    const { report } = convert9RouterBackup(exportFixture(), tenantId);
    expect(report.remapped).toContain("opencode-free → opencodeft");
  });

  test("keeps the refresh token of an OAuth row in its own table", () => {
    // Grok Build is device-OAuth only. Reading the access token alone produced
    // an account that worked until that token lapsed and then died permanently,
    // because `provider_oauth_states` is where the refresh service reads from.
    const { payload, report } = convert9RouterBackup(
      {
        providerConnections: [
          {
            id: "g1",
            provider: "grok-cli",
            authType: "oauth",
            name: "Grok account",
            accessToken: "xai-access-token",
            refreshToken: "xai-refresh-token",
            expiresAt: "2026-01-02T09:04:05.000Z",
            isActive: true,
          },
        ],
      },
      tenantId,
    );
    expect(report.imported.accounts).toBe(1);
    const accounts = payload.sections.config?.provider_accounts ?? [];
    const account = accounts[0];
    expect(account?.provider_id).toBe("grok");
    expect(account?.credential_kind).toBe("oauth");

    const states = payload.sections.config?.provider_oauth_states ?? [];
    expect(states).toHaveLength(1);
    expect(states[0]?.provider_account_id).toBe(account?.id);
    const refreshCell = states[0]?.refresh_ciphertext;
    if (!isBackupBytes(refreshCell)) throw new Error("refresh ciphertext is not a bytes cell");
    expect(decryptCredentialToString(Buffer.from(refreshCell.__bytes, "base64"))).toBe(
      "xai-refresh-token",
    );
    const expiryCell = states[0]?.expires_at;
    if (!isBackupDate(expiryCell)) throw new Error("expires_at is not a date cell");
    expect(expiryCell.__date).toBe("2026-01-02T09:04:05.000Z");
  });

  test("warns instead of silently importing an OAuth row that cannot renew", () => {
    // Refusing would discard a credential that is still valid for the rest of
    // its lifetime; importing it quietly would hide that it can never renew.
    const { report } = convert9RouterBackup(
      {
        providerConnections: [
          { id: "g1", provider: "grok-cli", authType: "oauth", name: "No refresh", accessToken: "tok" },
        ],
      },
      tenantId,
    );
    expect(report.imported.accounts).toBe(1);
    expect(report.warnings.join("\n")).toContain("cannot renew");
  });

  test("reads the access token from whichever key the OAuth row used", () => {
    // A Claude row with `authType: "oauth"` stores its token under `apiKey`
    // rather than `accessToken`; the kind decides how it is used, not where it
    // was written.
    const { payload } = convert9RouterBackup(
      {
        providerConnections: [
          {
            id: "c1",
            provider: "claude",
            authType: "oauth",
            name: "Claude oauth",
            apiKey: "sk-ant-oat-EXAMPLE",
            refreshToken: "claude-refresh",
          },
        ],
      },
      tenantId,
    );
    const account = (payload.sections.config?.provider_accounts ?? [])[0];
    expect(account?.credential_kind).toBe("oauth");
    const cipherCell = account?.credential_ciphertext;
    if (!isBackupBytes(cipherCell)) throw new Error("credential is not a bytes cell");
    expect(decryptCredentialToString(Buffer.from(cipherCell.__bytes, "base64"))).toBe(
      "sk-ant-oat-EXAMPLE",
    );
  });

  test("keeps a static key out of the OAuth path", () => {
    const { payload } = convert9RouterBackup(
      {
        providerConnections: [
          { id: "s1", provider: "openai", authType: "apikey", name: "Static", apiKey: "sk-static" },
        ],
      },
      tenantId,
    );
    const account = (payload.sections.config?.provider_accounts ?? [])[0];
    expect(account?.credential_kind).toBe("api_key");
    expect(payload.sections.config?.provider_oauth_states).toBeUndefined();
  });

  test("turns a compatible node into a BYOK provider with its models", () => {
    const { payload } = convert9RouterBackup(exportFixture(), tenantId);
    const providers = payload.sections.config?.providers ?? [];
    const custom = providers.find((p) => p.id === "my-custom");
    expect(custom).toBeDefined();
    expect(custom?.base_url).toBe("https://custom.example.com/v1");
    expect(custom?.tenant_id).toBe(tenantId);

    const models = payload.sections.config?.models ?? [];
    const owned = models.filter((m) => m.provider_id === "my-custom");
    expect(owned.map((m) => m.model_id).sort()).toEqual(["gpt-x", "gpt-y"]);
  });

  test("refuses a node type that is not a chat provider", () => {
    const { report } = convert9RouterBackup(exportFixture(), tenantId);
    expect(report.skipped.join("\n")).toContain("custom-embedding");
  });

  test("hashes an imported API key so the same bearer still authenticates", () => {
    const { payload } = convert9RouterBackup(exportFixture(), tenantId);
    const keys = payload.sections.config?.api_keys ?? [];
    expect(keys).toHaveLength(1);
    // Stored as the hash, never the plaintext.
    expect(keys[0]?.key_hash).toBe(hashSecret("rk_router_key_123"));
    expect(JSON.stringify(keys[0])).not.toContain("rk_router_key_123");
  });

  test("maps combo members through the provider map", () => {
    const { payload } = convert9RouterBackup(exportFixture(), tenantId);
    const combos = payload.sections.config?.model_combos ?? [];
    const pool = combos.find((c) => c.name === "fast-pool");
    expect(pool?.members).toEqual(["claude/claude-opus-5", "opencodeft/gpt-5"]);
    expect(pool?.strategy).toBe("round_robin");
  });

  test("refuses a combo with fewer than two resolvable members", () => {
    const { report } = convert9RouterBackup(exportFixture(), tenantId);
    expect(report.skipped.join("\n")).toContain("one-member");
  });

  test("skips an alias whose target uses an unsupported provider", () => {
    const { payload, report } = convert9RouterBackup(exportFixture(), tenantId);
    const aliases = payload.sections.config?.model_aliases ?? [];
    expect(aliases.map((a) => a.alias)).toEqual(["my-fast"]);
    expect(report.skipped.join("\n")).toContain("unsupported");
  });

  test("warns about the data it cannot carry over instead of dropping it quietly", () => {
    const { report } = convert9RouterBackup(exportFixture(), tenantId);
    const warnings = report.warnings.join("\n");
    expect(warnings).toContain("pricing");
    expect(warnings).toContain("MITM");
    expect(warnings).toContain("settings");
    expect(report.skipped.join("\n")).toContain("proxy pools");
  });

  test("produces a payload that passes our own restore validation", () => {
    const { payload } = convert9RouterBackup(exportFixture(), tenantId);
    const validation = validateRestorePayload(payload, tenantId);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    // Config only: an import replaces configuration and never touches history.
    expect(validation.value.tables.size).toBeGreaterThan(0);
    expect(validation.value.tenantRows).toHaveLength(0);
  });

  test("refuses a non-object and an empty tenant id", () => {
    expect(() => convert9RouterBackup([], tenantId)).toThrow();
    expect(() => convert9RouterBackup(exportFixture(), "")).toThrow();
  });

  test("an empty export converts to an empty, still-valid payload", () => {
    const { payload, report } = convert9RouterBackup({}, tenantId);
    expect(report.imported.accounts).toBe(0);
    expect(validateRestorePayload(payload, tenantId).ok).toBe(true);
  });
});

/**
 * Backup route authorization.
 *
 * Both actions re-authenticate by verifying the operator's password against
 * their session's user row, so a tenant API key — which carries no session —
 * can never complete one. These pin that the route says so at the scope gate
 * rather than accepting a credential that would fail one step later with a
 * confusing "password is incorrect".
 */
describe("backup route authorization", () => {
  function route(access: AccessDecision | undefined) {
    return createBackupRoutes({
      accessResolver: () => access,
      backupFor: () =>
        ({
          export: async () => ({ payload: {}, counts: {} }),
        }) as unknown as BackupService,
    });
  }

  const decision = (scopes: readonly AccessScope[]): AccessDecision => ({
    id: "key-1",
    tenantId: "tenant-1",
    scopes,
    admissionIdentity: "key-1",
  });

  test("a tenant API key cannot export, even with providers:write", async () => {
    // `providers:write` once appeared in the accepted list, which implied a key
    // could script a backup. It cannot: re-authentication needs a session.
    const response = await route(decision(["providers:write"])).handle(
      new Request("http://console.test/backup/export?password=x"),
    );
    expect(response.status).toBe(403);
  });

  test("a routing:invoke-only key cannot export", async () => {
    const response = await route(decision(["routing:invoke"])).handle(
      new Request("http://console.test/backup/export?password=x"),
    );
    expect(response.status).toBe(403);
  });

  test("an unauthenticated request is rejected before any export runs", async () => {
    const response = await route(undefined).handle(
      new Request("http://console.test/backup/export?password=x"),
    );
    expect(response.status).toBe(401);
  });
});
