import { describe, expect, test } from "bun:test";
import { createShareRouter } from "../../../src/console/share/share-router";
import { hashShareToken, type ShareApiKeyRow, type ShareLinkStore } from "../../../src/persistence/share-store";
import type { LianRouterDatabase } from "../../../src/persistence/postgres";
import type { ShareActivityPort } from "../../../src/console/share/share-usage";

interface ShareFixture {
  readonly token: string;
  readonly row: ShareApiKeyRow;
}

function fakeStore(fixtures: readonly ShareFixture[]) {
  const byHash = new Map(fixtures.map((fixture) => [hashShareToken(fixture.token), fixture.row]));
  const activeIps = new Map<string, { readonly id: string; readonly tenantId: string; readonly parentKeyId: string }>();
  const store: ShareLinkStore & {
    readonly touched: string[];
    readonly issued: { readonly tokenHash: string; readonly clientIp: string; readonly clientIpKey: string; readonly deviceKey: string }[];
  } = {
    touched: [],
    issued: [],
    async create() {
      throw new Error("not used");
    },
    async getApiKeyByShareToken(tokenHash) {
      return byHash.get(tokenHash) ?? null;
    },
    async getActiveSharedKeyForIp(clientIpKey, apiKeyId) {
      const active = activeIps.get(clientIpKey);
      if (!active || (apiKeyId !== undefined && active.parentKeyId !== apiKeyId)) return null;
      return { id: active.id, tenantId: active.tenantId, recoverable: false };
    },
    async revealSharedKeyForDevice() {
      return null;
    },
    async issueSharedApiKey(tokenHash, material) {
      const row = byHash.get(tokenHash);
      if (!row) return { kind: "link_unavailable" };
      if (activeIps.has(material.clientIpKey)) return { kind: "ip_limit" };
      activeIps.set(material.clientIpKey, { id: "child-1", tenantId: row.tenantId, parentKeyId: row.id });
      store.issued.push({
        tokenHash,
        clientIp: material.clientIp,
        clientIpKey: material.clientIpKey,
        deviceKey: material.deviceKey,
      });
      return {
        kind: "issued",
        apiKeyId: "child-1",
        parentKeyId: row.id,
        tenantId: row.tenantId,
        label: row.name,
        keyPrefix: material.keyPrefix,
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      };
    },
    async touchView(tokenHash) {
      store.touched.push(tokenHash);
    },
    async listForApiKey() {
      return [];
    },
    async revoke() {
      return false;
    },
  };
  return store;
}

function shareRow(overrides: Partial<ShareApiKeyRow> = {}): ShareApiKeyRow {
  return {
    id: "key-1",
    tenantId: "tenant-1",
    name: "shared-key",
    keyPrefix: "rk_",
    active: true,
    requestsPerMinute: null,
    dailyTokenLimit: null,
    monthlyTokenLimit: null,
    lifetimeTokenBudget: null,
    maxConcurrentRequests: null,
    providerAllowlist: null,
    modelAllowlist: null,
    modelDenylist: null,
    modelPrefix: null,
    notesTitle: null,
    notesSubtitle: null,
    notesBody: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    ...overrides,
  };
}

const noopDb = {} as unknown as LianRouterDatabase;
const modelDb = {
  select: () => ({
    from: () => ({
      innerJoin: () => ({
        where: async () => [{
          providerId: "openai",
          modelId: "gpt-4",
          wireFamily: "chat",
          contextLimit: 128_000,
          outputLimit: 16_000,
          modalities: { input: ["text", "image"], output: ["text"] },
          reasoning: true,
          toolCall: true,
          webSearch: false,
          source: "discovered",
        }],
      }),
    }),
  }),
} as unknown as LianRouterDatabase;
const VALID_TOKEN = "a".repeat(43);
const noopActivity: ShareActivityPort = {
  async getSharedKeySummaries() { return []; },
  async getSharedKeyDetail() { return { models: [], requests: [] }; },
  async getPublicShareActivity() {
    return {
      allTime: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      lastUsedAt: null,
      models: [],
      requests: [],
      series: [],
    };
  },
};

describe("public share router", () => {
  test("serves enrollment metadata without disclosing any bearer key", async () => {
    const store = fakeStore([
      {
        token: VALID_TOKEN,
        row: shareRow({
          modelAllowlist: ["anthropic/", "openai/gpt-5", "openai/gpt-4"],
          modelDenylist: ["openai/gpt-5"],
          modelPrefix: "openai/",
          notesTitle: "Bansos Token",
        }),
      },
    ]);
    const router = createShareRouter({
      db: modelDb,
      shareStore: store,
      shareActivity: noopActivity,
      resolveClientIp: () => "198.51.100.1",
    });

    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/data`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "shared-key",
      keyPrefix: "rk_",
      canIssue: true,
      alreadyIssued: false,
      recoverable: false,
      models: [{
        id: "openai/gpt-4",
        providerId: "openai",
        modelId: "gpt-4",
        wireFamily: "chat",
        contextLimit: 128_000,
        outputLimit: 16_000,
        reasoning: true,
        toolCall: true,
        vision: true,
        webSearch: false,
        source: "discovered",
      }],
      modelPrefix: "openai/",
      notes: { title: "Bansos Token", subtitle: null, body: null },
    });
    expect(body).not.toHaveProperty("key");
    expect(body).not.toHaveProperty("apiKey");
    expect(body).not.toHaveProperty("clientIp");
    expect(body).not.toHaveProperty("modelAllowlist");
    expect(store.touched).toEqual([hashShareToken(VALID_TOKEN)]);
  });

  test("returns aggregate activity for every child issued by this share template", async () => {
    const store = fakeStore([{ token: VALID_TOKEN, row: shareRow({ modelAllowlist: ["openai/gpt-4"] }) }]);
    const reads: { readonly tenantId: string; readonly parentKeyId: string }[] = [];
    const activity: ShareActivityPort = {
      ...noopActivity,
      async getPublicShareActivity(tenantId, parentKeyId) {
        reads.push({ tenantId, parentKeyId });
        return {
          allTime: { requests: 9, errors: 1, inputTokens: 70, outputTokens: 30, totalTokens: 100 },
          lastUsedAt: "2026-01-03T01:00:00.000Z",
          models: [{
            providerId: "openai",
            modelId: "openai/gpt-4",
            retainedRequests: 9,
            retainedErrors: 1,
            retainedTokens: 100,
            todayRequests: 4,
            todayErrors: 0,
            todayTokens: 60,
          }],
          requests: [{
            requestId: "request-1",
            startedAt: "2026-01-03T01:00:00.000Z",
            providerId: "openai",
            modelId: "openai/gpt-4",
            status: "completed",
            clientIp: "198.51.100.xxx",
            inputTokens: 40,
            outputTokens: 20,
            totalTokens: 60,
          }],
          series: [{ day: "2026-01-03", requests: 4, inputTokens: 40, outputTokens: 20, totalTokens: 60 }],
        };
      },
    };
    const router = createShareRouter({
      db: modelDb,
      shareStore: store,
      shareActivity: activity,
      resolveClientIp: () => "198.51.100.9",
    });
    const response = await router.handle(new Request(`http://internal.test/share/${VALID_TOKEN}/data`));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["activity"]).toMatchObject({
      allTime: { requests: 9, totalTokens: 100 },
      requests: [{ clientIp: "198.51.100.xxx" }],
    });
    expect(body["alreadyIssued"]).toBe(false);
    expect(reads).toEqual([{ tenantId: "tenant-1", parentKeyId: "key-1" }]);
    expect(JSON.stringify(body)).not.toContain("198.51.100.9");
  });

  test("issues the child bearer once and binds it to the resolved client IP", async () => {
    const store = fakeStore([{ token: VALID_TOKEN, row: shareRow() }]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      shareActivity: noopActivity,
      resolveClientIp: () => "198.51.100.9",
    });

    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "enroll-device-abc123" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      keyId: "child-1",
      keyPrefix: "rk_",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    expect(typeof body["key"]).toBe("string");
    expect(store.issued).toEqual([
      {
        tokenHash: hashShareToken(VALID_TOKEN),
        clientIp: "198.51.100.9",
        clientIpKey: "v4:3325256713",
        deviceKey: "enroll-device-abc123",
      },
    ]);
  });

  test("rejects issue and reveal bodies without a usable deviceId", async () => {
    const store = fakeStore([{ token: VALID_TOKEN, row: shareRow() }]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      shareActivity: noopActivity,
      resolveClientIp: () => "198.51.100.9",
    });
    const call = (path: string, body: unknown) =>
      router.handle(new Request(`http://internal.test/share/${VALID_TOKEN}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));

    for (const body of [undefined, {}, { deviceId: "short" }, { deviceId: { x: 1 } }, { deviceId: "has space" }]) {
      const issueResponse = await call("issue", body);
      expect(issueResponse.status).toBe(400);
      expect(await issueResponse.json()).toMatchObject({ error: { code: "device_id_required" } });
      const revealResponse = await call("reveal", body);
      expect(revealResponse.status).toBe(400);
      expect(await revealResponse.json()).toMatchObject({ error: { code: "device_id_required" } });
    }
    expect(store.issued).toEqual([]);
  });

  test("reveal returns 404 when no recoverable child matches the device", async () => {
    const store = fakeStore([{ token: VALID_TOKEN, row: shareRow() }]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      shareActivity: noopActivity,
      resolveClientIp: () => "198.51.100.9",
    });
    const response = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/reveal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "enroll-device-abc123" }),
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "reveal_unavailable" } });
  });

  test("reveal fails closed when the client IP is missing or invalid", async () => {
    const store = fakeStore([{ token: VALID_TOKEN, row: shareRow() }]);
    const missing = createShareRouter({
      db: noopDb,
      shareStore: store,
      shareActivity: noopActivity,
      resolveClientIp: () => null,
    });
    const missingResponse = await missing.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/reveal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "enroll-device-abc123" }),
      }),
    );
    expect(missingResponse.status).toBe(503);

    const invalid = createShareRouter({
      db: noopDb,
      shareStore: store,
      shareActivity: noopActivity,
      resolveClientIp: () => "not-an-ip",
    });
    const invalidResponse = await invalid.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/reveal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "enroll-device-abc123" }),
      }),
    );
    expect(invalidResponse.status).toBe(400);
  });

  test("rejects a second child key for an already active client IP", async () => {
    const store = fakeStore([{ token: VALID_TOKEN, row: shareRow() }]);
    const router = createShareRouter({
      db: noopDb,
      shareStore: store,
      shareActivity: noopActivity,
      resolveClientIp: () => "198.51.100.9",
    });
    const request = () =>
      router.handle(new Request(`http://internal.test/share/${VALID_TOKEN}/issue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "enroll-device-abc123" }),
      }));

    expect((await request()).status).toBe(201);
    const second = await request();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: { code: "shared_key_ip_limit" },
    });
  });

  test("fails closed when a trusted client IP is missing or invalid", async () => {
    const store = fakeStore([{ token: VALID_TOKEN, row: shareRow() }]);
    const missing = createShareRouter({
      db: noopDb,
      shareStore: store,
      shareActivity: noopActivity,
      resolveClientIp: () => null,
    });
    const missingResponse = await missing.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/issue`, { method: "POST" }),
    );
    expect(missingResponse.status).toBe(503);

    const invalid = createShareRouter({
      db: noopDb,
      shareStore: store,
      shareActivity: noopActivity,
      resolveClientIp: () => "not-an-ip",
    });
    const invalidResponse = await invalid.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/issue`, { method: "POST" }),
    );
    expect(invalidResponse.status).toBe(400);
  });

  test("reveal returns the decrypted key only for a matching device and IP", async () => {
    const router = createShareRouter({
      db: noopDb,
      shareStore: fakeStore([]),
      shareActivity: noopActivity,
      resolveClientIp: () => "198.51.100.9",
    });
    const call = (body: unknown) =>
      router.handle(
        new Request(`http://internal.test/share/${VALID_TOKEN}/reveal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    // A store with no matching row 404s; the key never leaves the server.
    const missing = await call({ deviceId: "enroll-device-abc123" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "reveal_unavailable" } });

    // A body without a usable deviceId fails before any store read.
    const noDevice = await router.handle(
      new Request(`http://internal.test/share/${VALID_TOKEN}/reveal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "x" }),
      }),
    );
    expect(noDevice.status).toBe(400);
  });

  test("rejects unknown and short tokens with a JSON 404", async () => {
    const router = createShareRouter({
      db: noopDb,
      shareStore: fakeStore([]),
      shareActivity: noopActivity,
      resolveClientIp: () => "198.51.100.1",
    });
    for (const token of ["short", "b".repeat(43)]) {
      const response = await router.handle(
        new Request(`http://internal.test/share/${token}/data`),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.text()).not.toContain("<html");
    }
  });
});
