import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { apiKeys, telemetryEvents, tenants } from "../../../src/persistence/schema";
import { DrizzleObservabilityStore } from "../../../src/console/domains/stats/store";
import {
  createObservabilityRoutes,
  type ObservabilityStore,
} from "../../../src/console/domains/stats/contracts";
import type { AccessDecision } from "../../../src/security/access-control";
import { dbDescribe } from "../../helpers/db-gate";

const tenantId = randomUUID();
const templateA = randomUUID();
const templateB = randomUUID();
const childA1 = randomUUID();
const childA2 = randomUUID();
const childB1 = randomUUID();
const personalKeyId = randomUUID();

const requestA1 = randomUUID();
const requestA2 = randomUUID();
const requestB1 = randomUUID();
const requestPersonal = randomUUID();
const requestKeyless = randomUUID();

// The route reads the tenant off the access decision, so the fixture must be
// the seeded tenant or every scope predicate would match nothing.
const access: AccessDecision = {
  id: "test-session",
  tenantId,
  scopes: ["dashboard:read"],
  admissionIdentity: "test-session",
};

const sorted = (values: readonly string[]): string[] => [...values].sort();

dbDescribe("usage requests key filters", () => {
  let db: LianRouterDatabase;
  let store: DrizzleObservabilityStore;

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleObservabilityStore(
      db,
      { ping: async () => "PONG" } as unknown as ConstructorParameters<typeof DrizzleObservabilityStore>[1],
    );
    await db.insert(tenants).values({
      id: tenantId,
      name: `usage-request-filters-${tenantId}`,
      status: "active",
    });
    await db.insert(apiKeys).values([
      { id: templateA, tenantId, keyMode: "share", label: "template A", scopes: ["routing:invoke"] },
      { id: templateB, tenantId, keyMode: "share", label: "template B", scopes: ["routing:invoke"] },
      { id: personalKeyId, tenantId, keyHash: `hash-${personalKeyId}`, keyMode: "personal", label: "personal", scopes: ["routing:invoke"] },
    ]);
    await db.insert(apiKeys).values([
      {
        id: childA1, tenantId, keyHash: `hash-${childA1}`, keyMode: "share", parentKeyId: templateA,
        issuedClientIp: "198.51.100.1", issuedClientIpKey: "v4:1",
        label: "child A1", scopes: ["routing:invoke"],
      },
      {
        id: childA2, tenantId, keyHash: `hash-${childA2}`, keyMode: "share", parentKeyId: templateA,
        issuedClientIp: "198.51.100.2", issuedClientIpKey: "v4:2",
        label: "child A2", scopes: ["routing:invoke"],
      },
      {
        id: childB1, tenantId, keyHash: `hash-${childB1}`, keyMode: "share", parentKeyId: templateB,
        issuedClientIp: "198.51.100.3", issuedClientIpKey: "v4:3",
        label: "child B1", scopes: ["routing:invoke"],
      },
    ]);
    await db.insert(telemetryEvents).values([
      {
        tenantId, requestId: requestA1, sourceSurface: "chat", requestedModel: "test-model",
        providerId: "openai", apiKeyId: childA1, status: "completed", httpStatus: 200,
      },
      {
        tenantId, requestId: requestA2, sourceSurface: "chat", requestedModel: "test-model",
        providerId: "openai", apiKeyId: childA2, status: "completed", httpStatus: 200,
      },
      {
        tenantId, requestId: requestB1, sourceSurface: "chat", requestedModel: "test-model",
        providerId: "openai", apiKeyId: childB1, status: "completed", httpStatus: 200,
      },
      {
        tenantId, requestId: requestPersonal, sourceSurface: "chat", requestedModel: "test-model",
        providerId: "openai", apiKeyId: personalKeyId, status: "completed", httpStatus: 200,
      },
      {
        tenantId, requestId: requestKeyless, sourceSurface: "chat", requestedModel: "test-model",
        providerId: "openai", status: "completed", httpStatus: 200,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("childKeyId returns only that key's rows", async () => {
    const page = await store.usageRequests(
      tenantId, "24h", 50, undefined, undefined, undefined, childA1,
    );
    expect(sorted(page.items.map((item) => item.requestId))).toEqual(sorted([requestA1]));
  });

  test("parentKeyId returns every child of that template and nothing else", async () => {
    const page = await store.usageRequests(
      tenantId, "24h", 50, undefined, undefined, templateA,
    );
    // child A1 + A2 yes; the sibling template's child, the personal key and the
    // keyless event no.
    expect(sorted(page.items.map((item) => item.requestId))).toEqual(
      sorted([requestA1, requestA2]),
    );
  });

  test("parentKeyId + childKeyId narrows to the child, which wins", async () => {
    const page = await store.usageRequests(
      tenantId, "24h", 50, undefined, undefined, templateB, childA1,
    );
    expect(sorted(page.items.map((item) => item.requestId))).toEqual(sorted([requestA1]));
  });

  test("shared=false still excludes child traffic when composed with no key filter", async () => {
    const page = await store.usageRequests(tenantId, "24h", 50, undefined, false);
    expect(sorted(page.items.map((item) => item.requestId))).toEqual(
      sorted([requestPersonal, requestKeyless]),
    );
  });

  test("absent filters behave exactly as the unfiltered path", async () => {
    const unfiltered = await store.usageRequests(tenantId, "24h", 50);
    const app = createObservabilityRoutes({
      store,
      accessResolver: () => access,
    });
    const response = await app.handle(
      new Request("http://localhost/system/usage/requests?period=24h&limit=50&parentKeyId=&childKeyId=%20"),
    );
    const blank = (await response.json()) as { items: Array<{ requestId: string }> };
    const expected = sorted([
      requestA1, requestA2, requestB1, requestPersonal, requestKeyless,
    ]);
    expect(response.status).toBe(200);
    expect(sorted(unfiltered.items.map((item) => item.requestId))).toEqual(expected);
    expect(sorted(blank.items.map((item) => item.requestId))).toEqual(expected);
  });
});

describe("usage request key filter validation", () => {
  const calls: unknown[][] = [];
  const store = {
    async usageRequests(...args: unknown[]) {
      calls.push(args);
      return { items: [] };
    },
  } as unknown as ObservabilityStore;
  const app = createObservabilityRoutes({ store, accessResolver: () => access });

  const request = (query: string): Promise<Response> =>
    app.handle(new Request(`http://localhost/system/usage/requests?${query}`));

  test("shared=false with parentKeyId is rejected as invalid_request", async () => {
    const before = calls.length;
    const response = await request(`period=24h&shared=false&parentKeyId=${randomUUID()}`);
    expect(response.status).toBe(400);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "invalid_request" });
    expect(calls.length).toBe(before);
  });

  test("an over-long id is rejected as invalid_request", async () => {
    const before = calls.length;
    const response = await request(`period=24h&childKeyId=${"x".repeat(129)}`);
    expect(response.status).toBe(400);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "invalid_request" });
    expect(calls.length).toBe(before);
  });

  test("blank ids reach the store as no filter", async () => {
    calls.length = 0;
    const response = await request(
      `period=24h&limit=50&parentKeyId=${encodeURIComponent("   ")}&childKeyId=`,
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(-2)).toEqual([undefined, undefined]);
  });
});
