import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { models, providers, tenants } from "../../../src/persistence/schema";
import { DrizzleTelemetryStore } from "../../../src/persistence/telemetry-store";
import { DrizzleProviderCatalogStore } from "../../../src/console/providers/catalog/store";
import { createProviderCatalogOperations } from "../../../src/console/providers/catalog/provider-operations";
import type { AccessDecision } from "../../../src/security/access-control";
import { createDefaultProviderRegistry } from "../../../src/providers/default-registry";

function storeOptions() {
  return {
    telemetryBuffer: {} as never,
    bundledModelCatalog: { modelsByProvider: new Map() },
    providerRegistry: createDefaultProviderRegistry(),
    outboundFetchFor: () => (async () => new Response("{}")) as never,
    snapshotInvalidator: { invalidate: async () => 0 },
  };
}

dbDescribe("DrizzleProviderCatalogStore CRUD", () => {
  let db: LianRouterDatabase;
  let store: DrizzleProviderCatalogStore;
  const tenantId = randomUUID();
  const providerId = `catalog-store-test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleProviderCatalogStore(db, storeOptions());
    await db.insert(tenants).values({ id: tenantId, name: "catalog-store-test", status: "active" }).onConflictDoNothing();
  });

  test("create + get + list round-trips a BYOK provider", async () => {
    await store.create({
      providerId,
      tenantId,
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: false,
    });
    const got = await store.get(tenantId, providerId);
    expect(got?.providerId).toBe(providerId);
    const listed = await store.list(tenantId);
    expect(listed.some((p) => p.providerId === providerId)).toBe(true);
  });

  test("create rejects a builtin id", async () => {
    await expect(
      store.create({
        providerId: "openai",
        tenantId,
        enabled: true,
        isBuiltIn: true,
        requiresAccount: true,
        supportsModelDiscovery: false,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "provider_is_builtin" }));
  });

  test("update toggles enabled and delete removes the row", async () => {
    const id = `catalog-upd-${randomUUID().slice(0, 8)}`;
    await store.create({
      providerId: id,
      tenantId,
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: false,
    });
    const updated = await store.update(tenantId, id, { enabled: false });
    expect(updated?.enabled).toBe(false);
    expect(await store.delete(tenantId, id)).toBe(true);
    expect(await store.get(tenantId, id)).toBeUndefined();
    expect(await store.delete(tenantId, id)).toBe(false);
  });

  test("account lifecycle: create, list, update, health events", async () => {
    const created = await store.createAccount(tenantId, providerId, {
      label: "acct-1",
      secret: "sk-test-secret",
      credentialKind: "api_key",
    });
    expect(created.id).toBeTruthy();
    const accounts = await store.listAccounts(tenantId, providerId);
    expect(accounts.some((a) => a.id === created.id)).toBe(true);
    const all = await store.listAllAccounts(tenantId);
    expect(all.some((a) => a.id === created.id)).toBe(true);
    const events = await store.listAccountHealthEvents(tenantId, providerId, created.id);
    expect(Array.isArray(events)).toBe(true);
  });

  test("model rows: register, list, enable toggle, delete", async () => {
    await store.registerModels(tenantId, providerId, ["test-model-1"], "chat");
    const models = await store.listModels(tenantId, providerId);
    expect(models.some((m) => m.modelId === "test-model-1")).toBe(true);
    const route = models.find((m) => m.modelId === "test-model-1")?.route ?? "";
    await store.setModelEnabled(tenantId, providerId, {
      modelId: "test-model-1",
      route,
      enabled: false,
    });
    await store.deleteModel(tenantId, providerId, { modelId: "test-model-1", route, enabled: false });
    const after = await store.listModels(tenantId, providerId);
    expect(after.some((m) => m.modelId === "test-model-1")).toBe(false);
  });

  test("tenant scoping: another tenant cannot see the row", async () => {
    expect(await store.get(randomUUID(), providerId)).toBeUndefined();
  });
});

dbDescribe("DrizzleProviderCatalogStore account mutations", () => {
  let db: LianRouterDatabase;
  let store: DrizzleProviderCatalogStore;
  const tenantId = randomUUID();
  const providerId = `catalog-acct-${randomUUID().slice(0, 8)}`;
  let accountId: string;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleProviderCatalogStore(db, storeOptions());
    await db.insert(tenants).values({ id: tenantId, name: "catalog-acct-test", status: "active" }).onConflictDoNothing();
    await store.create({
      providerId,
      tenantId,
      enabled: true,
      isBuiltIn: false,
      requiresAccount: true,
      supportsModelDiscovery: false,
    });
    const created = await store.createAccount(tenantId, providerId, {
      label: "acct-mut",
      secret: "sk-mut-secret",
      credentialKind: "api_key",
      maxInflight: 2,
    });
    accountId = created.id;
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("updateAccount changes the label", async () => {
    const updated = await store.updateAccount(tenantId, providerId, accountId, { label: "renamed" });
    expect(updated?.label).toBe("renamed");
    expect(await store.updateAccount(tenantId, providerId, randomUUID(), { label: "x" })).toBeUndefined();
  });

  test("persists per-account concurrency and reports today/lifetime token usage", async () => {
    const updated = await store.updateAccount(tenantId, providerId, accountId, { maxInflight: 4 });
    expect(updated?.maxInflight).toBe(4);

    const telemetry = new DrizzleTelemetryStore(db);
    await telemetry.insertEvents([
      {
        tenantId,
        requestId: randomUUID(),
        sourceSurface: "chat",
        requestedModel: "openai/gpt-5",
        accountId,
        stream: false,
        status: "completed",
        inputTokens: 20,
        outputTokens: 5,
      },
      {
        tenantId,
        requestId: randomUUID(),
        sourceSurface: "chat",
        requestedModel: "openai/gpt-5",
        accountId,
        stream: false,
        status: "failed",
        inputTokens: 7,
        outputTokens: 1,
      },
    ]);

    const account = (await store.listAccounts(tenantId, providerId)).find(
      (entry) => entry.id === accountId,
    );
    expect(account?.usageToday).toMatchObject({
      requests: 2,
      errors: 1,
      inputTokens: 27,
      outputTokens: 6,
      totalTokens: 33,
    });
    expect(account?.usageAllTime).toEqual(account?.usageToday);
    expect(account?.maxInflight).toBe(4);
  });

  test("listAccountHealthEvents returns an array", async () => {
    expect(await store.listAccountHealthEvents(tenantId, providerId, accountId)).toEqual([]);
  });

  test("recoverAccount flips a disabled account back", async () => {
    await store.updateAccount(tenantId, providerId, accountId, { status: "disabled" } as never);
    expect(await store.recoverAccount(tenantId, providerId, accountId)).toBe(true);
    expect(await store.recoverAccount(tenantId, providerId, randomUUID())).toBe(false);
  });

  test("listModelsForTenant costs a constant number of queries, not one pair per provider", async () => {
    // The defect this pins: the flat catalog looped per provider and called
    // `listModels`, which is two queries each, so the cost grew with the
    // provider count. A value-only assertion cannot see that — the same rows
    // come back either way — so this counts the statements Postgres receives.
    // The count must stay flat as providers are added; that is the whole fix.
    const counted: number[] = [];
    for (const providerCount of [1, 5]) {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      let queries = 0;
      const original = pool.query.bind(pool);
      pool.query = ((...args: unknown[]) => {
        queries += 1;
        return (original as (...a: unknown[]) => unknown)(...args);
      }) as typeof pool.query;

      const tag = randomUUID().slice(0, 8);
      const extraTenant = randomUUID();
      try {
        const countingStore = new DrizzleProviderCatalogStore(
          drizzle(pool) as unknown as LianRouterDatabase,
          storeOptions(),
        );
        // Seed through the shared handle: the store's own `db` is private, and
        // the seeding must not count toward the measurement anyway.
        await db.insert(tenants).values({
          id: extraTenant,
          name: `catalog-bulk-${tag}`,
          status: "active",
        });
        for (let i = 0; i < providerCount; i += 1) {
          const pid = `bulk-${tag}-${i}`;
          await db
            .insert(providers)
            .values({ id: pid, tenantId: extraTenant, enabled: true, requiresAccount: true });
          await db.insert(models).values({
            providerId: pid,
            modelId: `m${i}`,
            endpointPath: "/v1/chat/completions",
            wireFamily: "chat",
          } as never);
        }

        queries = 0;
        await countingStore.listModelsForTenant(extraTenant);
        counted.push(queries);
      } finally {
        await db.delete(tenants).where(eq(tenants.id, extraTenant));
        await pool.end();
      }
    }

    // Two statements — the disabled-model read and the models join — for both
    // a one-provider and a five-provider tenant.
    expect(counted[0]).toBe(counted[1]);
    expect(counted[0]).toBeLessThanOrEqual(2);
  });
});

dbDescribe("DrizzleProviderCatalogStore — stale global provider rows", () => {
  // A bundled provider that later left the bundle keeps its `providers` row
  // (`seedBundledProviders` upserts and never prunes) with `tenant_id IS NULL`.
  // The tenant-scoped delete must remove it — it is visible in `list`, so it
  // must be removable — while a row owned by another tenant stays invisible
  // and undeletable, and a bundled id stays refused.
  let db: LianRouterDatabase;
  let store: DrizzleProviderCatalogStore;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const staleId = `stale-orphan-${randomUUID().slice(0, 8)}`;
  const foreignId = `foreign-orphan-${randomUUID().slice(0, 8)}`;

  const accessFor = (tenant: string): AccessDecision => ({
    id: `user-${tenant}`,
    tenantId: tenant,
    scopes: ["providers:read", "providers:write"],
    admissionIdentity: `user-${tenant}`,
  });

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleProviderCatalogStore(db, storeOptions());
    await db
      .insert(tenants)
      .values([
        { id: tenantId, name: "stale-orphan-test", status: "active" },
        { id: otherTenantId, name: "stale-orphan-other", status: "active" },
      ])
      .onConflictDoNothing();
    await db.insert(providers).values([
      { id: staleId, tenantId: null, enabled: true, requiresAccount: true },
      { id: foreignId, tenantId: otherTenantId, enabled: true, requiresAccount: true },
    ]);
    await db.insert(models).values({
      providerId: staleId,
      modelId: "orphan-model",
      endpointPath: "/v1/chat/completions",
      wireFamily: "chat",
      source: "builtin",
    } as never);
  });

  afterAll(async () => {
    await db.delete(tenants).where(inArray(tenants.id, [tenantId, otherTenantId]));
  });

  function operations() {
    return createProviderCatalogOperations({
      store,
      accessResolver: () => accessFor(tenantId),
      providerRegistry: createDefaultProviderRegistry(),
    });
  }

  test("a global row for a provider that left the bundle is listed as stale and deletes through the tenant route", async () => {
    const factory = operations();
    const listed = await factory.listProviders(accessFor(tenantId));
    const stale = listed.find((p) => p.providerId === staleId);
    expect(stale).toMatchObject({ isBuiltIn: false, stale: true });

    await expect(factory.deleteProvider(accessFor(tenantId), staleId)).resolves.toEqual({
      success: true,
    });
    expect(await store.get(tenantId, staleId)).toBeUndefined();
    // The provider FK cascade removed its models with the row.
    expect(
      await db.select().from(models).where(eq(models.providerId, staleId)),
    ).toEqual([]);
  });

  test("a global row for a bundled id still fails with provider_is_builtin", async () => {
    await expect(operations().deleteProvider(accessFor(tenantId), "openai")).rejects.toMatchObject(
      { code: "provider_is_builtin", status: 403 },
    );
    expect(await store.get(tenantId, "openai")).toBeDefined();
  });

  test("a row owned by another tenant is not deletable and still answers provider_not_found", async () => {
    await expect(operations().deleteProvider(accessFor(tenantId), foreignId)).rejects.toMatchObject(
      { code: "provider_not_found", status: 404 },
    );
    // Still present, still owned by the other tenant: the widened predicate
    // did not become a cross-tenant delete.
    expect(await store.get(otherTenantId, foreignId)).toMatchObject({
      providerId: foreignId,
      tenantId: otherTenantId,
    });
  });
});
