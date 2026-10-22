// Drizzle-backed persistence for provider routing (detail) settings.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { LianRouterDatabase } from "../../../persistence/postgres";
import { providerRoutingSettings } from "../../../persistence/schema";
import { resolveTenantOverride } from "../../../persistence/tenant-scope";
import { DEFAULT_PROXY_BYPASS_PROVIDER_IDS } from "../../../providers/provider-registry";
import { normalizeSystemPrompt } from "../catalog/contracts";
import type { ProviderRoutingResponse, UpdateProviderRoutingRequest } from "../catalog/contracts";
import type { ProviderDetailStore } from "./contracts";
function mapRow(row: typeof providerRoutingSettings.$inferSelect): ProviderRoutingResponse {
  return {
    providerId: row.providerId,
    tenantId: row.tenantId,
    strategy: row.strategy as ProviderRoutingResponse["strategy"],
    rotateCount: row.rotateCount ?? 1,
    maxInflight: row.maxInflight,
    enabled: row.enabled,
    bypassProxy: row.bypassProxy,
    systemPrompt: row.systemPrompt,
  };
}

function tenantWhere(providerId: string, tenantId: string | null) {
  return tenantId === null
    ? and(
        eq(providerRoutingSettings.providerId, providerId),
        isNull(providerRoutingSettings.tenantId),
      )
    : and(
        eq(providerRoutingSettings.providerId, providerId),
        eq(providerRoutingSettings.tenantId, tenantId),
      );
}

export class DrizzleProviderDetailStore implements ProviderDetailStore {
  constructor(private readonly db: LianRouterDatabase) {}

  async getRouting(providerId: string, tenantId: string | null): Promise<ProviderRoutingResponse> {
    let specificRow: typeof providerRoutingSettings.$inferSelect | undefined;
    if (tenantId !== null) {
      const specific = await this.db
        .select()
        .from(providerRoutingSettings)
        .where(tenantWhere(providerId, tenantId))
        .limit(1);
      specificRow = specific[0];
    }
    const global = await this.db
      .select()
      .from(providerRoutingSettings)
      .where(tenantWhere(providerId, null))
      .limit(1);
    const globalRow = global[0];
    // Same tenant-wins-entirely-over-global precedence `resolveTenantOverride`
    // row picks which source to read `tenantId` from below.
    const resolvedRow = resolveTenantOverride(specificRow, globalRow, undefined);
    if (resolvedRow) {
      const mapped = mapRow(resolvedRow);
      // The prompt is chained per field across the tenant and global rows, not
      // resolved whole-row like the other settings: a tenant row created by
      // editing an unrelated routing setting carries NULL, and whole-row
      // precedence would let it blank a prompt the operator set globally.
      // Mirrors `resolveSystemPrompt` in `transport/routing/route-catalog.ts`,
      // so the panel and the dispatch decision cannot disagree.
      const systemPrompt = resolveTenantOverride(
        specificRow?.systemPrompt,
        globalRow?.systemPrompt,
        null,
      );
      return specificRow ? { ...mapped, systemPrompt } : { ...mapped, systemPrompt, tenantId };
    }
    return {
      providerId,
      tenantId,
      strategy: "fallback",
      rotateCount: 1,
      maxInflight: null,
      enabled: false,
      bypassProxy: DEFAULT_PROXY_BYPASS_PROVIDER_IDS.has(providerId),
      systemPrompt: null,
    };
  }

  async updateRouting(
    providerId: string,
    tenantId: string | null,
    patch: UpdateProviderRoutingRequest,
  ): Promise<ProviderRoutingResponse> {
    // Atomic upsert avoids the select→insert/update race that surfaces as
    // `23505 unique_violation` when two admins configure routing for the
    // same (tenant, provider) pair concurrently.
    // `null` clears the prompt; a trimmed empty string does too, so the field
    // behaves like "delete this hint" rather than storing a blank system
    // message. Normalized once because the INSERT arm stores this value
    // directly — an untrimmed patch would otherwise persist untrimmed.
    const systemPrompt =
      patch.systemPrompt === undefined ? undefined : normalizeSystemPrompt(patch.systemPrompt);
    const values = {
      providerId,
      tenantId: tenantId ?? null,
      strategy: patch.strategy ?? "fallback",
      rotateCount: patch.rotateCount ?? 1,
      maxInflight: patch.maxInflight ?? null,
      enabled: patch.enabled ?? false,
      bypassProxy: patch.bypassProxy ?? DEFAULT_PROXY_BYPASS_PROVIDER_IDS.has(providerId),
      systemPrompt: systemPrompt ?? null,
    };
    const setClause: Record<string, unknown> = {};
    if (patch.strategy !== undefined) setClause.strategy = patch.strategy;
    if (patch.rotateCount !== undefined) setClause.rotateCount = patch.rotateCount;
    if (patch.maxInflight !== undefined) setClause.maxInflight = patch.maxInflight;
    if (patch.enabled !== undefined) setClause.enabled = patch.enabled;
    if (patch.bypassProxy !== undefined) setClause.bypassProxy = patch.bypassProxy;
    if (systemPrompt !== undefined) setClause.systemPrompt = systemPrompt;
    const upserted = await this.db
      .insert(providerRoutingSettings)
      .values(values)
      .onConflictDoUpdate({
        // The global row is guarded by a *partial* unique index
        // (`provider_routing_settings_global_provider_idx`, `WHERE tenant_id IS
        // NULL`), so the conflict target must name that predicate. Without
        // `targetWhere`, Postgres cannot match `(provider_id)` to the partial
        // index and rejects the statement with `42P10` — the global branch
        // failed on every write. The tenant branch's index is not partial, so it
        // needs no predicate.
        target:
          tenantId === null
            ? [providerRoutingSettings.providerId]
            : [providerRoutingSettings.tenantId, providerRoutingSettings.providerId],
        ...(tenantId === null
          ? { targetWhere: sql`tenant_id IS NULL` }
          : {}),
        set:
          Object.keys(setClause).length > 0
            ? setClause
            : // Deterministic no-op update so ON CONFLICT still returns the row.
              { providerId: providerRoutingSettings.providerId },
      })
      .returning();
    return mapRow(upserted[0]!);
  }
}

