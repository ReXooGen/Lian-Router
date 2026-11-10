// Shared outbound-egress resolver for console features that make provider
// calls outside the data plane (model probes, generation). The proxy switch,
// pool admission, and fail-closed saturation rule must not be reimplemented
// per surface.
import { and, eq, isNull, or } from "drizzle-orm";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { networkPools, providerRoutingSettings } from "../../persistence/schema";
import { resolveTenantOverride } from "../../persistence/tenant-scope";
import { DEFAULT_PROXY_BYPASS_PROVIDER_IDS } from "../../providers/provider-registry";
import type { ProbeOutboundBinding, ProbeOutboundResolver } from "../../providers/discovery/probing-service";
import type { NetworkPoolSelector } from "../../network/pool/selector";
import type { ValidatedNetworkBindingFactory } from "../../network/pool/resolver";
import { ConsoleDomainError } from "../shared/errors";

export interface ProviderOutboundResolverDeps {
  readonly db: LianRouterDatabase;
  readonly poolSelector: NetworkPoolSelector;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
}

/**
 * Resolves the egress one console-issued provider call must use.
 *
 * Honors the provider's `bypass_proxy` setting (tenant override, then global,
 * then the bundled default) and otherwise acquires a tenant pool slot with the
 * same weighted admission the data plane uses. Every pool being saturated or
 * cooling is a 503, never a silent direct dial: the operator configured the
 * pool, and bypassing it would spend the gateway's own address.
 */
export function createProviderOutboundResolver(
  deps: ProviderOutboundResolverDeps,
): ProbeOutboundResolver {
  const { db, poolSelector, networkBindingFactory } = deps;
  return async (tenantId: string, providerId?: string): Promise<ProbeOutboundBinding> => {
    let bypass = false;
    if (providerId) {
      const rows = await db
        .select({
          tenantId: providerRoutingSettings.tenantId,
          bypassProxy: providerRoutingSettings.bypassProxy,
        })
        .from(providerRoutingSettings)
        .where(
          and(
            eq(providerRoutingSettings.providerId, providerId),
            or(
              eq(providerRoutingSettings.tenantId, tenantId),
              isNull(providerRoutingSettings.tenantId),
            ),
          ),
        );
      const tenantSetting = rows.find((row) => row.tenantId === tenantId)?.bypassProxy;
      const globalSetting = rows.find((row) => row.tenantId === null)?.bypassProxy;
      bypass = resolveTenantOverride(
        tenantSetting,
        globalSetting,
        DEFAULT_PROXY_BYPASS_PROVIDER_IDS.has(providerId),
      );
    }

    if (!bypass) {
      const activePools = await db
        .select({
          id: networkPools.id,
          maxInflight: networkPools.maxInflight,
          weight: networkPools.weight,
        })
        .from(networkPools)
        .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.status, "active")));

      if (activePools.length > 0) {
        const limits: Record<string, number> = {};
        const weights: Record<string, number> = {};
        for (const pool of activePools) {
          limits[pool.id] = pool.maxInflight ?? 10;
          weights[pool.id] = pool.weight ?? 100;
        }
        const slot = await poolSelector.tryAcquireAvailablePool(
          activePools.map((pool) => pool.id),
          providerId ?? "default",
          limits,
          weights,
        );
        if (slot) {
          return {
            fetch: networkBindingFactory.fetch(slot.poolId, tenantId),
            networkPoolId: slot.poolId,
            release: slot.release,
          };
        }
        throw new ConsoleDomainError(
          "pool_unavailable",
          503,
          `All network pools are saturated for provider ${providerId ?? "default"}`,
        );
      }
    }

    return { fetch: networkBindingFactory.fetch(undefined, tenantId) };
  };
}
