import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { providerAccounts, providers } from "../../../src/persistence/schema";
import { createProviderProbingServiceForTests } from "../../../src/providers/discovery/probing-service";
import { encryptCredential } from "../../../src/security/crypto";
import { dbDescribe } from "../../helpers/db-gate";

/**
 * Account selection for the provider-wide probe. The concurrency bound is
 * covered by the unit test beside the service; this suite covers the SQL that
 * decides which accounts are worth an upstream turn at all.
 */
dbDescribe("probeAllAccounts account selection", () => {
  const providerId = `probe-select-${randomUUID().slice(0, 8)}`;
  const activeId = randomUUID();
  const cooldownId = randomUUID();
  const disabledId = randomUUID();
  let db: LianRouterDatabase;

  beforeAll(async () => {
    db = getDb();
    await db.insert(providers).values({ id: providerId, requiresAccount: true });
    await db.insert(providerAccounts).values([
      {
        id: activeId, providerId, label: "active", status: "active",
        credentialKind: "oauth", credentialCiphertext: encryptCredential("token-active"),
      },
      {
        id: cooldownId, providerId, label: "cooling down", status: "cooldown",
        credentialKind: "oauth", cooldownUntil: new Date(Date.now() + 60 * 60 * 1000),
        credentialCiphertext: encryptCredential("token-cooldown"),
      },
      {
        id: disabledId, providerId, label: "disabled", status: "disabled",
        credentialKind: "oauth", credentialCiphertext: encryptCredential("token-disabled"),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(providers).where(eq(providers.id, providerId));
  });

  test("probes cooldown accounts and skips disabled ones", async () => {
    const probing = createProviderProbingServiceForTests({ db });
    const probed: string[] = [];
    probing.probeModel = async (_tenantId, _providerId, request) => {
      probed.push(request.accountId ?? "");
      return { ok: true, latencyMs: 1, httpStatus: 200 };
    };

    const result = await probing.probeAllAccounts(randomUUID(), providerId, { modelId: "gpt-test" });

    expect([...probed].sort()).toEqual([activeId, cooldownId].sort());
    expect(result.results.map((entry) => entry.accountId).sort()).toEqual(
      [activeId, cooldownId].sort(),
    );
  });
});
