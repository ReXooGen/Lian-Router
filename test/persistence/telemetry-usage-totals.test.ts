import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { ApiKeyRecord } from "../../src/persistence/api-key-store";
import { getDb, type LianRouterDatabase } from "../../src/persistence/postgres";
import { apiKeys, telemetryEvents, telemetryUsageTotals, tenants } from "../../src/persistence/schema";
import { DrizzleTelemetryStore } from "../../src/persistence/telemetry-store";
import { createShareUsagePort } from "../../src/console/share/share-usage";
import { dbDescribe } from "../helpers/db-gate";

dbDescribe("telemetry lifetime aggregates", () => {
  const tenantId = randomUUID();
  const accountId = randomUUID();
  const parentKeyId = randomUUID();
  const apiKeyId = randomUUID();
  const siblingKeyId = randomUUID();
  const otherParentKeyId = randomUUID();
  const otherChildKeyId = randomUUID();
  let db: LianRouterDatabase;
  let store: DrizzleTelemetryStore;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleTelemetryStore(db);
    await db.insert(tenants).values({
      id: tenantId,
      name: `telemetry-totals-${tenantId}`,
      status: "active",
    });
    await db.insert(apiKeys).values([
      { id: parentKeyId, tenantId, keyMode: "share", label: "parent", scopes: ["routing:invoke"] },
      { id: otherParentKeyId, tenantId, keyMode: "share", label: "other parent", scopes: ["routing:invoke"] },
    ]);
    await db.insert(apiKeys).values([
      {
        id: apiKeyId, tenantId, keyHash: `hash-${apiKeyId}`, keyMode: "share", parentKeyId,
        issuedClientIp: "198.51.100.11", issuedClientIpKey: `v4:${apiKeyId}`, label: "child one",
        scopes: ["routing:invoke"],
      },
      {
        id: siblingKeyId, tenantId, keyHash: `hash-${siblingKeyId}`, keyMode: "share", parentKeyId,
        issuedClientIp: "203.0.113.22", issuedClientIpKey: `v4:${siblingKeyId}`, label: "child two",
        scopes: ["routing:invoke"],
      },
      {
        id: otherChildKeyId, tenantId, keyHash: `hash-${otherChildKeyId}`, keyMode: "share",
        parentKeyId: otherParentKeyId, issuedClientIp: "192.0.2.33",
        issuedClientIpKey: `v4:${otherChildKeyId}`, label: "other child", scopes: ["routing:invoke"],
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("retains account and API-key totals after raw telemetry is removed", async () => {
    await store.insertEvents([
      {
        tenantId,
        requestId: randomUUID(),
        sourceSurface: "chat",
        requestedModel: "openai/gpt-5",
        accountId,
        apiKeyId,
        stream: false,
        status: "completed",
        inputTokens: 50,
        outputTokens: 12,
        clientIp: "198.51.100.7",
      },
      {
        tenantId,
        requestId: randomUUID(),
        sourceSurface: "chat",
        requestedModel: "openai/gpt-5",
        accountId,
        apiKeyId,
        stream: false,
        status: "failed",
        inputTokens: 7,
        outputTokens: 1,
        clientIp: "198.51.100.9",
      },
      {
        tenantId,
        requestId: randomUUID(),
        sourceSurface: "chat",
        requestedModel: "anthropic/claude-sonnet",
        accountId,
        apiKeyId: siblingKeyId,
        stream: false,
        status: "completed",
        inputTokens: 20,
        outputTokens: 5,
        clientIp: "203.0.113.22",
      },
      {
        tenantId,
        requestId: randomUUID(),
        sourceSurface: "chat",
        requestedModel: "grok/grok-4",
        accountId,
        apiKeyId: otherChildKeyId,
        stream: false,
        status: "completed",
        inputTokens: 500,
        outputTokens: 100,
        clientIp: "192.0.2.33",
      },
    ]);

    const firstRead = await db
      .select()
      .from(telemetryUsageTotals)
      .where(eq(telemetryUsageTotals.tenantId, tenantId));
    expect(firstRead).toHaveLength(4);
    expect(firstRead.find((row) => row.identityType === "account")).toMatchObject({
      requests: 4,
      errors: 1,
      inputTokens: 577,
      outputTokens: 118,
    });
    expect(firstRead.find((row) => row.identityType === "api_key" && row.entityId === apiKeyId)).toMatchObject({
      requests: 2,
      errors: 1,
      inputTokens: 57,
      outputTokens: 13,
    });

    const child: ApiKeyRecord = {
      id: apiKeyId,
      tenantId,
      keyHash: "stored-hash",
      keyMode: "share",
      parentKeyId,
      issuedClientIp: "198.51.100.11",
      issuedClientIpKey: "v4:3325256715",
      label: "shared child",
      scopes: ["routing:invoke"],
      keyPrefix: "rk_",
      createdAt: new Date(),
      tokensConsumed: 0,
    };
    const activity = createShareUsagePort(db);
    const [summary] = await activity.getSharedKeySummaries(tenantId, [child]);
    expect(summary?.allTime).toMatchObject({
      requests: 2,
      errors: 1,
      inputTokens: 57,
      outputTokens: 13,
      totalTokens: 70,
    });
    expect(summary?.issuedClientIp).toBe("198.51.100.xxx");
    const detail = await activity.getSharedKeyDetail(tenantId, apiKeyId);
    expect(detail.models[0]).toMatchObject({
      modelId: "openai/gpt-5",
      retainedRequests: 2,
      retainedErrors: 1,
      retainedTokens: 70,
    });
    expect(detail.requests[0]?.clientIp).toMatch(/^198\.51\.100\.xxx$/);

    const publicActivity = await activity.getPublicShareActivity(tenantId, parentKeyId);
    expect(publicActivity.allTime).toMatchObject({ requests: 3, errors: 1, totalTokens: 95 });
    expect(publicActivity.series).toHaveLength(7);
    expect(publicActivity.series.at(-1)).toMatchObject({ requests: 3, totalTokens: 95 });
    expect(publicActivity.models.map((model) => model.modelId)).toEqual([
      "openai/gpt-5",
      "anthropic/claude-sonnet",
    ]);
    expect(publicActivity.requests.map((event) => event.clientIp).sort()).toEqual([
      "198.51.100.xxx",
      "198.51.100.xxx",
      "203.0.113.xxx",
    ]);
    expect(JSON.stringify(publicActivity)).not.toContain("grok/grok-4");
    expect(JSON.stringify(publicActivity)).not.toContain("192.0.2");

    await db.delete(telemetryEvents).where(eq(telemetryEvents.tenantId, tenantId));
    const retained = await db
      .select()
      .from(telemetryUsageTotals)
      .where(eq(telemetryUsageTotals.tenantId, tenantId));
    expect(retained).toHaveLength(4);
    expect(retained.find((row) => row.identityType === "api_key" && row.entityId === apiKeyId))
      .toMatchObject({ requests: 2, errors: 1 });
  });
});
