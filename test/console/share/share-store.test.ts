import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DrizzleApiKeyStore, type ApiKeyRecord } from "../../../src/persistence/api-key-store";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { DrizzleShareLinkStore, hashShareToken } from "../../../src/persistence/share-store";
import { tenants } from "../../../src/persistence/schema";
import { canonicalClientIpKey } from "../../../src/security/ip-boundary";
import { dbDescribe } from "../../helpers/db-gate";

dbDescribe("shared API-key persistence", () => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const parentIds = [randomUUID(), randomUUID()] as const;
  const tokens = [randomUUID() + randomUUID(), randomUUID() + randomUUID()] as const;
  const scopedParentIds = [randomUUID(), randomUUID()] as const;
  const scopedTokens = [randomUUID() + randomUUID(), randomUUID() + randomUUID()] as const;
  const tokenAt = (index: number): string => {
    const token = index < 2 ? tokens[index] : scopedTokens[index - 2];
    if (token === undefined) throw new Error("missing test enrollment token");
    return token;
  };
  const ipNumber = Number.parseInt(tenantId.replaceAll("-", "").slice(0, 8), 16);
  const clientIp = [
    (ipNumber >>> 24) & 255,
    (ipNumber >>> 16) & 255,
    (ipNumber >>> 8) & 255,
    ipNumber & 255,
  ].join(".");
  const clientIpKey = canonicalClientIpKey(clientIp);
  let db: LianRouterDatabase;
  let apiKeys: DrizzleApiKeyStore;
  let shares: DrizzleShareLinkStore;

  beforeAll(async () => {
    if (!clientIpKey) throw new Error("test IP did not canonicalize");
    db = getDb();
    apiKeys = new DrizzleApiKeyStore(db);
    shares = new DrizzleShareLinkStore(db);
    await db.insert(tenants).values([
      {
        id: tenantId,
        name: `shared-key-test-${tenantId}`,
        status: "active",
      },
      {
        id: otherTenantId,
        name: `shared-key-test-${otherTenantId}`,
        status: "active",
      },
    ]);
    for (const [index, id] of parentIds.entries()) {
      const parent: ApiKeyRecord = {
        id,
        tenantId: index === 0 ? tenantId : otherTenantId,
        keyHash: null,
        keyMode: "share",
        label: `template-${index}`,
        scopes: ["routing:invoke"],
        keyPrefix: "rk_",
        createdAt: new Date(),
        tokensConsumed: 0,
      };
      await apiKeys.create(parent);
      await shares.create({
        apiKeyId: id,
        tokenHash: hashShareToken(tokenAt(index)),
        expiresAt: null,
      });
    }
    // The race test revokes and converts both templates above, so the scoping
    // test gets its own pair rather than depending on their end state.
    for (const [index, id] of scopedParentIds.entries()) {
      await apiKeys.create({
        id,
        tenantId,
        keyHash: null,
        keyMode: "share",
        label: `scoped-template-${index}`,
        scopes: ["routing:invoke"],
        keyPrefix: "rk_",
        createdAt: new Date(),
        tokensConsumed: 0,
      });
      await shares.create({
        apiKeyId: id,
        tokenHash: hashShareToken(tokenAt(index + 2)),
        expiresAt: null,
      });
    }
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    await db.delete(tenants).where(eq(tenants.id, otherTenantId));
  });

  test("one canonical IP races globally and parent revoke/conversion releases it", async () => {
    if (!clientIpKey) throw new Error("test IP did not canonicalize");
    const attempts = await Promise.all(
      tokens.map((token, index) =>
        shares.issueSharedApiKey(hashShareToken(token), {
          keyHash: createHash("sha256").update(`shared-child-${index}-initial`).digest("hex"),
          keyPrefix: "rk_",
          clientIp,
          clientIpKey,
          keyEncrypted: Buffer.from(`child-${index}-initial`),
          deviceKey: `device-${index}`,
        }),
      ),
    );
    const issued = attempts.find((result) => result.kind === "issued");
    expect(attempts.filter((result) => result.kind === "issued")).toHaveLength(1);
    expect(attempts.filter((result) => result.kind === "ip_limit")).toHaveLength(1);
    if (!issued || issued.kind !== "issued") throw new Error("expected one issued child key");

    expect(await shares.getActiveSharedKeyForIp(clientIpKey)).not.toBeNull();
    const issuedTenantId = issued.parentKeyId === parentIds[0] ? tenantId : otherTenantId;
    expect(await apiKeys.revoke(issuedTenantId, issued.parentKeyId, new Date())).toBe(true);
    const revokedChildren = await apiKeys.listChildren(issuedTenantId, issued.parentKeyId);
    expect(revokedChildren).toHaveLength(1);
    expect(revokedChildren[0]?.revokedAt).toBeInstanceOf(Date);
    expect(await shares.getActiveSharedKeyForIp(clientIpKey)).toBeNull();

    const remainingIndex = issued.parentKeyId === parentIds[0] ? 1 : 0;
    const retried = await shares.issueSharedApiKey(
      hashShareToken(tokenAt(remainingIndex)),
      {
        keyHash: createHash("sha256").update("shared-child-after-parent-revoke").digest("hex"),
        keyPrefix: "rk_",
        clientIp,
        clientIpKey,
        keyEncrypted: Buffer.from("shared-child-after-parent-revoke"),
        deviceKey: "device-retry",
      },
    );
    expect(retried.kind).toBe("issued");
    expect(await shares.getActiveSharedKeyForIp(clientIpKey)).not.toBeNull();
    if (retried.kind !== "issued") throw new Error("expected enrollment after parent revoke");
    const retriedTenantId = remainingIndex === 0 ? tenantId : otherTenantId;
    const converted = await apiKeys.update(retriedTenantId, retried.parentKeyId, {
      keyMode: "personal",
      keyHash: createHash("sha256").update("converted-personal-key").digest("hex"),
      keyEncrypted: null,
      keyPrefix: "rk_",
    });
    expect(converted?.keyMode).toBe("personal");
    const convertedChildren = await apiKeys.listChildren(retriedTenantId, retried.parentKeyId);
    expect(convertedChildren).toHaveLength(1);
    expect(convertedChildren[0]?.revokedAt).toBeInstanceOf(Date);
    expect((await shares.listForApiKey(retried.parentKeyId))[0]?.active).toBe(false);
    expect(await shares.getActiveSharedKeyForIp(clientIpKey)).toBeNull();
  });

  test("a child issued from one template does not block another template's page", async () => {
    if (!clientIpKey) throw new Error("test IP did not canonicalize");
    // Issue against this test's own second template, so it does not depend on
    // the state the race test above left behind.
    const secondParent = scopedParentIds[1];
    if (!secondParent) throw new Error("expected a second parent template");
    const first = await shares.issueSharedApiKey(hashShareToken(tokenAt(3)), {
      keyHash: createHash("sha256").update("scoped-child-one").digest("hex"),
      keyPrefix: "rk_",
      clientIp,
      clientIpKey,
      keyEncrypted: Buffer.from("scoped-child-one"),
      deviceKey: "device-scoped",
    });
    expect(first.kind).toBe("issued");
    if (first.kind !== "issued") throw new Error("expected an issued child key");
    expect(first.parentKeyId).toBe(secondParent);

    // The global answer is still yes — the index is global on purpose.
    expect(await shares.getActiveSharedKeyForIp(clientIpKey)).not.toBeNull();

    // But the *other* template's page must not claim this IP already enrolled
    // there: the visitor holds no key from it and could never get one.
    const otherParent = scopedParentIds[0];
    if (!otherParent) throw new Error("expected a second parent template");
    expect(await shares.getActiveSharedKeyForIp(clientIpKey, otherParent)).toBeNull();
    // Its own template still reports the truth.
    expect(await shares.getActiveSharedKeyForIp(clientIpKey, secondParent)).toMatchObject({
      id: first.apiKeyId,
      tenantId,
      recoverable: true,
    });
  });

  test("reveal returns the stored ciphertext only for the matching device and IP", async () => {
    if (!clientIpKey) throw new Error("test IP did not canonicalize");
    // The scoped test above leaves its child active, and the partial unique
    // index is global: revoke that child's parent first so this test's issue
    // does not trip the one-active-child-per-IP limit.
    const previousParent = scopedParentIds[1];
    if (!previousParent) throw new Error("expected a previous scoped parent template");
    expect(await apiKeys.revoke(tenantId, previousParent, new Date())).toBe(true);
    const parent = scopedParentIds[0];
    if (!parent) throw new Error("expected a scoped parent template");
    const plaintext = "rk_reveal-test-secret";
    const issued = await shares.issueSharedApiKey(hashShareToken(tokenAt(2)), {
      keyHash: createHash("sha256").update("reveal-child").digest("hex"),
      keyPrefix: "rk_",
      clientIp,
      clientIpKey,
      keyEncrypted: Buffer.from(plaintext),
      deviceKey: "device-reveal",
    });
    if (issued.kind !== "issued") throw new Error(`expected issued child, got ${issued.kind}`);

    // Matching device recovers exactly the stored bytes.
    expect(await shares.revealSharedKeyForDevice(hashShareToken(tokenAt(2)), clientIpKey, "device-reveal"))
      .toMatchObject({ ciphertext: Buffer.from(plaintext) });
    // A different device id on the same IP reveals nothing.
    expect(await shares.revealSharedKeyForDevice(hashShareToken(tokenAt(2)), clientIpKey, "device-other")).toBeNull();
    // A different IP with the right device reveals nothing.
    expect(await shares.revealSharedKeyForDevice(hashShareToken(tokenAt(2)), "v4:0", "device-reveal")).toBeNull();
    // A different link token reveals nothing even with a full match elsewhere.
    expect(await shares.revealSharedKeyForDevice(hashShareToken(tokenAt(3)), clientIpKey, "device-reveal")).toBeNull();
  });
});
