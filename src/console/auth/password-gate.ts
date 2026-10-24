// Console password gate: one shared secret in front of the whole console.
//
// A local build is a one-operator deployment, so a per-user account row adds a
// setup step without adding a security boundary. Setting
// `LIANROUTER_CONSOLE_PASSWORD` collapses console auth to a single password —
// the model 9Router ships — while leaving the multi-user path untouched for
// deployments that need real accounts.
//
// The environment value is the *initial* password, not a permanent override.
// A public deployment must be able to set its own password without shell
// access to `.env`, so the console can take ownership of the secret: once it
// does, the stored hash is authoritative and a restart keeps it. Until then the
// environment stays authoritative, so rotating it on a machine where nobody
// used the console still applies on the next boot.
//
// Ownership lives in `console_settings.preferences.consolePasswordManaged`:
// absent means `env`, `console` means the hash in `console_users` wins. The
// gate itself stays a pure value object — the ownership read happens in
// `resolveEffectiveConsolePassword`, which the routes call once per request.
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { resolveConsolePassword } from "../../config";
import { consoleSettings, consoleUsers, tenants } from "../../persistence/schema";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { isRecord } from "../../protocol/primitives";
import { resolveDefaultGatewayApiKey } from "../../config";
import { encryptCredential, hashSecret } from "../../security/crypto";
import { log } from "../../observability/logger";
import { DEFAULT_API_KEY_LABEL } from "../domains/api-keys/contracts";
import { and } from "drizzle-orm";
import { apiKeys } from "../../persistence/schema";
import {
  returningRows,
  assertMutationApplied,
  consoleUsernameMatches,
} from "./service";
import type { ConsoleCredentialService } from "./service";

/** Username the gate signs in as when the operator did not pick one. */
const DEFAULT_GATE_USERNAME = "admin";

/**
 * The password a fresh local install starts with, and the one the login screen
 * advertises while it is still in use.
 *
 * The hint describes a credential the operator can actually type, so it is only
 * shown while the environment value is both the default *and* the effective
 * password. Once the console owns the secret the environment value is a
 * rotation trigger, not a credential, and the hint must disappear even if the
 * configured value never changed.
 */
export const DEFAULT_CONSOLE_PASSWORD = "local-console-2026";

const GATE_SETUP_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('lianrouter:console_password_gate'))`;

/**
 * Where the gate reports a state change.
 *
 * Injected rather than reached for directly so a test can record the line
 * without patching the process logger, and so the boot path can stay a plain
 * async function. The default forwards to the shared structured logger every
 * other `src/` module uses.
 *
 * A sink never receives a password, a hash, a fingerprint, or a token: only the
 * decision and the tenant it applied to.
 */
export interface ConsolePasswordLogSink {
  warn(message: string, context: Record<string, unknown>): void;
}

const defaultConsolePasswordLogSink: ConsolePasswordLogSink = {
  warn: (message, context) => log.warn(message, context),
};

/** Compares two strings without leaking length-independent timing detail. */
function constantTimeEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // timing signal, so pad both sides before comparing and fold the real length
  // check into the result.
  const length = Math.max(a.length, b.length);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  a.copy(paddedA);
  b.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

export interface ConsolePasswordGate {
  /** True when the console is in single-password mode. */
  readonly enabled: boolean;
  /** Username the gate signs in as. Only meaningful when enabled. */
  readonly username: string;
  /**
   * The configured password is still the shipped default *and* the environment
   * is still the effective owner. The login screen shows it only in this
   * state, so an operator who changed it — in `.env` or from the console — does
   * not see a stale credential on their own sign-in page.
   */
  readonly usesDefaultPassword: boolean;
  /** Verifies a submitted password. Always false when the gate is disabled. */
  verify(password: string): boolean;
}

/**
 * Reads the gate configuration once per process. A blank value reads as unset
 * so an empty `.env` line cannot accidentally open the console with no
 * password.
 */
export function resolveConsolePasswordGate(): ConsolePasswordGate {
  const expected = resolveConsolePassword();
  if (expected === undefined) {
    return {
      enabled: false,
      username: DEFAULT_GATE_USERNAME,
      usesDefaultPassword: false,
      verify: () => false,
    };
  }
  return {
    enabled: true,
    username: DEFAULT_GATE_USERNAME,
    usesDefaultPassword: constantTimeEquals(expected, DEFAULT_CONSOLE_PASSWORD),
    verify: (password: string) =>
      typeof password === "string" && password.length > 0 && constantTimeEquals(password, expected),
  };
}

/**
 * A gate whose secret is an already-resolved value instead of the environment.
 *
 * Boot reconciliation and the login route both need the *effective* password:
 * the environment value while it owns the secret, or the console-managed one
 * after an operator changed it. Building the gate from the resolved value keeps
 * one verification rule instead of a second code path that could accept a
 * password the other rejects.
 */
export function consolePasswordGateFor(password: string): ConsolePasswordGate {
  return {
    enabled: true,
    username: DEFAULT_GATE_USERNAME,
    usesDefaultPassword: constantTimeEquals(password, DEFAULT_CONSOLE_PASSWORD),
    verify: (candidate: string) =>
      typeof candidate === "string" &&
      candidate.length > 0 &&
      constantTimeEquals(candidate, password),
  };
}

/**
 * The gate a request should report the default-password hint for.
 *
 * `usesDefaultPassword` is a claim about a *usable credential*, and ownership
 * decides whether the environment value is one: while the console owns the
 * secret, `LIANROUTER_CONSOLE_PASSWORD` only triggers a reclaim, so printing it
 * as "the default password" advertises a value the server rejects with a 401.
 *
 * The ownership flag is database state, so the combination cannot live in
 * `resolveConsolePasswordGate` (sync, one read per process, no DB handle). It
 * belongs here instead: the login route already resolves ownership once per
 * request through `resolveEffectiveConsolePassword`, so this takes that answer
 * as a parameter and stays sync. The gate is only rebuilt when ownership
 * changes the answer — otherwise the caller's instance is returned untouched.
 */
export function consolePasswordGateWithOwnership(
  gate: ConsolePasswordGate,
  consoleManaged: boolean,
): ConsolePasswordGate {
  if (!consoleManaged || !gate.usesDefaultPassword) return gate;
  return { ...gate, usesDefaultPassword: false };
}

/**
 * Whether the console has taken ownership of the password away from `.env`.
 *
 * Read from the gate user's tenant settings row. A missing row, a missing key,
 * or an unreadable value all mean `env`: the safe default is the documented
 * one, where the environment value is authoritative.
 */
export async function consolePasswordIsConsoleManaged(
  db: LianRouterDatabase,
): Promise<boolean> {
  const { managed } = await readConsolePasswordOwnership(db, undefined);
  return managed;
}

/**
 * One read of everything the ownership decision needs: whose tenant the gate
 * belongs to, whether the console owns the secret, and whether `.env` was
 * rotated since it claimed it.
 *
 * Callers that need both answers (boot reconciliation) get them from one query
 * instead of two, and the tenant id travels with the answer so a writer never
 * has to re-derive it — the release path needs it to avoid an unscoped update.
 */
async function readConsolePasswordOwnership(
  db: LianRouterDatabase,
  environmentPassword: string | undefined,
): Promise<{ tenantId: string | undefined; managed: boolean; rotated: boolean }> {
  const { tenantId, preferences } = await gatePreferences(db);
  const managed = isRecord(preferences) && preferences.consolePasswordManaged === "console";
  if (!managed || environmentPassword === undefined) {
    return { tenantId, managed, rotated: false };
  }
  const stored = preferences.consolePasswordEnvFingerprint;
  // A row claimed before the fingerprint existed cannot prove the environment
  // was unchanged. Treat it as a rotation: the environment value is the
  // documented way back in, and assuming the opposite would leave an operator
  // who forgot the console password with no path except editing the database.
  const rotated =
    typeof stored !== "string" || stored !== consolePasswordEnvFingerprint(environmentPassword);
  return { tenantId, managed, rotated };
}

/**
 * The gate's own preferences row plus the tenant it belongs to.
 *
 * Scoped to the gate user's tenant, never "the first row in the table": a
 * deployment can hold several tenants, and reading an arbitrary one made the
 * ownership flag depend on insert order — the console password then survived a
 * restart on one machine and silently reverted on another.
 *
 * The tenant id is returned beside the preferences because every writer of this
 * row needs it: an unscoped `update(consoleSettings)` would clear ownership on
 * every tenant at once.
 */
async function gatePreferences(
  db: LianRouterDatabase,
): Promise<{ tenantId: string | undefined; preferences: unknown }> {
  const userRows = await db
    .select({ tenantId: consoleUsers.tenantId })
    .from(consoleUsers)
    .where(consoleUsernameMatches(DEFAULT_GATE_USERNAME))
    .limit(1);
  const tenantId = userRows[0]?.tenantId;
  if (tenantId === undefined) return { tenantId: undefined, preferences: undefined };
  const rows = await db
    .select({ preferences: consoleSettings.preferences })
    .from(consoleSettings)
    .where(eq(consoleSettings.tenantId, tenantId))
    .limit(1);
  return { tenantId, preferences: rows[0]?.preferences };
}

/**
 * Fingerprint of an environment password, used only to detect rotation.
 *
 * The password itself is never stored: this is a hash of the configured value,
 * so the boot path can tell whether the operator changed `.env` since the
 * console took ownership without keeping a second copy of the secret.
 */
export function consolePasswordEnvFingerprint(password: string): string {
  return hashSecret(`console-password-env:${password}`);
}

/**
 * Marks the console as the owner of the password.
 *
 * Upserts the single preferences row so the flag survives restarts and is
 * visible to every instance. Only the two keys are written: the update merges
 * into the existing JSONB bag, so runtime settings are never clobbered.
 */
export async function claimConsolePasswordOwnership(
  db: LianRouterDatabase,
  tenantId: string,
  environmentPassword: string | undefined = resolveConsolePassword(),
  logSink: ConsolePasswordLogSink = defaultConsolePasswordLogSink,
): Promise<void> {
  const now = new Date();
  const fingerprint =
    environmentPassword === undefined
      ? undefined
      : consolePasswordEnvFingerprint(environmentPassword);
  const patch = JSON.stringify({
    consolePasswordManaged: "console",
    ...(fingerprint === undefined ? {} : { consolePasswordEnvFingerprint: fingerprint }),
  });
  await db
    .insert(consoleSettings)
    .values({
      tenantId,
      preferences: {
        consolePasswordManaged: "console",
        ...(fingerprint === undefined ? {} : { consolePasswordEnvFingerprint: fingerprint }),
      },
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: consoleSettings.tenantId,
      set: {
        preferences: sql`${consoleSettings.preferences} || ${patch}::jsonb`,
        updatedAt: now,
      },
    });
  logSink.warn("[console-password] console claimed ownership of the gate password", {
    tenantId,
  });
}

/**
 * Releases ownership back to the environment.
 *
 * Used when the operator rotates `LIANROUTER_CONSOLE_PASSWORD` on a machine
 * where the console had taken over: the environment becomes authoritative
 * again and the hash is re-seeded at boot.
 *
 * The update is scoped to the reconciled tenant. `console_settings` is one row
 * per tenant, so an unscoped `update` cleared `consolePasswordManaged` and its
 * fingerprint on every tenant in the deployment — a cross-tenant write in the
 * path that decides who owns the console credential.
 */
export async function releaseConsolePasswordOwnership(
  db: LianRouterDatabase,
  tenantId: string,
): Promise<void> {
  await db
    .update(consoleSettings)
    .set({
      preferences: sql`${consoleSettings.preferences} - 'consolePasswordManaged'`,
      updatedAt: new Date(),
    })
    .where(eq(consoleSettings.tenantId, tenantId));
}

/**
 * The password the console currently accepts, or `undefined` when the gate is
 * disabled.
 *
 * The stored hash cannot be turned back into a password, so a console-managed
 * secret cannot be read out here. Instead this reports `undefined` for that
 * case and the caller verifies against the row hash directly — see
 * `consolePasswordVerifier`.
 */
export interface EffectiveConsolePassword {
  /** True when the console is in single-password mode at all. */
  readonly enabled: boolean;
  /** The environment password while it owns the secret; else undefined. */
  readonly environmentPassword: string | undefined;
  /** True when the stored hash, not the environment, is authoritative. */
  readonly consoleManaged: boolean;
  /** The gate user's row, when one exists. */
  readonly userId: string | undefined;
  /** The gate user's stored hash, when one exists. */
  readonly passwordHash: string | undefined;
}

/** Reads everything the login route needs to verify one submitted password. */
export async function resolveEffectiveConsolePassword(
  db: LianRouterDatabase,
  environmentPassword: string | undefined = resolveConsolePassword(),
): Promise<EffectiveConsolePassword> {
  if (environmentPassword === undefined) {
    return {
      enabled: false,
      environmentPassword: undefined,
      consoleManaged: false,
      userId: undefined,
      passwordHash: undefined,
    };
  }
  const consoleManaged = await consolePasswordIsConsoleManaged(db);
  const rows = await db
    .select({ id: consoleUsers.id, passwordHash: consoleUsers.passwordHash })
    .from(consoleUsers)
    .where(consoleUsernameMatches(DEFAULT_GATE_USERNAME))
    .limit(1);
  return {
    enabled: true,
    // While the environment owns the secret the hash is a mirror, never the
    // authority — handing it back here would let a stale row win a tie.
    environmentPassword: consoleManaged ? undefined : environmentPassword,
    consoleManaged,
    userId: rows[0]?.id,
    passwordHash: rows[0]?.passwordHash,
  };
}

/**
 * Makes the single-password account exist and match the effective password.
 *
 * Runs at boot, before the listener accepts traffic, so a login can never race
 * the row it needs. Idempotent: an existing row is updated in place rather than
 * duplicated, and the hash is only rewritten when the stored one no longer
 * verifies — a restart with the same password does not churn the row.
 *
 * A console-managed password is never overwritten from `.env`: the operator set
 * it in the UI, and reverting it on the next restart would be a silent
 * credential reset on a deployment other people sign into.
 *
 * The tenant, the admin user, and the default gateway key are created together
 * under an advisory lock, matching what first-boot setup does on the multi-user
 * path, so both modes leave the same shape behind.
 */
export async function reconcileConsolePasswordUser(
  db: LianRouterDatabase,
  credentialService: ConsoleCredentialService,
  gate: ConsolePasswordGate = resolveConsolePasswordGate(),
  password: string | undefined = resolveConsolePassword(),
  logSink: ConsolePasswordLogSink = defaultConsolePasswordLogSink,
): Promise<void> {
  if (!gate.enabled || password === undefined) return;
  // One read for both ownership questions. The tenant id it returns is the one
  // the release must target: the flag lives in a per-tenant row, so releasing
  // it unscoped cleared every tenant's ownership at once.
  const ownership = await readConsolePasswordOwnership(db, password);
  let ownershipReleased = false;
  if (ownership.managed) {
    // A console-managed password stays authoritative across restarts — that is
    // what makes a change made in the UI durable. Rotating the environment
    // value is the explicit way to take the secret back, which also covers an
    // operator who forgot the console password.
    if (!ownership.rotated) return;
    if (ownership.tenantId !== undefined) {
      await releaseConsolePasswordOwnership(db, ownership.tenantId);
      ownershipReleased = true;
    }
  }

  let passwordHashRewritten = false;
  let reconciledTenantId: string | undefined;
  await db.transaction(async (transaction) => {
    await transaction.execute(GATE_SETUP_LOCK);
    const scope = transaction as unknown as LianRouterDatabase;

    let tenantId: string | undefined;
    const tenantRows = await scope.select().from(tenants).limit(1);
    const existingTenant = tenantRows[0];
    if (isRecord(existingTenant) && typeof existingTenant.id === "string") {
      tenantId = existingTenant.id;
    } else {
      const candidateId = randomUUID();
      const insertedTenant = await returningRows(
        scope.insert(tenants).values({ id: candidateId, name: "Default", status: "active" }),
      );
      assertMutationApplied(insertedTenant, "Default tenant");
      const inserted = insertedTenant.rows[0];
      tenantId = isRecord(inserted) && typeof inserted.id === "string" ? inserted.id : candidateId;
    }
    reconciledTenantId = tenantId;

    // Same predicate the login route reads with: a row stored `Admin` is the
    // gate's account, and inserting a second `admin` beside it would make
    // every login ambiguous and lock the operator out.
    const userRows = await scope
      .select()
      .from(consoleUsers)
      .where(consoleUsernameMatches(gate.username))
      .limit(1);
    const existing = userRows[0];
    if (existing === undefined) {
      const passwordHash = await credentialService.hashPassword(password);
      const insertedUser = await returningRows(
        scope.insert(consoleUsers).values({
          id: randomUUID(),
          tenantId,
          username: gate.username,
          email: `${gate.username}@localhost`,
          passwordHash,
          displayName: "Administrator",
          isFirstBoot: false,
          isActive: true,
          isPlatformAdmin: true,
        }),
      );
      assertMutationApplied(insertedUser, "Administrator user");
      passwordHashRewritten = true;
    } else if (!(await credentialService.verifyPassword(password, existing.passwordHash))) {
      // The environment is authoritative until the console takes over: a
      // rotated password is applied on the next boot instead of requiring a
      // console visit.
      const passwordHash = await credentialService.hashPassword(password);
      const updated = await returningRows(
        scope
          .update(consoleUsers)
          .set({ passwordHash, isActive: true, isFirstBoot: false, updatedAt: new Date() })
          .where(eq(consoleUsers.id, existing.id)),
      );
      assertMutationApplied(updated, "Administrator password");
      passwordHashRewritten = true;
    }

    const defaultApiKey = resolveDefaultGatewayApiKey();
    if (!defaultApiKey) return;
    const keyHash = hashSecret(defaultApiKey);
    const existingKey = await scope
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.keyHash, keyHash)))
      .limit(1);
    if (existingKey.length > 0) return;
    await scope.insert(apiKeys).values({
      id: randomUUID(),
      tenantId,
      keyHash,
      label: DEFAULT_API_KEY_LABEL,
      scopes: ["routing:invoke"],
      keyPrefix: defaultApiKey.slice(0, 3),
      keyEncrypted: encryptCredential(defaultApiKey),
      requestsPerMinute: 240,
    });
  });

  // Exactly one line per boot that changed the credential's owner or value.
  // The no-op paths return above, so a routine restart — the common case — stays
  // silent instead of printing the same line on every start.
  if (ownershipReleased || passwordHashRewritten) {
    logSink.warn("[console-password] reconciled the console gate password", {
      tenantId: reconciledTenantId,
      ownershipReleased,
      passwordHashRewritten,
      // What the boot path changed, not a secret: an operator whose environment
      // password stopped working can see which branch ran.
      effectiveOwner: "env",
    });
  }
}
