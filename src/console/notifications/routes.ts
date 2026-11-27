import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Elysia } from "elysia";
import { providerAccounts, providers } from "../../persistence/schema";
import type { AccountQuotaRoutesDeps } from "../quota/account-quota-shared";
import { requireScope } from "../shared/errors";
import { ProviderNotificationService } from "./service";

/** Reuses the quota domain's refresh-aware credentials and authenticated error boundary. */
export function registerProviderNotificationRoutes(app: Elysia, deps: AccountQuotaRoutesDeps): void {
  const service = new ProviderNotificationService({
    redis: deps.redis,
    resolveCredential: deps.resolveCredential,
  });
  app.get("/notifications", async ({ request, set }) => {
    const access = requireScope(deps.accessResolver(request), "dashboard:read");
    const platformAdmin = access.scopes.includes("platform:admin");
    if (!platformAdmin && access.tenantId === null) {
      set.status = 403;
      return { error: "Tenant isolation required", code: "tenant_required" };
    }
    const rows = await deps.db.select({
      id: providerAccounts.id,
      providerId: providerAccounts.providerId,
      label: providerAccounts.label,
    }).from(providerAccounts).innerJoin(providers, eq(providers.id, providerAccounts.providerId)).where(and(
      inArray(providerAccounts.providerId, ["autoclaw", "cbcn", "zcode"]),
      ne(providerAccounts.status, "disabled"),
      eq(providers.enabled, true),
      ...(platformAdmin ? [] : [
        or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, access.tenantId!)),
        or(isNull(providers.tenantId), eq(providers.tenantId, access.tenantId!)),
      ]),
    ));
    set.headers["cache-control"] = "no-store";
    return service.snapshot(rows);
  });
}
