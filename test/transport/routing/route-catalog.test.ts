import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabaseSnapshotBuilder } from "../../../src/transport/routing/route-catalog";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import {
  providers,
  tenants,
  models,
  modelAliases,
  modelCombos,
  networkPools,
  providerAccounts,
  providerRoutingSettings,
  poolRoutingSettings,
  cliToolMappings,
} from "../../../src/persistence/schema";

dbDescribe("createDatabaseSnapshotBuilder — model aliases/combos", () => {
  let db: LianRouterDatabase;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const providerId = `snapshot-builder-test-${randomUUID().slice(0, 8)}`;
  const modelId = `known-model-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = getDb();
    await db.insert(tenants)
      .values([
        { id: tenantA, name: "snapshot-builder-test-a", status: "active" },
        { id: tenantB, name: "snapshot-builder-test-b", status: "active" },
      ])
      .onConflictDoNothing();
    await db.insert(providers).values({ id: providerId, tenantId: tenantA, enabled: true });
    await db.insert(models).values({
      providerId,
      modelId,
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      enabled: true,
    });
    await db.insert(modelAliases).values([
      { tenantId: tenantA, alias: "fast", targetModel: modelId },
      { tenantId: tenantB, alias: "quick", targetModel: modelId },
    ]);
    await db.insert(modelCombos).values([
      { tenantId: tenantA, name: "pool-a", members: [modelId], strategy: "fallback" },
      { tenantId: tenantB, name: "pool-b", members: [modelId], strategy: "round_robin" },
    ]);
    await db.insert(cliToolMappings).values([
      { tenantId: tenantA, toolId: "claude", slotKey: "sonnet", sourceModel: "claude-sonnet-4-5", targetModel: modelId, enabled: true },
      { tenantId: tenantA, toolId: "claude", slotKey: "opus", sourceModel: "claude-opus-4-5", targetModel: modelId, enabled: false },
      { tenantId: tenantB, toolId: "claude", slotKey: "haiku", sourceModel: "claude-haiku-4-5", targetModel: modelId, enabled: true },
    ]);
  });

  afterAll(async () => {
    await db.delete(cliToolMappings).where(inArray(cliToolMappings.tenantId, [tenantA, tenantB]));
    await db.delete(modelAliases).where(inArray(modelAliases.tenantId, [tenantA, tenantB]));
    await db.delete(modelCombos).where(inArray(modelCombos.tenantId, [tenantA, tenantB]));
    await db.delete(models).where(eq(models.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  });
  test("nests aliases and combos by tenantId without leaking across tenants", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();

    expect(built.aliases[tenantA]).toEqual({ fast: modelId });
    expect(built.aliases[tenantB]).toEqual({ quick: modelId });
    expect(built.aliases[tenantA]?.quick).toBeUndefined();

    // CLI-tool mappings are NOT tenant model aliases: they live in their own
    // bucket and merge in only for keys carrying the `routing:cli_mapping`
    // scope (see `aliasMapFor()` in routing/router.ts). Keeping them out of
    // `aliases` is what stops a CLI slot name from being routable by a key
    // without that scope.
    expect(built.cli_aliases?.[tenantA]).toEqual({
      "claude-sonnet-4-5": modelId,
      // `cliMappingSourceKeys()` also registers the family slot and
      // versioned aliases, so a bare family name resolves too.
      sonnet: modelId,
      "claude-sonnet-5": modelId,
      "claude-sonnet-5-1": modelId,
      "claude-sonnet-4-6": modelId,
    });
    expect(built.cli_aliases?.[tenantB]).toEqual({
      "claude-haiku-4-5": modelId,
      haiku: modelId,
      "claude-haiku-5": modelId,
      "claude-haiku-5-1": modelId,
      "claude-haiku-4-6": modelId,
    });
    expect(built.combos[tenantB]).toEqual({
      "pool-b": { members: [modelId], strategy: "round_robin" },
    });
    expect(built.combos[tenantA]?.["pool-b"]).toBeUndefined();
    expect(built.combos[tenantB]?.["pool-a"]).toBeUndefined();
  });

  test("candidates still carry the correct provider/tenant shape", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();
    const candidate = built.candidates.find(
      (c) => c.model_id === modelId && c.provider_id === providerId,
    );
    expect(candidate).toBeDefined();
    expect(candidate?.tenant_id).toBe(tenantA);
  });
});

dbDescribe("createDatabaseSnapshotBuilder — automatic network pool selection", () => {
  let db: LianRouterDatabase;
  const tenantId = randomUUID();
  const providerId = `snapshot-builder-pool-test-${randomUUID().slice(0, 8)}`;
  const modelId = `pool-model-${randomUUID().slice(0, 8)}`;
  const accountId = randomUUID();
  const activePoolId = randomUUID();
  const disabledPoolId = randomUUID();
  // A second *active* pool. Without it the tenant's pool group and a binding to
  // the only pool are indistinguishable, so a test could not tell "the account
  // uses its bound pool" from "the account uses whatever the group offers".
  const otherActivePoolId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "snapshot-builder-pool-test", status: "active" })
      .onConflictDoNothing();
    await db.insert(providers).values({ id: providerId, tenantId: null, enabled: true });
    await db.insert(models).values({
      providerId,
      modelId,
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      enabled: true,
    });
    await db.insert(providerAccounts).values({
      id: accountId,
      providerId,
      tenantId,
      label: "pool-test-account",
      credentialKind: "api_key",
      status: "active",
    });
    await db.insert(networkPools).values([
      {
        id: activePoolId,
        kind: "http",
        endpointConfig: { endpoint: "https://proxy-a.example:443" },
        tenantId,
        status: "active",
        maxInflight: 12,
      },
      {
        id: disabledPoolId,
        kind: "http",
        endpointConfig: { endpoint: "https://proxy-b.example:443" },
        tenantId,
        status: "disabled",
        maxInflight: 8,
      },
      {
        id: otherActivePoolId,
        kind: "http",
        endpointConfig: { endpoint: "https://proxy-c.example:443" },
        tenantId,
        status: "active",
        maxInflight: 4,
        weight: 100,
      },
    ]);
    await db.insert(providerRoutingSettings).values({
      providerId,
      tenantId,
      strategy: "fallback",
      enabled: true,
      bypassProxy: false,
    });
    await db.insert(poolRoutingSettings).values({
      tenantId,
      strategy: "round_robin",
      rotateCount: 2,
    });
  });

  afterAll(async () => {
    await db.delete(poolRoutingSettings).where(eq(poolRoutingSettings.tenantId, tenantId));
    await db
      .delete(providerRoutingSettings)
      .where(eq(providerRoutingSettings.providerId, providerId));
    await db.delete(networkPools).where(inArray(networkPools.id, [activePoolId, disabledPoolId, otherActivePoolId]));
    await db.delete(providerAccounts).where(eq(providerAccounts.id, accountId));
    await db.delete(models).where(eq(models.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("attaches every active pool (never a pinned single pool) with its concurrency limit, excluding disabled pools", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();
    const candidate = built.candidates.find(
      (c) => c.model_id === modelId && c.provider_id === providerId,
    );
    expect(candidate).toBeDefined();
    expect(candidate?.network_pool_ids).toEqual([activePoolId, otherActivePoolId]);
    expect(candidate?.network_pool_limits).toEqual({
      [activePoolId]: 12,
      [otherActivePoolId]: 4,
    });
  });

  test("binds an account to its own pool, and only that pool", async () => {
    // A binding is the account's egress identity. The fixture's account starts
    // unbound, so the first assertion is the pre-existing behavior; the second
    // is the new rule — the tenant's whole pool group collapses to the one
    // bound pool, which is what stops dispatch from picking a different egress
    // for a credential that must leave from a specific address.
    const candidateFor = async () => {
      const built = await createDatabaseSnapshotBuilder(db)();
      return built.candidates.find((c) => c.provider_account_id === accountId);
    };

    try {
      const unbound = await candidateFor();
      // Unbound: the tenant's whole active pool group, in order.
      expect(unbound?.network_pool_ids).toEqual([activePoolId, otherActivePoolId]);
      expect((unbound as { health_status?: string })?.health_status).toBeUndefined();

      await db
        .update(providerAccounts)
        .set({ networkPoolId: activePoolId })
        .where(eq(providerAccounts.id, accountId));

      const bound = await candidateFor();
      // Bound: exactly the bound pool. `otherActivePoolId` is active and owned
      // by the same tenant, so a binding that was ignored (or resolved to the
      // group) would show up here as a second id.
      expect(bound?.network_pool_ids).toEqual([activePoolId]);
      expect(bound?.network_pool_limits).toEqual({ [activePoolId]: 12 });
      expect(bound?.network_pool_required).toBe(true);
    } finally {
      await db
        .update(providerAccounts)
        .set({ networkPoolId: null })
        .where(eq(providerAccounts.id, accountId));
    }
  });

  test("a bound pool that cannot be honored leaves the account unroutable, never direct", async () => {
    // The pool is disabled, so it is absent from the active-pool index. The
    // account must come back marked unusable rather than falling through to the
    // tenant group or to a direct dial: either would egress from an address the
    // binding exists to avoid.
    try {
      await db
        .update(providerAccounts)
        .set({ networkPoolId: disabledPoolId })
        .where(eq(providerAccounts.id, accountId));

      const built = await createDatabaseSnapshotBuilder(db)();
      const candidate = built.candidates.find((c) => c.provider_account_id === accountId);
      expect(candidate).toBeDefined();
      expect((candidate as { health_status?: string })?.health_status).toBe("disabled");
      expect(candidate?.network_pool_ids).toBeUndefined();
    } finally {
      await db
        .update(providerAccounts)
        .set({ networkPoolId: null })
        .where(eq(providerAccounts.id, accountId));
    }
  });

  test("a deleted pool detaches its accounts instead of deleting them", async () => {
    // `set null` on the foreign key: the operator loses the binding, which they
    // can see and re-set, not the credentials behind it.
    const poolId = randomUUID();
    await db.insert(networkPools).values({
      id: poolId,
      kind: "http",
      endpointConfig: { endpoint: "https://proxy-temp.example:443" },
      tenantId,
      status: "active",
    });
    await db
      .update(providerAccounts)
      .set({ networkPoolId: poolId })
      .where(eq(providerAccounts.id, accountId));

    await db.delete(networkPools).where(eq(networkPools.id, poolId));

    const rows = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.networkPoolId).toBeNull();
  });

  test("carries the pool routing strategy onto the snapshot and candidate", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();
    expect(built.poolRouting?.[tenantId]).toEqual({ strategy: "round_robin", rotateCount: 2 });
    const candidate = built.candidates.find(
      (c) => c.model_id === modelId && c.provider_id === providerId,
    );
    expect(candidate?.network_pool_routing).toEqual({
      strategy: "round_robin",
      rotateCount: 2,
      tenantId,
    });
  });

  test("resolves the provider system prompt per field across the routing rows", async () => {
    // The candidate is what dispatch merges from, so this is the whole read
    // path from column to wire input. The fixture above creates a *tenant* row
    // for this provider, which is what makes the case meaningful: a tenant row
    // exists and carries no prompt, so only a per-field read of the global row
    // can produce one. Whole-row resolution — the plausible wrong fix — returns
    // nothing here, and a read that ignores the global row returns nothing too.
    const candidate = async () => {
      const built = await createDatabaseSnapshotBuilder(db)();
      return built.candidates.find((c) => c.model_id === modelId && c.provider_id === providerId);
    };
    const setPrompt = async (prompt: string | null, tenantId: string | null) => {
      const where =
        tenantId === null
          ? and(
              eq(providerRoutingSettings.providerId, providerId),
              isNull(providerRoutingSettings.tenantId),
            )
          : and(
              eq(providerRoutingSettings.providerId, providerId),
              eq(providerRoutingSettings.tenantId, tenantId),
            );
      // The fixture creates a tenant row but no global one, and a global row is
      // exactly what this case needs — an UPDATE against a row that does not
      // exist silently affects nothing and would make the assertion below pass
      // or fail for the wrong reason.
      const updated = await db
        .update(providerRoutingSettings)
        .set({ systemPrompt: prompt })
        .where(where)
        .returning();
      if (updated.length === 0) {
        await db.insert(providerRoutingSettings).values({
          providerId,
          tenantId,
          strategy: "fallback",
          enabled: true,
          bypassProxy: false,
          systemPrompt: prompt,
        });
      }
    };

    try {
      expect((await candidate())?.system_prompt).toBeUndefined();

      // Global only. The tenant row exists but sets no prompt of its own.
      await setPrompt("global hint", null);
      expect((await candidate())?.system_prompt).toBe("global hint");

      // The tenant's own prompt wins over the global one.
      await setPrompt("tenant hint", tenantId);
      expect((await candidate())?.system_prompt).toBe("tenant hint");

      // Clearing the tenant row falls back to the global prompt rather than to
      // nothing, which is the same per-field rule seen from the other side.
      await setPrompt(null, tenantId);
      expect((await candidate())?.system_prompt).toBe("global hint");
    } finally {
      await setPrompt(null, null);
      await setPrompt(null, tenantId);
    }
  });

  test("keeps proxy routing fail-closed when every configured pool is unhealthy", async () => {
    const allActivePoolIds = [activePoolId, otherActivePoolId];
    await db.update(networkPools).set({ status: "cooldown" }).where(inArray(networkPools.id, allActivePoolIds));
    try {
      const built = await createDatabaseSnapshotBuilder(db)();
      const candidate = built.candidates.find(
        (row) => row.model_id === modelId && row.provider_id === providerId,
      );
      // Every pool cooled down, so the candidate carries an empty eligible set
      // plus the required flag — dispatch must fail rather than dial direct.
      expect(candidate?.network_pool_ids).toEqual([]);
      expect(candidate?.network_pool_required).toBe(true);
    } finally {
      await db.update(networkPools).set({ status: "active" }).where(inArray(networkPools.id, allActivePoolIds));
    }
  });

  test("bypassProxy leaves the candidate with no network pools at all", async () => {
    await db
      .update(providerRoutingSettings)
      .set({ bypassProxy: true })
      .where(eq(providerRoutingSettings.providerId, providerId));
    try {
      const builder = createDatabaseSnapshotBuilder(db);
      const built = await builder();
      const candidate = built.candidates.find(
        (c) => c.model_id === modelId && c.provider_id === providerId,
      );
      expect(candidate).toBeDefined();
      expect(candidate?.network_pool_ids).toBeUndefined();
    } finally {
      await db
        .update(providerRoutingSettings)
        .set({ bypassProxy: false })
        .where(eq(providerRoutingSettings.providerId, providerId));
    }
  });

  test("a direct-pinned account carries no pool ids and the direct marker", async () => {
    // The provider's own routing still routes through the tenant's pool group
    // (`bypassProxy: false` above), so an account that comes back pooled would
    // be indistinguishable from one that simply never opted out. The marker is
    // asserted too: without it dispatch inherits a sibling account's pool and
    // the account egresses through an address the operator excluded.
    const candidateFor = async () => {
      const built = await createDatabaseSnapshotBuilder(db)();
      return built.candidates.find((c) => c.provider_account_id === accountId);
    };

    try {
      expect((await candidateFor())?.network_pool_ids).toEqual([
        activePoolId,
        otherActivePoolId,
      ]);
      expect((await candidateFor())?.network_pool_direct).toBeUndefined();

      await db
        .update(providerAccounts)
        .set({ bypassProxy: true, networkPoolId: null })
        .where(eq(providerAccounts.id, accountId));

      const direct = await candidateFor();
      expect(direct?.network_pool_ids).toBeUndefined();
      expect(direct?.network_pool_required).toBeUndefined();
      expect(direct?.network_pool_direct).toBe(true);
    } finally {
      await db
        .update(providerAccounts)
        .set({ bypassProxy: false })
        .where(eq(providerAccounts.id, accountId));
    }
  });

  test("a direct-pinned account stays direct even when a sibling account carries the pool group", async () => {
    // The two accounts share a provider and tenant, which is exactly the shape
    // `acquirePoolSlot` looks for when it inherits a pool for a candidate that
    // has none. A pooled sibling must not pull the direct account back onto a
    // proxy, so this asserts the snapshot keeps them distinguishable.
    const siblingAccountId = randomUUID();
    await db.insert(providerAccounts).values({
      id: siblingAccountId,
      providerId,
      tenantId,
      label: "pooled-sibling",
      credentialKind: "api_key",
      status: "active",
    });
    try {
      await db
        .update(providerAccounts)
        .set({ bypassProxy: true })
        .where(eq(providerAccounts.id, accountId));

      const built = await createDatabaseSnapshotBuilder(db)();
      const direct = built.candidates.find((c) => c.provider_account_id === accountId);
      const sibling = built.candidates.find((c) => c.provider_account_id === siblingAccountId);

      // Same provider and tenant, so the sibling really is the inheritance
      // source `acquirePoolSlot` would otherwise find.
      expect(sibling?.provider_id).toBe(direct?.provider_id);
      expect(sibling?.tenant_id).toBe(direct?.tenant_id);
      expect(sibling?.network_pool_ids).toEqual([activePoolId, otherActivePoolId]);
      // And the direct account refuses it explicitly rather than by omission.
      expect(direct?.network_pool_direct).toBe(true);
      expect(direct?.network_pool_ids).toBeUndefined();
    } finally {
      await db.delete(providerAccounts).where(eq(providerAccounts.id, siblingAccountId));
      await db
        .update(providerAccounts)
        .set({ bypassProxy: false })
        .where(eq(providerAccounts.id, accountId));
    }
  });
});

dbDescribe("createDatabaseSnapshotBuilder — global vs tenant routing precedence", () => {
  let db: LianRouterDatabase;
  const tenantWithOverride = randomUUID();
  const tenantWithoutOverride = randomUUID();
  const providerId = `snapshot-builder-precedence-test-${randomUUID().slice(0, 8)}`;
  const modelId = `precedence-model-${randomUUID().slice(0, 8)}`;
  const overrideAccountId = randomUUID();
  const defaultAccountId = randomUUID();
  const inheritedAccountId = randomUUID();
  const tenantPoolId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    await db
      .insert(tenants)
      .values([
        { id: tenantWithOverride, name: "precedence-test-override", status: "active" },
        { id: tenantWithoutOverride, name: "precedence-test-default", status: "active" },
      ])
      .onConflictDoNothing();
    // Global provider: every tenant may dispatch to it, so per-account tenant
    // ownership (not the provider row) decides which routing setting applies.
    await db.insert(providers).values({ id: providerId, tenantId: null, enabled: true });
    await db.insert(models).values({
      providerId,
      modelId,
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      enabled: true,
    });
    await db.insert(providerAccounts).values([
      {
        id: overrideAccountId,
        providerId,
        tenantId: tenantWithOverride,
        label: "override-account",
        credentialKind: "api_key",
        maxInflight: 2,
      },
      {
        id: inheritedAccountId,
        providerId,
        tenantId: tenantWithOverride,
        label: "inherited-account",
        credentialKind: "api_key",
      },
      {
        id: defaultAccountId,
        providerId,
        tenantId: tenantWithoutOverride,
        label: "default-account",
        credentialKind: "api_key",
      },
    ]);
    // Global fallback: bypassProxy=false, so a tenant with an active pool and
    // no tenant-specific override gets network pools attached.
    await db.insert(providerRoutingSettings).values({
      providerId,
      tenantId: null,
      strategy: "fallback",
      enabled: true,
      bypassProxy: false,
      maxInflight: 8,
    });
    // Tenant-specific settings override the global ceiling, while the account
    // value remains the most specific admission limit.
    await db.insert(providerRoutingSettings).values({
      providerId,
      tenantId: tenantWithOverride,
      strategy: "fallback",
      enabled: true,
      bypassProxy: true,
      maxInflight: 6,
    });
    await db.insert(networkPools).values({
      id: tenantPoolId,
      kind: "http",
      endpointConfig: {},
      tenantId: tenantWithoutOverride,
      status: "active",
      maxInflight: 4,
      weight: 100,
    });
  });

  afterAll(async () => {
    await db.delete(networkPools).where(eq(networkPools.id, tenantPoolId));
    await db
      .delete(providerRoutingSettings)
      .where(eq(providerRoutingSettings.providerId, providerId));
    await db
      .delete(providerAccounts)
      .where(inArray(providerAccounts.id, [overrideAccountId, inheritedAccountId, defaultAccountId]));
    await db.delete(models).where(eq(models.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(inArray(tenants.id, [tenantWithOverride, tenantWithoutOverride]));
  });

  test("a tenant-specific routing override wins over the global row for that tenant only", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();

    const overrideRouteCandidate = built.candidates.find(
      (candidate) => candidate.provider_account_id === overrideAccountId,
    );
    const inheritedRouteCandidate = built.candidates.find(
      (candidate) => candidate.provider_account_id === inheritedAccountId,
    );
    const defaultRouteCandidate = built.candidates.find(
      (candidate) => candidate.provider_account_id === defaultAccountId,
    );

    expect(overrideRouteCandidate).toBeDefined();
    expect(inheritedRouteCandidate).toBeDefined();
    expect(defaultRouteCandidate).toBeDefined();
    // Tenant-specific bypassProxy=true → no network pools attached.
    expect(overrideRouteCandidate?.network_pool_ids).toBeUndefined();
    // No tenant-specific row for this tenant → falls through to the global
    // bypassProxy=false row → its active pool is attached.
    expect(defaultRouteCandidate?.network_pool_ids).toEqual([tenantPoolId]);
    // The account limit is most specific, followed by tenant, then global.
    expect(overrideRouteCandidate?.max_inflight).toBe(2);
    expect(inheritedRouteCandidate?.max_inflight).toBe(6);
    expect(defaultRouteCandidate?.max_inflight).toBe(8);
  });
});

dbDescribe("createDatabaseSnapshotBuilder — zero-account provider eligibility", () => {
  let db: LianRouterDatabase;
  const publicProviderId = `snapshot-builder-public-${randomUUID().slice(0, 8)}`;
  const publicModelId = `public-model-${randomUUID().slice(0, 8)}`;
  const gatedProviderId = `snapshot-builder-gated-${randomUUID().slice(0, 8)}`;
  const gatedModelId = `gated-model-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = getDb();
    await db.insert(providers).values([
      { id: publicProviderId, tenantId: null, enabled: true, requiresAccount: false },
      { id: gatedProviderId, tenantId: null, enabled: true },
    ]);
    await db.insert(models).values([
      {
        providerId: publicProviderId,
        modelId: publicModelId,
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        enabled: true,
      },
      {
        providerId: gatedProviderId,
        modelId: gatedModelId,
        wireFamily: "chat",
        endpointPath: "/v1/chat/completions",
        enabled: true,
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(models)
      .where(inArray(models.providerId, [publicProviderId, gatedProviderId]));
    await db
      .delete(providers)
      .where(inArray(providers.id, [publicProviderId, gatedProviderId]));
  });

  test("requiresAccount:false provider is routable with zero provider_accounts rows", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();
    const candidate = built.candidates.find(
      (c) => c.provider_id === publicProviderId && c.model_id === publicModelId,
    );
    expect(candidate).toBeDefined();
    expect(candidate?.requires_account).toBe(false);
    expect(candidate?.provider_account_id).toBeUndefined();
    expect((candidate as { health_status?: string })?.health_status).toBeUndefined();
  });

  test("default (requiresAccount:true) provider with zero accounts stays disabled", async () => {
    const builder = createDatabaseSnapshotBuilder(db);
    const built = await builder();
    const candidate = built.candidates.find(
      (c) => c.provider_id === gatedProviderId && c.model_id === gatedModelId,
    );
    expect(candidate).toBeDefined();
    expect((candidate as { health_status?: string })?.health_status).toBe("disabled");
  });

  test("an unexpired per-model cooldown excludes the candidate, and clearing it restores routing", async () => {
    // This is the boundary the reported symptom crossed: the account read
    // `active` but `/v1` still refused to route it, while a direct probe (which
    // addresses the account by id and never consults the catalog) succeeded.
    const accountId = randomUUID();
    await db.insert(providerAccounts).values({
      id: accountId,
      providerId: gatedProviderId,
      tenantId: null,
      label: "snapshot-model-cooldown",
      credentialCiphertext: null,
      credentialKind: "api_key",
      status: "active",
      modelCooldowns: { [gatedModelId]: new Date(Date.now() + 60_000).toISOString() },
    });
    try {
      const cooling = await createDatabaseSnapshotBuilder(db)();
      const coolingCandidate = cooling.candidates.find(
        (c) => c.provider_id === gatedProviderId && c.model_id === gatedModelId,
      );
      expect((coolingCandidate as { health_status?: string })?.health_status).toBe("cooldown");

      // Recovery clears the map, so the same (account, model) pair routes again.
      await db
        .update(providerAccounts)
        .set({ modelCooldowns: {} })
        .where(eq(providerAccounts.id, accountId));
      const recovered = await createDatabaseSnapshotBuilder(db)();
      const recoveredCandidate = recovered.candidates.find(
        (c) => c.provider_id === gatedProviderId && c.model_id === gatedModelId,
      );
      expect((recoveredCandidate as { health_status?: string })?.health_status).toBeUndefined();
    } finally {
      await db.delete(providerAccounts).where(eq(providerAccounts.id, accountId));
    }
  });
});

dbDescribe("createDatabaseSnapshotBuilder — credential-less direct candidate suppression", () => {
  let db: LianRouterDatabase;
  // Three tenants, one per case the predicate has to distinguish.
  const pooledTenantId = randomUUID();
  const bareTenantId = randomUUID();
  const disabledPoolTenantId = randomUUID();
  const providerId = `snapshot-builder-public-pooled-${randomUUID().slice(0, 8)}`;
  const modelId = `public-pooled-model-${randomUUID().slice(0, 8)}`;
  const activePoolId = randomUUID();
  const disabledPoolId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    await db.insert(tenants).values([
      { id: pooledTenantId, name: "public-pooled-tenant", status: "active" },
      { id: bareTenantId, name: "public-bare-tenant", status: "active" },
      { id: disabledPoolTenantId, name: "public-disabled-pool-tenant", status: "active" },
    ]);
    // No accounts anywhere: this is the `accounts.length === 0` branch.
    await db.insert(providers).values({ id: providerId, tenantId: null, enabled: true, requiresAccount: false });
    await db.insert(models).values({
      providerId,
      modelId,
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      enabled: true,
    });
    await db.insert(networkPools).values([
      {
        id: activePoolId,
        kind: "http",
        endpointConfig: { endpoint: "https://public-proxy.example:443" },
        tenantId: pooledTenantId,
        status: "active",
        maxInflight: 6,
      },
      {
        id: disabledPoolId,
        kind: "http",
        endpointConfig: { endpoint: "https://public-proxy-disabled.example:443" },
        tenantId: disabledPoolTenantId,
        status: "disabled",
        maxInflight: 6,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(networkPools).where(inArray(networkPools.id, [activePoolId, disabledPoolId]));
    await db.delete(models).where(eq(models.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(inArray(tenants.id, [pooledTenantId, bareTenantId, disabledPoolTenantId]));
  });

  const candidatesFor = async (tenantId: string | undefined) =>
    (await createDatabaseSnapshotBuilder(db, tenantId)()).candidates.filter(
      (c) => c.provider_id === providerId && c.model_id === modelId,
    );

  test("a tenant with an active pool gets only pooled candidates — no direct fallback", async () => {
    const candidates = await candidatesFor(pooledTenantId);

    // The pooled candidate is the whole plan: an unpooled candidate beside it
    // is what let a saturated/cooldown pool fall through to the host address.
    expect(candidates.map((c) => c.tenant_id)).toEqual([pooledTenantId]);
    expect(candidates.some((c) => c.tenant_id === null)).toBe(false);
    expect(candidates.every((c) => (c.network_pool_ids?.length ?? 0) > 0)).toBe(true);
    expect(candidates[0]?.network_pool_ids).toEqual([activePoolId]);
    expect(candidates[0]?.network_pool_required).toBe(true);
  });

  test("a tenant with zero pools still gets the direct candidate", async () => {
    const candidates = await candidatesFor(bareTenantId);

    // Without this the tenant loses the free provider entirely.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.tenant_id).toBeNull();
    expect(candidates[0]?.network_pool_ids).toBeUndefined();
    expect(candidates[0]?.requires_account).toBe(false);
  });

  test("a tenant whose pools exist but are all disabled still gets the direct candidate", async () => {
    // The regression the `activePoolsByTenant` predicate protects:
    // `resolveNetworkPools` also answers `undefined` here, so suppressing on
    // it would delete the only candidate and turn a working direct dial into
    // a 503.
    const candidates = await candidatesFor(disabledPoolTenantId);

    // The direct candidate is still emitted. (The tenant's own placeholder
    // candidate is emitted too, with an empty eligible set, so a route that
    // requires a pool fails closed instead of dialing — unchanged behavior.)
    const direct = candidates.filter((c) => c.tenant_id === null);
    expect(direct).toHaveLength(1);
    expect(direct[0]?.network_pool_ids).toBeUndefined();
    expect(direct[0]?.requires_account).toBe(false);
  });

  test("a tenant with active pools that bypasses the proxy still gets the direct candidate", async () => {
    // `bypassProxy` means no pooled candidate is emitted for this tenant, so
    // suppressing the direct one would leave the provider with no route at
    // all. The suppression predicate has to read the same two facts the pooled
    // emission does: active pools *and* no bypass.
    await db.insert(providerRoutingSettings).values({
      providerId,
      tenantId: pooledTenantId,
      strategy: "fallback",
      enabled: true,
      bypassProxy: true,
    });
    try {
      const candidates = await candidatesFor(pooledTenantId);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.tenant_id).toBeNull();
      expect(candidates[0]?.network_pool_ids).toBeUndefined();
      expect(candidates[0]?.requires_account).toBe(false);
    } finally {
      await db.delete(providerRoutingSettings).where(eq(providerRoutingSettings.providerId, providerId));
    }
  });

  test("the global build keeps both the pooled candidate and the unpooled fallback", async () => {
    const candidates = await candidatesFor(undefined);

    // There is no requesting tenant, so every pooled candidate is emitted and
    // the unpooled one stays for tenants that own no pool. Dispatch refuses it
    // when the plan also carries a pooled sibling.
    expect(candidates.some((c) => c.tenant_id === pooledTenantId)).toBe(true);
    expect(candidates.some((c) => c.tenant_id === null && c.network_pool_ids === undefined)).toBe(true);
  });
});
