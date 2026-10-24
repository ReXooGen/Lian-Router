import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { consoleSessions, consoleSettings, consoleUsers, tenants } from "../../../src/persistence/schema";
import {
  ConsoleCredentialService,
  ConsoleLockoutService,
  ConsoleSessionService,
  defaultSessionCookiePolicy,
  type FirstBootSetupService,
} from "../../../src/console/auth/service";
import { createConsoleAuthRoutes } from "../../../src/console/auth/session";
import {
  DEFAULT_CONSOLE_PASSWORD,
  claimConsolePasswordOwnership,
  consolePasswordIsConsoleManaged,
  reconcileConsolePasswordUser,
  releaseConsolePasswordOwnership,
  resolveConsolePasswordGate,
  type ConsolePasswordGate,
  type ConsolePasswordLogSink,
} from "../../../src/console/auth/password-gate";

/**
 * Single-password console gate.
 *
 * The gate is configuration, not database state: `LIANROUTER_CONSOLE_PASSWORD`
 * both decides that the console is in this mode and supplies the only accepted
 * secret. These tests pin the two properties that make it safe — the password
 * alone authenticates, and the setup wizard cannot create a second way in —
 * plus the boot reconciliation that keeps the backing row in step.
 */

const GATE_PASSWORD = "console-gate-password-1";

/** Builds a gate without touching the process environment. */
function gateFor(password: string | undefined): ConsolePasswordGate {
  if (password === undefined) {
    return {
      enabled: false,
      username: "admin",
      usesDefaultPassword: false,
      verify: () => false,
    };
  }
  return {
    enabled: true,
    username: "admin",
    usesDefaultPassword: password === DEFAULT_CONSOLE_PASSWORD,
    verify: (candidate: string) => candidate === password,
  };
}

/**
 * Reads the two first-boot flags off a JSON body without asserting a shape.
 *
 * The response is external input as far as this test is concerned; narrowing
 * keeps a renamed or retyped field a loud failure instead of an undefined that
 * compares false and makes the assertion pass for the wrong reason.
 */
function readFirstBootFlags(body: unknown): {
  passwordGate: boolean;
  defaultPasswordHint: boolean;
} {
  if (typeof body !== "object" || body === null) {
    throw new Error("first-boot response was not a JSON object");
  }
  if (!("password_gate" in body) || !("default_password_hint" in body)) {
    throw new Error("first-boot response is missing its flags");
  }
  const { password_gate, default_password_hint } = body;
  if (typeof password_gate !== "boolean" || typeof default_password_hint !== "boolean") {
    throw new Error("first-boot flags were not booleans");
  }
  return { passwordGate: password_gate, defaultPasswordHint: default_password_hint };
}

describe("console password gate", () => {
  test("is disabled when no password is configured", () => {
    const gate = resolveConsolePasswordGate();
    expect(gate.enabled).toBe(process.env.LIANROUTER_CONSOLE_PASSWORD !== undefined);
  });

  test("rejects every password while disabled", () => {
    expect(gateFor(undefined).verify("")).toBe(false);
    expect(gateFor(undefined).verify("anything")).toBe(false);
  });

  test("reports the default password only while it is still configured", () => {
    expect(gateFor(DEFAULT_CONSOLE_PASSWORD).usesDefaultPassword).toBe(true);
    expect(gateFor("a-rotated-password").usesDefaultPassword).toBe(false);
    expect(gateFor(undefined).usesDefaultPassword).toBe(false);
  });

  test("accepts only the configured password while enabled", () => {
    const gate = gateFor(GATE_PASSWORD);
    expect(gate.verify(GATE_PASSWORD)).toBe(true);
    expect(gate.verify(`${GATE_PASSWORD} `)).toBe(false);
    expect(gate.verify(GATE_PASSWORD.slice(0, -1))).toBe(false);
    expect(gate.verify("")).toBe(false);
  });
});

let db: LianRouterDatabase;
let credentialService: ConsoleCredentialService;
let sessionService: ConsoleSessionService;
let lockoutService: ConsoleLockoutService;
const setupService = {} as FirstBootSetupService;

function authApp(gate: ConsolePasswordGate) {
  return createConsoleAuthRoutes(
    db,
    credentialService,
    sessionService,
    lockoutService,
    setupService,
    undefined,
    undefined,
    () => "127.0.0.1",
    gate,
  );
}

function loginRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

dbDescribe("single-password console login", () => {
  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    db = getDb();
    credentialService = new ConsoleCredentialService();
    sessionService = new ConsoleSessionService(db, {
      ...defaultSessionCookiePolicy,
      secure: false,
    });
    lockoutService = new ConsoleLockoutService(db);
  });

  /**
   * The gate signs in as one fixed username, and `console_users.username` is
   * unique — so a leftover row from the previous test is the only thing that
   * can make the next one fail. Clear the identity between tests rather than
   * inventing per-test usernames the gate cannot use.
   */
  beforeEach(async () => {
    for (const userId of createdUserIds.splice(0)) {
      await db.delete(consoleSessions).where(eq(consoleSessions.userId, userId));
      await db.delete(consoleUsers).where(eq(consoleUsers.id, userId));
    }
    await db.delete(consoleUsers).where(eq(consoleUsers.username, "admin"));
    for (const tenantId of createdTenantIds.splice(0)) {
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  });

  afterAll(async () => {
    for (const userId of createdUserIds.splice(0)) {
      await db.delete(consoleSessions).where(eq(consoleSessions.userId, userId));
      await db.delete(consoleUsers).where(eq(consoleUsers.id, userId));
    }
    for (const tenantId of createdTenantIds.splice(0)) {
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    }
  });

  async function seedAdmin(): Promise<{ userId: string }> {
    const tenantId = randomUUID();
    // A tenant row per test keeps the foreign key satisfiable after the
    // cleanup above deletes the previous one.
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "console-gate-test", status: "active" });
    createdTenantIds.push(tenantId);

    const userId = randomUUID();
    createdUserIds.push(userId);
    await db.insert(consoleUsers).values({
      id: userId,
      tenantId,
      username: "admin",
      passwordHash: await credentialService.hashPassword("a-different-db-password"),
      isActive: true,
      isFirstBoot: false,
      isPlatformAdmin: true,
    });
    return { userId };
  }

  test("authenticates with the configured password and no username", async () => {
    await seedAdmin();
    const response = await authApp(gateFor(GATE_PASSWORD)).handle(
      loginRequest({ password: GATE_PASSWORD }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { status: string };
    expect(payload.status).toBe("success");
  });

  test("rejects the stored database password while the gate owns the secret", async () => {
    await seedAdmin();
    const response = await authApp(gateFor(GATE_PASSWORD)).handle(
      loginRequest({ password: "a-different-db-password" }),
    );
    expect(response.status).toBe(401);
  });

  test("rejects a wrong password", async () => {
    await seedAdmin();
    const response = await authApp(gateFor(GATE_PASSWORD)).handle(
      loginRequest({ password: "not-the-console-password" }),
    );
    expect(response.status).toBe(401);
  });

  test("rejects a login with no password at all", async () => {
    await seedAdmin();
    // The route's body schema requires `password`, so an empty body never
    // reaches the handler: Elysia rejects it as a validation failure.
    const response = await authApp(gateFor(GATE_PASSWORD)).handle(loginRequest({}));
    expect(response.status).toBe(422);
  });

  test("reports the gate on first-boot so the console skips the setup wizard", async () => {
    const response = await authApp(gateFor(GATE_PASSWORD)).handle(
      new Request("http://localhost/auth/first-boot"),
    );
    const payload = (await response.json()) as {
      requires_setup: boolean;
      password_gate: boolean;
    };
    expect(payload.password_gate).toBe(true);
    expect(payload.requires_setup).toBe(false);
  });

  test("advertises the default password hint only for the shipped default", async () => {
    const withDefault = await authApp(gateFor(DEFAULT_CONSOLE_PASSWORD)).handle(
      new Request("http://localhost/auth/first-boot"),
    );
    expect(((await withDefault.json()) as { default_password_hint: boolean }).default_password_hint).toBe(
      true,
    );

    const rotated = await authApp(gateFor("a-rotated-password-xyz")).handle(
      new Request("http://localhost/auth/first-boot"),
    );
    expect(((await rotated.json()) as { default_password_hint: boolean }).default_password_hint).toBe(
      false,
    );
  });

  test("hides the default hint once the console owns the password", async () => {
    // Regression: the env value was unchanged and still equal to the shipped
    // default, so the login screen printed "Default password: …" while the
    // stored hash — the real credential — was a rotated one. The hint is a
    // promise about a password that works, and in console-managed mode the
    // environment value only triggers a reclaim.
    const { userId } = await seedAdmin();
    const [user] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.id, userId))
      .limit(1);
    expect(user).toBeDefined();
    await claimConsolePasswordOwnership(db, user!.tenantId, DEFAULT_CONSOLE_PASSWORD);
    expect(await consolePasswordIsConsoleManaged(db)).toBe(true);

    const response = await authApp(gateFor(DEFAULT_CONSOLE_PASSWORD)).handle(
      new Request("http://localhost/auth/first-boot"),
    );
    const payload = readFirstBootFlags(await response.json());
    expect(payload.passwordGate).toBe(true);
    expect(payload.defaultPasswordHint).toBe(false);
  });

  test("keeps the default hint while the environment still owns the password", async () => {
    // The existing behaviour must not regress: with no ownership claim the env
    // value *is* the credential, so the shipped default is advertised.
    await seedAdmin();
    await db.delete(consoleSettings);
    expect(await consolePasswordIsConsoleManaged(db)).toBe(false);

    const response = await authApp(gateFor(DEFAULT_CONSOLE_PASSWORD)).handle(
      new Request("http://localhost/auth/first-boot"),
    );
    expect(readFirstBootFlags(await response.json()).defaultPasswordHint).toBe(true);
  });


  test("a password changed from the console takes over from the environment", async () => {
    // A public deployment must be able to set its own password: the operator
    // has the console open, not a shell on the host. The change is accepted,
    // written as a hash, and ownership moves to the console so the next boot
    // does not revert it from `.env`.
    const { userId } = await seedAdmin();
    const session = await sessionService.createSession(userId, "127.0.0.1", "gate-test");
    const response = await authApp(gateFor(GATE_PASSWORD)).handle(
      new Request("http://localhost/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `session_token=${session.sessionToken}`,
        },
        body: JSON.stringify({
          currentPassword: GATE_PASSWORD,
          newPassword: "a-brand-new-password",
        }),
      }),
    );
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.id, userId))
      .limit(1);
    expect(await credentialService.verifyPassword("a-brand-new-password", row!.passwordHash)).toBe(
      true,
    );
  });

  test("rejects a password change with the wrong current password", async () => {
    const { userId } = await seedAdmin();
    const session = await sessionService.createSession(userId, "127.0.0.1", "gate-test");
    const response = await authApp(gateFor(GATE_PASSWORD)).handle(
      new Request("http://localhost/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `session_token=${session.sessionToken}`,
        },
        body: JSON.stringify({
          currentPassword: "not-the-current-password",
          newPassword: "a-brand-new-password",
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("refuses to run the setup wizard while the gate is enabled", async () => {
    const response = await authApp(gateFor(GATE_PASSWORD)).handle(
      new Request("http://localhost/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "another-password-entirely" }),
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { status: string };
    expect(payload.status).toBe("failed");
  });

  test("boot reconciliation creates the admin row the gate signs in as", async () => {
    const gate = gateFor("reconciled-password-123");
    await reconcileConsolePasswordUser(db, credentialService, gate, "reconciled-password-123");
    const rows = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.username, gate.username))
      .limit(1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    createdUserIds.push(row.id);
    expect(row.isPlatformAdmin).toBe(true);
    expect(row.isFirstBoot).toBe(false);
    expect(await credentialService.verifyPassword("reconciled-password-123", row.passwordHash)).toBe(
      true,
    );
  });

  test("boot reconciliation rewrites the hash when the environment password changed", async () => {
    const first = gateFor("rotated-password-first");
    await reconcileConsolePasswordUser(db, credentialService, first, "rotated-password-first");
    const [before] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.username, first.username))
      .limit(1);
    expect(before).toBeDefined();
    createdUserIds.push(before!.id);

    const second = gateFor("rotated-password-second");
    await reconcileConsolePasswordUser(db, credentialService, second, "rotated-password-second");
    const [after] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.username, second.username))
      .limit(1);
    expect(after!.id).toBe(before!.id);
    expect(await credentialService.verifyPassword("rotated-password-second", after!.passwordHash)).toBe(
      true,
    );
    expect(await credentialService.verifyPassword("rotated-password-first", after!.passwordHash)).toBe(
      false,
    );
  });

  test("boot reconciliation is a no-op while the gate is disabled", async () => {
    const before = await db.select().from(consoleUsers).limit(1);
    await reconcileConsolePasswordUser(db, credentialService, gateFor(undefined), undefined);
    const after = await db.select().from(consoleUsers).limit(1);
    expect(after.length).toBe(before.length);
  });
});

dbDescribe("console-owned password survives a restart", () => {
  test("boot reconciliation leaves a console-managed password alone", async () => {
    // Regression: the console wrote the new hash, the next boot re-seeded it
    // from `.env`, and the operator's password silently reverted. Ownership is
    // what makes the change durable.
    const gate = gateFor("env-password-123456");
    await db.delete(consoleSettings);
    await reconcileConsolePasswordUser(db, credentialService, gate, "env-password-123456");
    const [row] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.username, gate.username))
      .limit(1);
    expect(row).toBeDefined();

    const newHash = await credentialService.hashPassword("console-password-9876");
    await db
      .update(consoleUsers)
      .set({ passwordHash: newHash })
      .where(eq(consoleUsers.id, row!.id));
    await claimConsolePasswordOwnership(db, row!.tenantId, "env-password-123456");

    // The boot path runs again with the environment value unchanged: the
    // console password must survive, or every restart would silently reset it.
    await reconcileConsolePasswordUser(db, credentialService, gate, "env-password-123456");
    const [after] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.id, row!.id))
      .limit(1);
    expect(
      await credentialService.verifyPassword("console-password-9876", after!.passwordHash),
    ).toBe(true);
    expect(
      await credentialService.verifyPassword("env-password-123456", after!.passwordHash),
    ).toBe(false);

    await releaseConsolePasswordOwnership(db, row!.tenantId);
    await db.delete(consoleSessions).where(eq(consoleSessions.userId, row!.id));
    await db.delete(consoleUsers).where(eq(consoleUsers.id, row!.id));
  });

  test("a rotated environment password takes the secret back", async () => {
    // An operator who forgot the console password rotates the variable. The
    // boot path must notice and apply it, otherwise there is no way back in
    // without editing the database by hand.
    const gate = gateFor("env-before-rotation");
    await db.delete(consoleSettings);
    await reconcileConsolePasswordUser(db, credentialService, gate, "env-before-rotation");
    const [row] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.username, gate.username))
      .limit(1);
    expect(row).toBeDefined();

    const newHash = await credentialService.hashPassword("console-password-1111");
    await db
      .update(consoleUsers)
      .set({ passwordHash: newHash })
      .where(eq(consoleUsers.id, row!.id));
    await claimConsolePasswordOwnership(db, row!.tenantId, "env-before-rotation");

    await reconcileConsolePasswordUser(db, credentialService, gate, "env-after-rotation");
    const [after] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.id, row!.id))
      .limit(1);
    expect(
      await credentialService.verifyPassword("env-after-rotation", after!.passwordHash),
    ).toBe(true);
    expect(await consolePasswordIsConsoleManaged(db)).toBe(false);

    await db.delete(consoleSessions).where(eq(consoleSessions.userId, row!.id));
    await db.delete(consoleUsers).where(eq(consoleUsers.id, row!.id));
  });

  test("releasing ownership hands the password back to the environment", async () => {
    const gate = gateFor("env-password-abc");
    await db.delete(consoleSettings);
    await reconcileConsolePasswordUser(db, credentialService, gate, "env-password-abc");
    const [row] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.username, gate.username))
      .limit(1);
    expect(row).toBeDefined();

    await claimConsolePasswordOwnership(db, row!.tenantId, "env-password-abc");
    const managed = await consolePasswordIsConsoleManaged(db);
    expect(managed).toBe(true);

    await releaseConsolePasswordOwnership(db, row!.tenantId);
    expect(await consolePasswordIsConsoleManaged(db)).toBe(false);

    // With ownership released, a rotated environment value applies again.
    await reconcileConsolePasswordUser(
      db,
      credentialService,
      gate,
      "env-password-rotated",
    );
    const [after] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.id, row!.id))
      .limit(1);
    expect(
      await credentialService.verifyPassword("env-password-rotated", after!.passwordHash),
    ).toBe(true);

    await db.delete(consoleSessions).where(eq(consoleSessions.userId, row!.id));
    await db.delete(consoleUsers).where(eq(consoleUsers.id, row!.id));
  });
});

dbDescribe("console password reconciliation is tenant-scoped", () => {
  /** Creates a second tenant with an ownership claim of its own. */
  async function seedOtherTenant(): Promise<string> {
    const tenantId = randomUUID();
    await db.insert(tenants).values({ id: tenantId, name: "other-tenant", status: "active" });
    await claimConsolePasswordOwnership(db, tenantId, "other-tenant-env-password");
    return tenantId;
  }

  test("releasing ownership leaves every other tenant's claim intact", async () => {
    // Regression: the release used an unscoped `update(consoleSettings)`, so a
    // rotation on one tenant cleared `consolePasswordManaged` and its
    // fingerprint on all of them — a cross-tenant write in the path that
    // decides who owns the console credential.
    const gate = gateFor("env-password-scoped");
    await db.delete(consoleSettings);
    await reconcileConsolePasswordUser(db, credentialService, gate, "env-password-scoped");
    const [row] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.username, gate.username))
      .limit(1);
    expect(row).toBeDefined();

    await claimConsolePasswordOwnership(db, row!.tenantId, "env-password-scoped");
    const otherTenantId = await seedOtherTenant();

    const otherBefore = await db
      .select()
      .from(consoleSettings)
      .where(eq(consoleSettings.tenantId, otherTenantId))
      .limit(1);
    expect(otherBefore[0]?.preferences.consolePasswordManaged).toBe("console");
    expect(typeof otherBefore[0]?.preferences.consolePasswordEnvFingerprint).toBe("string");

    // The rotated value reconciles the gate tenant and releases only its claim.
    await reconcileConsolePasswordUser(db, credentialService, gate, "env-password-rotated");
    expect(await consolePasswordIsConsoleManaged(db)).toBe(false);

    const otherAfter = await db
      .select()
      .from(consoleSettings)
      .where(eq(consoleSettings.tenantId, otherTenantId))
      .limit(1);
    expect(otherAfter[0]?.preferences.consolePasswordManaged).toBe("console");
    expect(otherAfter[0]?.preferences.consolePasswordEnvFingerprint).toBe(
      otherBefore[0]?.preferences.consolePasswordEnvFingerprint,
    );

    await db.delete(tenants).where(eq(tenants.id, otherTenantId));
    await db.delete(consoleSessions).where(eq(consoleSessions.userId, row!.id));
    await db.delete(consoleUsers).where(eq(consoleUsers.id, row!.id));
  });
});

dbDescribe("console password reconciliation logging", () => {
  /** Collects what the gate reported, without touching the process logger. */
  function recordingSink(): {
    sink: ConsolePasswordLogSink;
    lines: { message: string; context: Record<string, unknown> }[];
  } {
    const lines: { message: string; context: Record<string, unknown> }[] = [];
    return {
      lines,
      sink: {
        warn: (message, context) => {
          lines.push({ message, context });
        },
      },
    };
  }

  test("warns once when reconciliation changes the credential", async () => {
    const gate = gateFor("env-password-logged");
    await db.delete(consoleSettings);
    await reconcileConsolePasswordUser(db, credentialService, gate, "env-password-logged");
    const [row] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.username, gate.username))
      .limit(1);
    expect(row).toBeDefined();
    await claimConsolePasswordOwnership(db, row!.tenantId, "env-password-logged");

    const { sink, lines } = recordingSink();
    await reconcileConsolePasswordUser(db, credentialService, gate, "env-password-rotated", sink);

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line?.context.tenantId).toBe(row!.tenantId);
    // The line names the decision, never the secret.
    expect(JSON.stringify(line)).not.toContain("env-password-rotated");
    expect(JSON.stringify(line)).not.toContain("consolePasswordEnvFingerprint");

    await db.delete(consoleSessions).where(eq(consoleSessions.userId, row!.id));
    await db.delete(consoleUsers).where(eq(consoleUsers.id, row!.id));
  });

  test("stays silent on the no-op boot path", async () => {
    // A routine restart must not print the line: it runs on every boot and
    // would be pure noise.
    const gate = gateFor("env-password-quiet");
    await db.delete(consoleSettings);
    await reconcileConsolePasswordUser(db, credentialService, gate, "env-password-quiet");
    const [row] = await db
      .select()
      .from(consoleUsers)
      .where(eq(consoleUsers.username, gate.username))
      .limit(1);
    expect(row).toBeDefined();
    await claimConsolePasswordOwnership(db, row!.tenantId, "env-password-quiet");

    const { sink, lines } = recordingSink();
    await reconcileConsolePasswordUser(db, credentialService, gate, "env-password-quiet", sink);
    expect(lines).toHaveLength(0);

    await releaseConsolePasswordOwnership(db, row!.tenantId);
    await db.delete(consoleSessions).where(eq(consoleSessions.userId, row!.id));
    await db.delete(consoleUsers).where(eq(consoleUsers.id, row!.id));
  });
});
