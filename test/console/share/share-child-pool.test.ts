import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { DrizzleApiKeyStore, type ApiKeyRecord } from "../../../src/persistence/api-key-store";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { DrizzleShareLinkStore, hashShareToken } from "../../../src/persistence/share-store";
import { networkPools, tenants } from "../../../src/persistence/schema";
import { canonicalClientIpKey } from "../../../src/security/ip-boundary";
import { dbDescribe } from "../../helpers/db-gate";

/**
 * A share template's egress binding is copied onto every child it mints.
 *
 * The copy is deliberate rather than a parent lookup at request time: an issued
 * child must keep the egress it was minted with, so revoking or re-pointing the
 * template cannot retroactively move a live credential to a different address.
 */
dbDescribe("shared API-key egress inheritance", () => {
  const tenantId = randomUUID();
  const parentId = randomUUID();
  const otherParentId = randomUUID();
  const poolId = randomUUID();
  const token = randomUUID() + randomUUID();
  const otherToken = randomUUID() + randomUUID();
  // Two distinct client IPs: the partial unique index allows one active child
  // per canonical IP *globally*, so a second enrollment from the same address
  // is an `ip_limit` regardless of template.
  const ipNumber = Number.parseInt(tenantId.replaceAll("-", "").slice(0, 8), 16);
  const clientIpFor = (hostOffset: number): string =>
    [
      (ipNumber >>> 24) & 255,
      (ipNumber >>> 16) & 255,
      (ipNumber >>> 8) & 255,
      (ipNumber + hostOffset) & 255,
    ].join(".");
  const pooledClientIp = clientIpFor(1);
  const pooledClientIpKey = canonicalClientIpKey(pooledClientIp);
  const unboundClientIp = clientIpFor(2);
  const unboundClientIpKey = canonicalClientIpKey(unboundClientIp);
  let db: LianRouterDatabase;
  let apiKeys: DrizzleApiKeyStore;
  let shares: DrizzleShareLinkStore;

  beforeAll(async () => {
    if (!pooledClientIpKey || !unboundClientIpKey)
      throw new Error("test IP did not canonicalize");
    db = getDb();
    apiKeys = new DrizzleApiKeyStore(db);
    shares = new DrizzleShareLinkStore(db);
    await db.insert(tenants).values({
      id: tenantId,
      name: `shared-pool-test-${tenantId}`,
      status: "active",
    });
    await db.insert(networkPools).values({
      id: poolId,
      tenantId,
      kind: "http",
      endpointConfig: { endpoint: "http://proxy.example.com:8080" },
      maxInflight: 8,
      weight: 100,
      status: "active",
    });
    const template = (id: string, networkPoolId: string | undefined): ApiKeyRecord => ({
      id,
      tenantId,
      keyHash: null,
      keyMode: "share",
      label: `template-${id.slice(0, 8)}`,
      scopes: ["routing:invoke"],
      keyPrefix: "rk_",
      ...(networkPoolId === undefined ? {} : { networkPoolId }),
      createdAt: new Date(),
      tokensConsumed: 0,
    });
    await apiKeys.create(template(parentId, poolId));
    await apiKeys.create(template(otherParentId, undefined));
    await shares.create({
      apiKeyId: parentId,
      tokenHash: hashShareToken(token),
      expiresAt: null,
    });
    await shares.create({
      apiKeyId: otherParentId,
      tokenHash: hashShareToken(otherToken),
      expiresAt: null,
    });
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await db.delete(networkPools).where(inArray(networkPools.id, [poolId]));
  });

  test("a child minted through enrollment carries the template's pool", async () => {
    if (!pooledClientIpKey) throw new Error("test IP did not canonicalize");
    const issued = await shares.issueSharedApiKey(hashShareToken(token), {
      keyHash: createHash("sha256").update("pooled-child").digest("hex"),
      keyPrefix: "rk_",
      clientIp: pooledClientIp,
      clientIpKey: pooledClientIpKey,
      keyEncrypted: Buffer.from("pooled-child"),
      deviceKey: "device-pooled",
    });
    if (issued.kind !== "issued") throw new Error(`expected issued child, got ${issued.kind}`);

    const children = await apiKeys.listChildren(tenantId, parentId);
    expect(children).toHaveLength(1);
    expect(children[0]?.id).toBe(issued.apiKeyId);
    expect(children[0]?.networkPoolId).toBe(poolId);

    // Re-pointing the template afterwards must not move the issued child.
    const rePointed = await apiKeys.update(tenantId, parentId, { networkPoolId: null });
    expect(rePointed?.networkPoolId).toBeUndefined();
    const after = await apiKeys.listChildren(tenantId, parentId);
    expect(after[0]?.networkPoolId).toBe(poolId);
  });

  test("a child of an unbound template carries no pool", async () => {
    if (!unboundClientIpKey) throw new Error("test IP did not canonicalize");
    const issued = await shares.issueSharedApiKey(hashShareToken(otherToken), {
      keyHash: createHash("sha256").update("unbound-child").digest("hex"),
      keyPrefix: "rk_",
      clientIp: unboundClientIp,
      clientIpKey: unboundClientIpKey,
      keyEncrypted: Buffer.from("unbound-child"),
      deviceKey: "device-unbound",
    });
    if (issued.kind !== "issued") throw new Error(`expected issued child, got ${issued.kind}`);
    const children = await apiKeys.listChildren(tenantId, otherParentId);
    expect(children[0]?.networkPoolId).toBeUndefined();
  });
});
