import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { providerAccounts, tenants } from "../../../src/persistence/schema";
import type { RedisClient } from "../../../src/persistence/redis";
import { createAccountQuotaRoutes } from "../../../src/console/quota/account-quota";
import { createDefaultProviderRegistry } from "../../../src/providers/default-registry";
import type { AccessDecision } from "../../../src/security/access-control";
import type { ProviderNotificationsResponse } from "../../../src/console/notifications/contracts";
import { dbDescribe } from "../../helpers/db-gate";

const tenantA = randomUUID();
const tenantB = randomUUID();
const ownedA = randomUUID();
const ownedB = randomUUID();
const shared = randomUUID();
const disabled = randomUUID();
let db: LianRouterDatabase;
let access: AccessDecision | undefined;
let app: ReturnType<typeof createAccountQuotaRoutes>;

function decision(tenantId: string | null, scopes: AccessDecision["scopes"] = ["dashboard:read"]): AccessDecision {
  return { id: "notification-reader", tenantId, scopes, admissionIdentity: "notification-test" };
}

async function read(): Promise<{ status: number; body: ProviderNotificationsResponse }> {
  const response = await app.handle(new Request("http://localhost/notifications"));
  return { status: response.status, body: await response.json() as ProviderNotificationsResponse };
}

dbDescribe("provider notification authorization", () => {
  beforeAll(async () => {
    db = getDb();
    await db.insert(tenants).values([
      { id: tenantA, name: "notifications-a", status: "active" },
      { id: tenantB, name: "notifications-b", status: "active" },
    ]);
    await db.insert(providerAccounts).values([
      { id: ownedA, providerId: "cbcn", tenantId: tenantA, label: "notice-owned-a", credentialKind: "none", status: "active" },
      { id: ownedB, providerId: "cbcn", tenantId: tenantB, label: "notice-owned-b", credentialKind: "none", status: "active" },
      { id: shared, providerId: "cbcn", tenantId: null, label: "notice-shared", credentialKind: "none", status: "active" },
      { id: disabled, providerId: "cbcn", tenantId: tenantA, label: "notice-disabled", credentialKind: "none", status: "disabled" },
    ]);
    const values = new Map<string, string>();
    const redis = {
      async get(key: string) { return values.get(key) ?? null; },
      async set(key: string, value: string) { values.set(key, value); return "OK"; },
      async del(key: string) { return Number(values.delete(key)); },
    } as unknown as RedisClient;
    app = createAccountQuotaRoutes({ db, redis, providerRegistry: createDefaultProviderRegistry(), accessResolver: () => access, resolveCredential: async () => "" });
  });

  afterAll(async () => {
    await db.delete(providerAccounts).where(inArray(providerAccounts.id, [ownedA, ownedB, shared, disabled]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  });

  test("requires authentication and dashboard read scope", async () => {
    access = undefined;
    expect((await read()).status).toBe(401);
    access = decision(tenantA, ["routing:invoke"]);
    expect((await read()).status).toBe(403);
  });

  test("tenant reads only its accounts and shared accounts, never another tenant or disabled account", async () => {
    access = decision(tenantA);
    const result = await read();
    expect(result.status).toBe(200);
    const ids = result.body.items.map(item => item.accountId);
    expect(ids).toContain(ownedA);
    expect(ids).toContain(shared);
    expect(ids).not.toContain(ownedB);
    expect(ids).not.toContain(disabled);
    expect(JSON.stringify(result.body)).not.toContain("credential");
  });

  test("a platform admin can see both tenants, while an unbound non-admin is rejected", async () => {
    access = decision(null, ["dashboard:read", "platform:admin"]);
    const result = await read();
    expect(result.status).toBe(200);
    expect(result.body.items.map(item => item.accountId)).toContain(ownedA);
    expect(result.body.items.map(item => item.accountId)).toContain(ownedB);
    access = decision(null);
    expect((await read()).status).toBe(403);
  });
});
