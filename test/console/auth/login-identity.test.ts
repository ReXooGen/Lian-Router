/**
 * Login identity is case-insensitive; the lockout bucket is case-folded.
 *
 * Production defect this file pins: the login route lowercased the submitted
 * username and then looked it up with a case-sensitive `eq`, so the stored row
 * `Liaan` was unreachable and every attempt recorded `unknown_user` before the
 * password was ever verified. The lowercasing itself is load-bearing for the
 * lockout key — dropping it would let an attacker reset the failure counter by
 * changing capitalization — so the two concerns are tested separately here.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import {
  adminAuditLog,
  consoleLockouts,
  consoleSessions,
  consoleUsers,
  tenants,
} from "../../../src/persistence/schema";
import { createConsoleAuthRoutes } from "../../../src/console/auth/session";
import {
  ConsoleCredentialService,
  ConsoleLockoutService,
  ConsoleSessionService,
  defaultSessionCookiePolicy,
  type FirstBootSetupService,
} from "../../../src/console/auth/service";

const PASSWORD = "correct-horse-battery-staple";

dbDescribe("console login identity", () => {
  let db: LianRouterDatabase;
  let credentialService: ConsoleCredentialService;
  let sessionService: ConsoleSessionService;
  let lockoutService: ConsoleLockoutService;
  const setupService = {} as FirstBootSetupService;
  const createdUserIds: string[] = [];
  const createdTenantIds: string[] = [];
  const usedLockoutKeys: string[] = [];

  beforeAll(() => {
    db = getDb();
    credentialService = new ConsoleCredentialService();
    sessionService = new ConsoleSessionService(db, {
      ...defaultSessionCookiePolicy,
      secure: false,
    });
    lockoutService = new ConsoleLockoutService(db);
  });

  afterAll(async () => {
    for (const key of usedLockoutKeys.splice(0)) {
      await db.delete(consoleLockouts).where(eq(consoleLockouts.ip, key));
      await db.delete(adminAuditLog).where(eq(adminAuditLog.target, `ip:${key}`));
    }
    for (const userId of createdUserIds.splice(0)) {
      await db.delete(consoleSessions).where(eq(consoleSessions.userId, userId));
      await db.delete(adminAuditLog).where(eq(adminAuditLog.actor, userId));
      await db.delete(consoleUsers).where(eq(consoleUsers.id, userId));
    }
    for (const tenantId of createdTenantIds.splice(0)) {
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  });

  function app(ip: string, service: ConsoleLockoutService = lockoutService) {
    return createConsoleAuthRoutes(
      db,
      credentialService,
      sessionService,
      service,
      setupService,
      { ...defaultSessionCookiePolicy, secure: false },
      { mode: "disabled" },
      () => ip,
    );
  }

  function loginRequest(body: Record<string, unknown>): Request {
    return new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function seedUser(username: string): Promise<string> {
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "login-identity-test", status: "active" });
    createdTenantIds.push(tenantId);

    const userId = randomUUID();
    createdUserIds.push(userId);
    await db.insert(consoleUsers).values({
      id: userId,
      tenantId,
      username,
      passwordHash: await credentialService.hashPassword(PASSWORD),
      isActive: true,
      isFirstBoot: false,
    });
    return userId;
  }

  /** A distinct client address per test keeps lockout rows isolated. */
  function testIp(): string {
    return `198.51.100.${Math.floor(Math.random() * 254) + 1}`;
  }

  test("signs in when the submitted username differs in case from the stored row", async () => {
    // The exact production failure: row stored as `Liaan`, operator typed
    // `liaan` (or the form/autofill capitalized it differently).
    const stored = `Liaan-${randomUUID().slice(0, 8)}`;
    await seedUser(stored);
    const ip = testIp();

    for (const submitted of [stored.toLowerCase(), stored.toUpperCase(), stored]) {
      const response = await app(ip).handle(
        loginRequest({ username: submitted, password: PASSWORD }),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { status: string };
      expect(payload.status).toBe("success");
    }
  });

  test("still rejects a genuinely unknown user and records unknown_user", async () => {
    const ip = testIp();
    const username = `ghost-${randomUUID().slice(0, 8)}`;
    const key = `${username.toLowerCase()}:${ip}`;
    usedLockoutKeys.push(key);
    const response = await app(ip).handle(loginRequest({ username, password: PASSWORD }));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: "failed", message: "Invalid credentials" });

    const rows = await db.select().from(consoleLockouts).where(eq(consoleLockouts.ip, key));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("unknown_user");
  });

  test("shares one lockout bucket across capitalizations of the same name", async () => {
    // The property the lowercasing was protecting: an attacker who guesses
    // passwords must not be able to reset the counter by re-casing the name.
    const stored = `Case-${randomUUID().slice(0, 8)}`;
    await seedUser(stored);
    const ip = testIp();
    const key = `${stored.toLowerCase()}:${ip}`;
    usedLockoutKeys.push(key);

    const service = new ConsoleLockoutService(db, 2, 60_000);
    const first = await app(ip, service).handle(
      loginRequest({ username: stored.toUpperCase(), password: "wrong-password" }),
    );
    expect(first.status).toBe(401);

    const second = await app(ip, service).handle(
      loginRequest({ username: stored.toLowerCase(), password: "wrong-password" }),
    );
    expect(second.status).toBe(429);

    // The correct password under a third capitalization is still blocked —
    // one bucket, so the two failures above count against all spellings.
    const third = await app(ip, service).handle(
      loginRequest({ username: stored, password: PASSWORD }),
    );
    expect(third.status).toBe(429);
    const payload = (await third.json()) as { retry_after_seconds?: number };
    expect(payload.retry_after_seconds).toBeGreaterThan(0);
  });

  test("rejects rather than resolves a username matching more than one row", async () => {
    // The unique index is case-sensitive, so `Dup` and `dup` can both exist.
    // Such a pair is a broken invariant: signing in as whichever row sorted
    // first would silently pick an account, so the lookup refuses.
    const suffix = randomUUID().slice(0, 8);
    const upper = `Dup-${suffix}`;
    const lower = upper.toLowerCase();
    await seedUser(upper);
    await seedUser(lower);
    const ip = testIp();
    const key = `dup-${suffix}:${ip}`;
    usedLockoutKeys.push(key);

    const response = await app(ip).handle(
      loginRequest({ username: `DUP-${suffix}`, password: PASSWORD }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: "failed", message: "Invalid credentials" });

    const [row] = await db
      .select()
      .from(consoleLockouts)
      .where(eq(consoleLockouts.ip, key))
      .limit(1);
    expect(row?.reason).toBe("unknown_user");
  });
});
