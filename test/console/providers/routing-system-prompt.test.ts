import { afterAll, beforeAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type LianRouterDatabase } from "../../../src/persistence/postgres";
import { providers, providerRoutingSettings, tenants } from "../../../src/persistence/schema";
import { dbDescribe } from "../../helpers/db-gate";
import { DrizzleProviderDetailStore } from "../../../src/console/providers/detail/store";
import { createProviderDetailRoutes } from "../../../src/console/providers/detail/routes";
import { MAX_PROVIDER_SYSTEM_PROMPT } from "../../../src/console/providers/catalog/contracts";
import type { AccessDecision } from "../../../src/security/access-control";

// The routing PATCH is the only way an operator sets a system prompt, and the
// store is the only writer of the column. These cases drive the real route
// against the real store so the wire contract — validation, normalization, and
// what a read returns afterwards — is exercised end to end rather than through
// a store double.
dbDescribe("provider routing PATCH — system prompt", () => {
  let db: LianRouterDatabase;
  const tenantId = randomUUID();
  const providerId = `routing-prompt-${randomUUID().slice(0, 8)}`;

  function access(tenant: string | null = tenantId): AccessDecision {
    return {
      id: "operator-1",
      tenantId: tenant,
      scopes: ["dashboard:read", "dashboard:write"],
      admissionIdentity: "operator-1",
    };
  }

  function app(): Elysia {
    return new Elysia().use(
      createProviderDetailRoutes({
        store: new DrizzleProviderDetailStore(db),
        accessResolver: () => access(),
      }),
    );
  }

  async function patch(body: unknown): Promise<Response> {
    return app().handle(
      new Request(`http://localhost/providers/${providerId}/routing`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async function read(): Promise<Record<string, unknown>> {
    const response = await app().handle(
      new Request(`http://localhost/providers/${providerId}/routing`),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  beforeAll(async () => {
    db = getDb();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "routing-prompt-test", status: "active" })
      .onConflictDoNothing();
    await db.insert(providers).values({ id: providerId, tenantId, enabled: true });
  });

  afterAll(async () => {
    await db
      .delete(providerRoutingSettings)
      .where(eq(providerRoutingSettings.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  test("stores a trimmed prompt and returns it on the next read", async () => {
    const response = await patch({ systemPrompt: "  be brief  " });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>)["systemPrompt"]).toBe("be brief");
    expect((await read())["systemPrompt"]).toBe("be brief");
  });

  test("an empty string clears the prompt rather than storing a blank", async () => {
    await patch({ systemPrompt: "temporary" });
    expect((await read())["systemPrompt"]).toBe("temporary");

    const cleared = await patch({ systemPrompt: "" });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as Record<string, unknown>)["systemPrompt"]).toBeNull();
    expect((await read())["systemPrompt"]).toBeNull();
  });

  test("an explicit null clears the prompt", async () => {
    await patch({ systemPrompt: "temporary" });
    const cleared = await patch({ systemPrompt: null });
    expect(cleared.status).toBe(200);
    expect((await read())["systemPrompt"]).toBeNull();
  });

  test("rejects a prompt past the ceiling instead of truncating it", async () => {
    const response = await patch({ systemPrompt: "x".repeat(MAX_PROVIDER_SYSTEM_PROMPT + 1) });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    // The code is the machine-readable contract; the message is prose.
    expect(body["code"]).toBe("invalid_system_prompt");
    // Truncating would silently send a half-sentence instruction, so the
    // operator has to see that the text did not fit.
    expect(String(body["error"])).toContain(String(MAX_PROVIDER_SYSTEM_PROMPT));
  });

  test("a patch that omits the prompt leaves the stored one alone", async () => {
    await patch({ systemPrompt: "keep me" });
    // An unrelated routing edit: `undefined` must mean "unchanged", not "clear".
    const strategyOnly = await patch({ strategy: "round_robin" });
    expect(strategyOnly.status).toBe(200);
    expect((await read())["systemPrompt"]).toBe("keep me");
  });
});
