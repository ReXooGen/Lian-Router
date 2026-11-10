import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import {
  models,
  providerAccountAppeals,
  providerAccounts,
  providers,
  tenants,
} from "../../../src/persistence/schema";
import { dbDescribe } from "../../helpers/db-gate";
import type { AccessDecision } from "../../../src/security/access-control";
import type {
  AppealAccountRecord,
  AppealCounts,
  AppealPickRecord,
  AppealStorePort,
  AppealVerdict,
  AppealVerdictCandidate,
} from "../../../src/console/automation/appeal/contracts";
import { createAppealRoutes } from "../../../src/console/automation/appeal/routes";
import { DrizzleAppealStore } from "../../../src/console/automation/appeal/store";
import { runAppealRecheck } from "../../../src/console/automation/appeal/service";
import { recoverAccount } from "../../../src/providers/operations/account-health-service";

const NOW = new Date("2026-10-28T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const readWrite: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
  admissionIdentity: "key-1",
};

interface SeedRow {
  readonly id: string;
  readonly label: string;
  readonly appealedAt: Date | null;
  readonly verdict?: AppealVerdict | null;
}

/**
 * In-memory double over the appeal store. It reproduces the one rule the
 * recheck depends on — only acknowledged, undecided appeals are picked, oldest
 * first — because a double that returned whatever the test wanted would prove
 * nothing about the pass.
 */
function memoryStore(seed: readonly SeedRow[]) {
  const rows = new Map<string, AppealAccountRecord>();
  for (const row of seed) {
    rows.set(row.id, {
      id: row.id,
      label: row.label,
      status: "disabled",
      lastError: "banned",
      lastErrorAt: NOW,
      appealedAt: row.appealedAt,
      appealCount: row.appealedAt === null ? 0 : 1,
      feedbackId: null,
      lastState: row.appealedAt === null ? null : "appealed",
      lastAppealError: null,
      verdict: row.verdict ?? null,
      verdictCheckedAt: null,
    });
  }
  const verdictWrites: Array<{ accountId: string; verdict: AppealVerdict }> = [];
  const store: AppealStorePort = {
    async listAccounts(args): Promise<readonly AppealAccountRecord[]> {
      return [...rows.values()]
        .filter((row) => {
          if (args.status === "accepted" || args.status === "declined") return row.verdict === args.status;
          if (args.status === "appealed") return row.appealedAt !== null;
          return true;
        })
        .slice(0, args.limit);
    },
    async countAccounts(): Promise<AppealCounts> {
      const all = [...rows.values()];
      return {
        total: all.length,
        appealed: all.filter((row) => row.appealedAt !== null).length,
        failed: 0,
        pending: all.filter((row) => row.appealedAt === null).length,
        accepted: all.filter((row) => row.verdict === "accepted").length,
        declined: all.filter((row) => row.verdict === "declined").length,
      };
    },
    async pickBannedAccounts(): Promise<readonly AppealPickRecord[]> {
      return [];
    },
    async recordAppeal(): Promise<void> {},
    async readLastAppealedAt(accountId: string): Promise<Date | null> {
      return rows.get(accountId)?.appealedAt ?? null;
    },
    async pickAwaitingVerdict(args): Promise<readonly AppealVerdictCandidate[]> {
      return [...rows.values()]
        .filter((row) => row.appealedAt !== null && row.verdict === null)
        .sort((left, right) => left.appealedAt!.getTime() - right.appealedAt!.getTime())
        .slice(0, args.limit)
        .map((row) => ({ id: row.id, label: row.label, appealedAt: row.appealedAt! }));
    },
    async recordVerdict(args): Promise<void> {
      const row = rows.get(args.accountId);
      if (row !== undefined) {
        rows.set(args.accountId, { ...row, verdict: args.verdict, verdictCheckedAt: args.at });
      }
      verdictWrites.push({ accountId: args.accountId, verdict: args.verdict });
    },
    async defaultProbeModelId(): Promise<string | null> {
      return "glm-5.3";
    },
  };
  return { store, rows, verdictWrites };
}

function routesFor(args: {
  store: AppealStorePort;
  probe: (input: { accountId: string; modelId: string }) => Promise<{
    ok: boolean;
    statusCode?: number;
    error?: string;
  }>;
  recovered?: string[];
}) {
  return createAppealRoutes({
    store: args.store,
    accessResolver: () => readWrite,
    resolveCredential: async () => "unused",
    probeAccount: (input) => args.probe(input),
    recoverAccount: async (accountId) => {
      args.recovered?.push(accountId);
    },
    now: () => NOW,
  });
}

/** The HTTP surface the route factory returns, narrowed to what these tests call. */
interface RecheckEndpoint {
  handle(request: Request): Promise<Response>;
}

function recheck(routes: RecheckEndpoint, body: Record<string, unknown>) {
  return routes.handle(
    new Request("http://localhost/automation/appeal/recheck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("appeal recheck", () => {
  test("a successful probe marks the appeal accepted and recovers the account", async () => {
    const { store, rows, verdictWrites } = memoryStore([
      { id: "acct-ok", label: "works again", appealedAt: new Date(NOW.getTime() - 2 * HOUR) },
    ]);
    const recovered: string[] = [];
    const response = await recheck(
      routesFor({ store, probe: async () => ({ ok: true }), recovered }),
      { providerId: "cb", limit: 10 },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attempted: 1,
      accepted: 1,
      declined: 0,
      pending: 0,
      results: [{ accountId: "acct-ok", verdict: "accepted", error: null }],
    });
    expect(verdictWrites).toEqual([{ accountId: "acct-ok", verdict: "accepted" }]);
    expect(rows.get("acct-ok")?.verdict).toBe("accepted");
    expect(recovered).toEqual(["acct-ok"]);
  });

  test("a still-restricted probe past the review window marks the appeal declined", async () => {
    const { store, rows } = memoryStore([
      {
        id: "acct-old",
        label: "appealed long ago",
        appealedAt: new Date(NOW.getTime() - 25 * HOUR),
      },
    ]);
    const recovered: string[] = [];
    const response = await recheck(
      routesFor({
        store,
        probe: async () => ({
          ok: false,
          statusCode: 403,
          error: "cb/glm-5.3 via chat /chat/completions — request illegal (upstream 403)",
        }),
        recovered,
      }),
      { providerId: "cb", limit: 10 },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ declined: 1, pending: 0, accepted: 0 });
    expect(rows.get("acct-old")?.verdict).toBe("declined");
    expect(recovered).toEqual([]);
  });

  test("a still-restricted probe inside the review window stays pending with no verdict", async () => {
    const { store, rows, verdictWrites } = memoryStore([
      { id: "acct-new", label: "fresh appeal", appealedAt: new Date(NOW.getTime() - 2 * HOUR) },
    ]);
    const response = await recheck(
      routesFor({
        store,
        probe: async () => ({ ok: false, statusCode: 403, error: "request illegal (upstream 403)" }),
      }),
      { providerId: "cb", limit: 10 },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pending: 1, declined: 0 });
    expect(rows.get("acct-new")?.verdict).toBeNull();
    expect(verdictWrites).toEqual([]);
  });

  test("a transport failure stays pending and writes nothing", async () => {
    const { store, rows, verdictWrites } = memoryStore([
      {
        id: "acct-net",
        label: "network failed",
        appealedAt: new Date(NOW.getTime() - 30 * HOUR),
      },
    ]);
    const response = await recheck(
      routesFor({
        store,
        probe: async () => ({ ok: false, error: "connect ECONNREFUSED 203.0.113.9:443" }),
      }),
      { providerId: "cb", limit: 10 },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pending: 1, declined: 0, accepted: 0 });
    expect(rows.get("acct-net")?.verdict).toBeNull();
    expect(verdictWrites).toEqual([]);
  });

  test("only undecided appeals are picked, oldest first, up to the limit", async () => {
    const { store } = memoryStore([
      { id: "oldest", label: "a", appealedAt: new Date(NOW.getTime() - 40 * HOUR) },
      { id: "middle", label: "b", appealedAt: new Date(NOW.getTime() - 30 * HOUR) },
      { id: "newest", label: "c", appealedAt: new Date(NOW.getTime() - 2 * HOUR) },
      { id: "decided", label: "d", appealedAt: new Date(NOW.getTime() - 50 * HOUR), verdict: "declined" },
      { id: "unappealed", label: "e", appealedAt: null },
    ]);
    const probed: string[] = [];
    const response = await recheck(
      routesFor({
        store,
        probe: async ({ accountId }) => {
          probed.push(accountId);
          return { ok: false, error: "connect ECONNREFUSED" };
        },
      }),
      { providerId: "cb", limit: 2 },
    );

    expect(await response.json()).toMatchObject({ attempted: 2 });
    expect(probed).toEqual(["oldest", "middle"]);
  });

  test("no model available for the probe is a 400", async () => {
    const { store } = memoryStore([]);
    const routes = createAppealRoutes({
      store: { ...store, defaultProbeModelId: async () => null },
      accessResolver: () => readWrite,
      resolveCredential: async () => "unused",
      probeAccount: async () => ({ ok: true }),
      recoverAccount: async () => {},
      now: () => NOW,
    });
    const response = await recheck(routes, { providerId: "cb", limit: 10 });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });
});

dbDescribe("appeal verdict persistence", () => {
  const tenantId = randomUUID();
  const providerId = `appeal-verdict-${randomUUID().slice(0, 8)}`;
  const acceptedId = randomUUID();
  const declinedId = randomUUID();
  const pendingId = randomUUID();
  const freshId = randomUUID();
  const unappealedId = randomUUID();
  let db: LianRouterDatabase;
  let store: DrizzleAppealStore;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleAppealStore(db);
    await db.insert(tenants).values({
      id: tenantId,
      name: `appeal-verdict-${tenantId}`,
      status: "active",
    });
    await db.insert(providers).values({ id: providerId, requiresAccount: true });
    await db.insert(models).values({
      providerId,
      modelId: "glm-5.3",
      wireFamily: "chat",
      endpointPath: "/chat/completions",
      enabled: true,
    });
    await db.insert(providerAccounts).values(
      [acceptedId, declinedId, pendingId, freshId, unappealedId].map((id, index) => ({
        id,
        providerId,
        label: `account-${index}`,
        credentialKind: "oauth" as const,
        status: "disabled" as const,
        lastErrorCategory: "policy_blocked_banned",
        lastError: "Account banned by upstream: request illegal",
        lastErrorAt: NOW,
        cooldownUntil: new Date(NOW.getTime() + HOUR),
      })),
    );
    const older = new Date(NOW.getTime() - 30 * HOUR);
    await db.insert(providerAccountAppeals).values([
      { accountId: acceptedId, providerId, appealedAt: older, lastState: "appealed", verdict: "accepted" },
      { accountId: declinedId, providerId, appealedAt: older, lastState: "appealed", verdict: "declined" },
      { accountId: pendingId, providerId, appealedAt: older, lastState: "appealed" },
      { accountId: freshId, providerId, appealedAt: new Date(NOW.getTime() - HOUR), lastState: "appealed" },
      { accountId: unappealedId, providerId, appealedAt: null, lastState: "error" },
    ]);
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("counts and list filters separate accepted from declined", async () => {
    const counts = await store.countAccounts({ tenantId, providerId });
    expect(counts).toMatchObject({ total: 5, appealed: 4, accepted: 1, declined: 1 });

    const accepted = await store.listAccounts({ tenantId, providerId, limit: 10, status: "accepted" });
    const declined = await store.listAccounts({ tenantId, providerId, limit: 10, status: "declined" });
    expect(accepted.map((row) => row.id)).toEqual([acceptedId]);
    expect(declined.map((row) => row.id)).toEqual([declinedId]);
  });

  test("pickAwaitingVerdict returns only undecided acknowledged appeals, oldest first", async () => {
    const page = await store.pickAwaitingVerdict({ tenantId, providerId, limit: 10 });
    expect(page.map((row) => row.id)).toEqual([pendingId, freshId]);
    const limited = await store.pickAwaitingVerdict({ tenantId, providerId, limit: 1 });
    expect(limited.map((row) => row.id)).toEqual([pendingId]);
  });

  test("an accepted verdict recovers the banned account", async () => {
    const response = await runAppealRecheck({
      deps: {
        store,
        accessResolver: () => readWrite,
        resolveCredential: async () => "unused",
        probeAccount: async ({ accountId }) =>
          accountId === freshId ? { ok: false, error: "connect ECONNREFUSED" } : { ok: true },
        recoverAccount: async (accountId) => {
          await recoverAccount(db, accountId, "appeal_accepted");
        },
        now: () => NOW,
      },
      providerId,
      tenantId,
      modelId: "glm-5.3",
      limit: 10,
    });

    expect(response).toMatchObject({ attempted: 2, accepted: 1, declined: 0, pending: 1 });

    const [recovered] = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, pendingId));
    expect(recovered?.status).toBe("active");
    expect(recovered?.lastError).toBeNull();
    expect(recovered?.lastErrorCategory).toBeNull();
    expect(recovered?.lastErrorAt).toBeNull();
    expect(recovered?.cooldownUntil).toBeNull();

    const [verdictRow] = await db
      .select()
      .from(providerAccountAppeals)
      .where(eq(providerAccountAppeals.accountId, pendingId));
    expect(verdictRow?.verdict).toBe("accepted");
    expect(verdictRow?.verdictCheckedAt).not.toBeNull();
  });
});
