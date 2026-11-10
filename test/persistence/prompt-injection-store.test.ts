import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../src/persistence/postgres";
import { DrizzlePromptInjectionStore } from "../../src/persistence/prompt-injection-store";
import { tenants } from "../../src/persistence/schema";
import { dbDescribe } from "../helpers/db-gate";

dbDescribe("prompt injection exclusions", () => {
  const tenantId = randomUUID();
  let db: LianRouterDatabase;

  beforeAll(async () => {
    db = getDb();
    await db.insert(tenants).values({
      id: tenantId,
      name: `prompt-injection-exclusions-${tenantId}`,
      status: "active",
    });
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("persists both exclusion lists and resolves them at request time", async () => {
    const store = new DrizzlePromptInjectionStore(db);
    await store.upsert(tenantId, "global", "", {
      name: "persona",
      active: true,
      mode: "prompt",
      preset: "custom",
      content: "PERSONA",
      turns: [],
      position: "prepend",
      enabled: true,
      excludedClientIps: ["203.0.113.7"],
      excludedApiKeyIds: ["key-1"],
    });

    const [saved] = await store.list(tenantId);
    expect(saved?.excludedClientIps).toEqual(["203.0.113.7"]);
    expect(saved?.excludedApiKeyIds).toEqual(["key-1"]);

    // A matching client address or key skips the entry; the empty context
    // (neither value known) still applies it.
    expect(await store.resolve(tenantId, { clientIp: "203.0.113.7", modelNames: [] })).toEqual([]);
    expect(await store.resolve(tenantId, { apiKeyId: "key-1", modelNames: [] })).toEqual([]);
    expect(
      await store.resolve(tenantId, {
        apiKeyId: "child-1",
        parentApiKeyId: "key-1",
        modelNames: [],
      }),
    ).toEqual([]);
    expect((await store.resolve(tenantId, { modelNames: [] })).length).toBe(1);
    expect(
      (await store.resolve(tenantId, { clientIp: "203.0.113.8", apiKeyId: "key-2", modelNames: [] }))
        .length,
    ).toBe(1);
  });
});
