import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { providerAccounts, providerReportHits, providers, tenants } from "../../../src/persistence/schema";
import { DrizzleReportStore } from "../../../src/console/automation/report/store";
import { dbDescribe } from "../../helpers/db-gate";
import type { AccessDecision } from "../../../src/security/access-control";
import type {
  ReportAccountRecord,
  ReportAccountStatus,
  ReportCounts,
  ReportLastState,
  ReportPickRecord,
  ReportScheduleRecord,
  ReportStorePort,
} from "../../../src/console/automation/report/contracts";
import { createReportRoutes } from "../../../src/console/automation/report/routes";

const readWrite: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
  admissionIdentity: "key-1",
};
const readOnly: AccessDecision = { ...readWrite, scopes: ["dashboard:read"] };

interface SeedAccount {
  readonly id: string;
  readonly label: string;
  readonly status?: string;
  readonly hitAt?: Date | null;
  readonly lastState?: ReportLastState | null;
  readonly lastError?: string | null;
}

/**
 * In-memory double over the store contract. It implements the same ordering and
 * counting rules as the Drizzle store because those rules *are* the contract the
 * console renders — a double that merely echoes whatever the route asked for
 * would prove nothing.
 */
function memoryStore(seed: readonly SeedAccount[]) {
  const rows = new Map<string, ReportAccountRecord>();
  for (const account of seed) {
    rows.set(account.id, {
      id: account.id,
      label: account.label,
      status: account.status ?? "active",
      hitAt: account.hitAt ?? null,
      lastState: account.lastState ?? null,
      lastError: account.lastError ?? null,
    });
  }
  let schedule: ReportScheduleRecord = {
    providerId: "cb",
    enabled: false,
    accountsPerRun: 5,
    intervalMinutes: 60,
    lastRunAt: null,
  };
  const ordered = (): ReportAccountRecord[] =>
    [...rows.values()].sort((left, right) => {
      if (left.hitAt === null && right.hitAt === null) return left.id.localeCompare(right.id);
      if (left.hitAt === null) return -1;
      if (right.hitAt === null) return 1;
      return left.hitAt.getTime() - right.hitAt.getTime();
    });

  const matchesStatus = (row: ReportAccountRecord, status: ReportAccountStatus): boolean => {
    if (status === "hit") return row.hitAt !== null;
    if (status === "failed") return row.hitAt === null && row.lastState === "error";
    if (status === "pending") return row.hitAt === null && row.lastState !== "error";
    return true;
  };

  const store: ReportStorePort = {
    async listAccounts(_tenantId, _providerId, limit, status) {
      return ordered().filter((row) => matchesStatus(row, status)).slice(0, limit);
    },
    async countAccounts(): Promise<ReportCounts> {
      const all = [...rows.values()];
      const hit = all.filter((row) => row.hitAt !== null).length;
      const failed = all.filter((row) => row.hitAt === null && row.lastState === "error").length;
      return { total: all.length, hit, failed, pending: all.length - hit - failed };
    },
    async pickUnhitAccounts(args): Promise<readonly ReportPickRecord[]> {
      return ordered()
        .filter((row) => row.hitAt === null || row.hitAt.getTime() < args.dayStart.getTime())
        .slice(0, args.limit)
        .map((row) => ({ id: row.id, label: row.label }));
    },
    async recordHit(args) {
      const existing = rows.get(args.accountId);
      if (existing === undefined) return;
      rows.set(args.accountId, {
        ...existing,
        hitAt: args.state === "reported" ? args.at : existing.hitAt,
        lastState: args.state,
        lastError: args.error,
      });
    },
    async readSchedule() {
      return schedule;
    },
    async saveSchedule(args) {
      schedule = {
        providerId: args.providerId,
        enabled: args.enabled,
        accountsPerRun: args.accountsPerRun,
        intervalMinutes: args.intervalMinutes,
        lastRunAt: schedule.lastRunAt,
      };
      return schedule;
    },
    async listDueSchedules() {
      return schedule.enabled ? [schedule] : [];
    },
    async markScheduleRun(_providerId, at) {
      schedule = { ...schedule, lastRunAt: at };
    },
  };
  return { store, rows };
}

/** A JWT whose payload carries a `sub`, which is all `buddyAccountUid` reads. */
function fakeJwt(sub: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub })}.signature`;
}

function app(
  access: AccessDecision | undefined,
  seed: readonly SeedAccount[],
  options: {
    readonly credential?: string;
    readonly fetcher?: typeof fetch;
    readonly now?: () => Date;
  } = {},
) {
  const { store, rows } = memoryStore(seed);
  const routes = createReportRoutes({
    store,
    accessResolver: () => access,
    resolveCredential: async () => options.credential ?? fakeJwt("uid-1"),
    // The sequential gap is real behaviour; tests must not pay it.
    sleep: async () => undefined,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { routes, store, rows };
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const okUpstream = (async () =>
  new Response(JSON.stringify({ code: 0, data: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

describe("automation report routes", () => {
  test("401s without an access decision", async () => {
    const { routes } = app(undefined, []);
    const response = await routes.handle(new Request("http://localhost/automation/report/accounts"));
    expect(response.status).toBe(401);
  });

  test("counts hit and never-hit accounts and orders never-hit first", async () => {
    const now = new Date("2026-10-27T12:00:00.000Z");
    const { routes } = app(readOnly, [
      { id: "a-hit-old", label: "old", hitAt: new Date("2026-10-01T00:00:00.000Z") },
      { id: "b-never", label: "never" },
      { id: "c-hit-new", label: "new", hitAt: new Date("2026-10-20T00:00:00.000Z") },
      { id: "d-error", label: "broken", lastState: "error", lastError: "401" },
    ], { now: () => now });

    const response = await routes.handle(
      new Request("http://localhost/automation/report/accounts?providerId=cb"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      providerId: string;
      counts: { total: number; hit: number; pending: number; failed: number };
      accounts: Array<{ id: string; hitAt: string | null; lastState: string | null }>;
      schedule: { enabled: boolean; accountsPerRun: number; intervalMinutes: number };
    };

    expect(body.providerId).toBe("cb");
    expect(body.counts).toEqual({ total: 4, hit: 2, pending: 1, failed: 1 });
    expect(body.accounts.map((row) => row.id)).toEqual([
      "b-never",
      "d-error",
      "a-hit-old",
      "c-hit-new",
    ]);
    expect(body.accounts[0]?.hitAt).toBeNull();
    expect(body.accounts[2]?.hitAt).toBe("2026-10-01T00:00:00.000Z");
    expect(body.schedule).toEqual({ enabled: false, accountsPerRun: 5, intervalMinutes: 60 });
  });

  test("hit skips accounts already reported today and honours limit", async () => {
    const now = new Date("2026-10-27T12:00:00.000Z");
    const { routes, rows } = app(readWrite, [
      // Already reported today: must not be touched again.
      { id: "a-today", label: "today", hitAt: new Date("2026-10-27T08:00:00.000Z") },
      { id: "b-never", label: "never" },
      { id: "c-yesterday", label: "yesterday", hitAt: new Date("2026-10-26T08:00:00.000Z") },
      { id: "d-never2", label: "never2" },
    ], { fetcher: okUpstream, now: () => now });

    const response = await routes.handle(
      jsonRequest("/automation/report/hit", "POST", { providerId: "cb", limit: 2 }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      attempted: number;
      succeeded: number;
      failed: number;
      results: Array<{ accountId: string; state: string }>;
    };

    expect(body.attempted).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    // Never-hit accounts first, then oldest hit — the same order the list uses.
    expect(body.results.map((result) => result.accountId)).toEqual(["b-never", "d-never2"]);
    expect(rows.get("a-today")?.hitAt?.toISOString()).toBe("2026-10-27T08:00:00.000Z");
    expect(rows.get("b-never")?.hitAt?.toISOString()).toBe("2026-10-27T12:00:00.000Z");
    // Both picks were reported; the accounts outside the limit are untouched.
    expect(rows.get("d-never2")?.hitAt?.toISOString()).toBe("2026-10-27T12:00:00.000Z");
    expect(rows.get("c-yesterday")?.hitAt?.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  test("an upstream failure records lastState error without marking the account hit", async () => {
    const now = new Date("2026-10-27T12:00:00.000Z");
    const failing = (async () =>
      new Response(JSON.stringify({ code: 5001, message: "risk control" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const { routes, rows } = app(readWrite, [{ id: "a-1", label: "one" }], {
      fetcher: failing,
      now: () => now,
    });

    const response = await routes.handle(
      jsonRequest("/automation/report/hit", "POST", { providerId: "cb", limit: 1 }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      succeeded: number;
      failed: number;
      results: Array<{ accountId: string; state: string; error: string | null }>;
    };

    expect(body.ok).toBe(false);
    expect(body.failed).toBe(1);
    expect(body.results[0]?.state).toBe("error");
    expect(body.results[0]?.error).toContain("5001");

    const row = rows.get("a-1");
    expect(row?.lastState).toBe("error");
    expect(row?.hitAt).toBeNull();
    expect(row?.lastError).toContain("5001");
  });

  test("a credential with no uid fails closed instead of reporting", async () => {
    const { routes, rows } = app(readWrite, [{ id: "a-key", label: "api-key" }], {
      credential: "sk-opaque-api-key",
    });
    const response = await routes.handle(
      jsonRequest("/automation/report/hit", "POST", { providerId: "cb", limit: 1 }),
    );
    const body = (await response.json()) as { failed: number; results: Array<{ error: string }> };
    expect(body.failed).toBe(1);
    expect(body.results[0]?.error).toContain("uid");
    expect(rows.get("a-key")?.hitAt).toBeNull();
  });

  test("schedule validation rejects out-of-range values", async () => {
    const { routes } = app(readWrite, []);
    const cases: Array<Record<string, unknown>> = [
      { providerId: "cb", enabled: true, accountsPerRun: 0, intervalMinutes: 60 },
      { providerId: "cb", enabled: true, accountsPerRun: 101, intervalMinutes: 60 },
      { providerId: "cb", enabled: true, accountsPerRun: 5, intervalMinutes: 14 },
      { providerId: "cb", enabled: true, accountsPerRun: 5, intervalMinutes: 1441 },
      { providerId: "cb", enabled: "yes", accountsPerRun: 5, intervalMinutes: 60 },
      { providerId: "cb", enabled: true, accountsPerRun: 2.5, intervalMinutes: 60 },
    ];
    for (const body of cases) {
      const response = await routes.handle(
        jsonRequest("/automation/report/schedule", "PUT", body),
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { code: string };
      expect(payload.code).toBe("invalid_request");
    }
  });

  test("saves and reads back a valid schedule", async () => {
    const { routes } = app(readWrite, []);
    const saved = await routes.handle(
      jsonRequest("/automation/report/schedule", "PUT", {
        providerId: "cb",
        enabled: true,
        accountsPerRun: 12,
        intervalMinutes: 90,
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      providerId: "cb",
      enabled: true,
      accountsPerRun: 12,
      intervalMinutes: 90,
    });

    const read = await routes.handle(
      new Request("http://localhost/automation/report/schedule?providerId=cb"),
    );
    expect(await read.json()).toEqual({
      providerId: "cb",
      enabled: true,
      accountsPerRun: 12,
      intervalMinutes: 90,
    });
  });

  test("rejects a provider outside the buddy family", async () => {
    const { routes } = app(readWrite, []);
    const list = await routes.handle(
      new Request("http://localhost/automation/report/accounts?providerId=openai"),
    );
    expect(list.status).toBe(400);
    const listBody = (await list.json()) as { code: string };
    expect(listBody.code).toBe("invalid_request");

    const hit = await routes.handle(
      jsonRequest("/automation/report/hit", "POST", { providerId: "openai", limit: 1 }),
    );
    expect(hit.status).toBe(400);

    const schedule = await routes.handle(
      jsonRequest("/automation/report/schedule", "PUT", {
        providerId: "openai",
        enabled: true,
        accountsPerRun: 5,
        intervalMinutes: 60,
      }),
    );
    expect(schedule.status).toBe(400);
  });

  test("filters the account page by hit state while counts stay global", async () => {
    const { routes } = app(readOnly, [
      { id: "a-hit", label: "hit", hitAt: new Date("2026-10-20T00:00:00.000Z") },
      { id: "b-failed", label: "failed", lastState: "error", lastError: "401" },
      { id: "c-never", label: "never" },
    ]);
    const read = async (status?: string) => {
      const query = status === undefined ? "" : `&status=${status}`;
      const response = await routes.handle(
        new Request(`http://localhost/automation/report/accounts?providerId=cb${query}`),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        counts: { total: number; hit: number; pending: number; failed: number };
        accounts: Array<{ id: string }>;
      };
    };

    const all = await read();
    expect(all.accounts.map((row) => row.id)).toEqual(["b-failed", "c-never", "a-hit"]);

    const pending = await read("pending");
    expect(pending.accounts.map((row) => row.id)).toEqual(["c-never"]);

    const hit = await read("hit");
    expect(hit.accounts.map((row) => row.id)).toEqual(["a-hit"]);

    const failed = await read("failed");
    expect(failed.accounts.map((row) => row.id)).toEqual(["b-failed"]);

    // The stat tiles describe the provider, not the current filter.
    for (const body of [all, pending, hit, failed]) {
      expect(body.counts).toEqual({ total: 3, hit: 1, failed: 1, pending: 1 });
    }
  });

  test("rejects an unrecognised status filter", async () => {
    const { routes } = app(readOnly, []);
    const response = await routes.handle(
      new Request("http://localhost/automation/report/accounts?providerId=cb&status=bogus"),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("invalid_request");
  });

  test("defaults the provider to cb when the query omits it", async () => {
    const { routes } = app(readOnly, [{ id: "a-1", label: "one" }]);
    const response = await routes.handle(new Request("http://localhost/automation/report/accounts"));
    const body = (await response.json()) as { providerId: string };
    expect(body.providerId).toBe("cb");
  });

  test("a read-only decision cannot fire a hit run", async () => {
    const { routes, rows } = app(readOnly, [{ id: "a-1", label: "one" }], { fetcher: okUpstream });
    const response = await routes.handle(
      jsonRequest("/automation/report/hit", "POST", { providerId: "cb", limit: 1 }),
    );
    expect(response.status).toBe(403);
    expect(rows.get("a-1")?.hitAt).toBeNull();
  });
});

dbDescribe("DrizzleReportStore — tenant predicate", () => {
  const providerId = `report-test-${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const globalAccountId = randomUUID();
  const tenantAccountId = randomUUID();
  let db: LianRouterDatabase;

  beforeAll(async () => {
    db = getDb();
    await db.insert(providers).values({ id: providerId, tenantId: null, enabled: true });
    await db.insert(tenants).values({ id: tenantId, name: `report-test-${tenantId}`, status: "active" });
    await db.insert(providerAccounts).values([
      {
        id: globalAccountId,
        // Global pool account: visible to every tenant, which is the shape
        // almost every `cb` account has in this deployment.
        tenantId: null,
        providerId,
        label: "global",
        credentialKind: "oauth",
        status: "active",
      },
      {
        id: tenantAccountId,
        tenantId,
        providerId,
        label: "tenant-owned",
        credentialKind: "oauth",
        status: "active",
      },
    ]);
  });

  afterAll(async () => {
    if (db === undefined) return;
    await db.delete(providerAccounts).where(inArray(providerAccounts.id, [globalAccountId, tenantAccountId]));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("lists, counts and picks a global (tenant_id null) account for a tenant", async () => {
    const store = new DrizzleReportStore(db);

    const listed = await store.listAccounts(tenantId, providerId, 10, "all");
    expect(listed.map((row) => row.id).sort()).toEqual([globalAccountId, tenantAccountId].sort());

    const counts = await store.countAccounts(tenantId, providerId);
    expect(counts).toEqual({ total: 2, hit: 0, failed: 0, pending: 2 });

    const picked = await store.pickUnhitAccounts({
      tenantId,
      providerId,
      limit: 10,
      dayStart: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(picked.map((row) => row.id).sort()).toEqual([globalAccountId, tenantAccountId].sort());

    // The sweep passes null and stays tenant-wide: both accounts, global included.
    const swept = await store.pickUnhitAccounts({
      tenantId: null,
      providerId,
      limit: 10,
      dayStart: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(swept.map((row) => row.id).sort()).toEqual([globalAccountId, tenantAccountId].sort());
  });

  test("filters by hit state on the real predicates", async () => {
    const store = new DrizzleReportStore(db);
    await db.insert(providerReportHits).values([
      {
        accountId: globalAccountId,
        providerId,
        hitAt: new Date("2026-10-20T00:00:00.000Z"),
        hitCount: 1,
        lastState: "reported",
      },
      {
        accountId: tenantAccountId,
        providerId,
        hitAt: null,
        hitCount: 0,
        lastState: "error",
        lastError: "401",
      },
    ]);

    const ids = async (status: "all" | "pending" | "hit" | "failed") =>
      (await store.listAccounts(tenantId, providerId, 10, status)).map((row) => row.id);

    expect(await ids("all")).toEqual([tenantAccountId, globalAccountId]);
    expect(await ids("hit")).toEqual([globalAccountId]);
    expect(await ids("failed")).toEqual([tenantAccountId]);
    expect(await ids("pending")).toEqual([]);
  });
});
