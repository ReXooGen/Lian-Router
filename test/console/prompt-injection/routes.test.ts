import { describe, expect, test } from "bun:test";
import type { AccessDecision } from "../../../src/security/access-control";
import type {
  PromptInjectionInput,
  PromptInjectionStorePort,
} from "../../../src/console/prompt-injection/contracts";
import { createPromptInjectionRoutes } from "../../../src/console/prompt-injection/routes";
import type {
  PromptInjection,
  PromptInjectionScope,
} from "../../../src/persistence/schema";

const readWrite: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
  admissionIdentity: "key-1",
};
const readOnly: AccessDecision = { ...readWrite, scopes: ["dashboard:read"] };

function memoryStore(): PromptInjectionStorePort {
  const rows = new Map<string, PromptInjection>();
  const key = (tenantId: string, scope: PromptInjectionScope, target: string, name = "") =>
    `${tenantId}:${scope}:${target}:${name}`;
  return {
    async list(tenantId) {
      return [...rows.values()].filter((row) => row.tenantId === tenantId);
    },
    async upsert(tenantId, scope, target, input: PromptInjectionInput) {
      if (input.active) {
        for (const [rowKey, row] of rows) {
          if (row.tenantId === tenantId && row.scope === scope && row.target === target && row.name !== input.name) {
            rows.set(rowKey, { ...row, active: false });
          }
        }
      }
      const row: PromptInjection = {
        id: `id-${scope}-${target}`,
        tenantId,
        scope,
        target,
        name: input.name,
        active: input.active,
        mode: input.mode,
        preset: input.preset,
        content: input.content,
        turns: input.turns,
        position: input.position,
        enabled: input.enabled,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.set(key(tenantId, scope, target, input.name), row);
      return row;
    },
    async remove(tenantId, scope, target, name) {
      return rows.delete(key(tenantId, scope, target, name));
    },
    async activate(tenantId, scope, target, name) {
      const targetRow = rows.get(key(tenantId, scope, target, name));
      if (targetRow === undefined) return false;
      for (const [rowKey, row] of rows) {
        if (row.tenantId === tenantId && row.scope === scope && row.target === target) {
          rows.set(rowKey, { ...row, active: row.name === name });
        }
      }
      return true;
    },
  };
}

function app(access: AccessDecision | undefined, store = memoryStore()) {
  return {
    store,
    routes: createPromptInjectionRoutes({ store, accessResolver: () => access }),
  };
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://localhost/prompt-injection", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("prompt injection routes", () => {
  test("401s without an access decision", async () => {
    const response = await app(undefined).routes.handle(new Request("http://localhost/prompt-injection"));
    expect(response.status).toBe(401);
  });

  test("returns an empty catalog before anything is saved", async () => {
    const response = await app(readOnly).routes.handle(new Request("http://localhost/prompt-injection"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      entries: [],
      global: null,
      userPrompts: {},
      prompts: {},
    });
  });

  test("saves a global injection and returns it from the catalog", async () => {
    const { routes } = app(readWrite);
    const saved = await routes.handle(
      jsonRequest("PUT", {
        global: {
          mode: "prompt",
          preset: "assistant",
          content: "You are a helpful assistant.",
          position: "prepend",
          enabled: true,
        },
      }),
    );
    expect(saved.status).toBe(200);
    const catalog = await (await routes.handle(new Request("http://localhost/prompt-injection"))).json();
    expect(catalog.global.content).toBe("You are a helpful assistant.");
    expect(catalog.global.preset).toBe("assistant");
    expect(catalog.global.position).toBe("prepend");
  });

  test("saves a per-key script and a per-model prompt", async () => {
    const { routes } = app(readWrite);
    await routes.handle(
      jsonRequest("PUT", {
        keyId: "key-9",
        mode: "script",
        turns: [{ role: "user", content: "prime" }],
        enabled: true,
      }),
    );
    await routes.handle(
      jsonRequest("PUT", {
        model: "claude-sonnet-5",
        mode: "prompt",
        content: "model persona",
        enabled: true,
      }),
    );
    const catalog = await (await routes.handle(new Request("http://localhost/prompt-injection"))).json();
    expect(catalog.userPrompts["key-9"].mode).toBe("script");
    expect(catalog.userPrompts["key-9"].turns).toEqual([{ role: "user", content: "prime" }]);
    expect(catalog.prompts["claude-sonnet-5"].content).toBe("model persona");
  });

  test("keeps several named entries for one model and activates the saved one", async () => {
    const { routes } = app(readWrite);
    await routes.handle(
      jsonRequest("PUT", { model: "claude-sonnet-5", name: "Persona A", mode: "prompt", content: "a" }),
    );
    await routes.handle(
      jsonRequest("PUT", { model: "claude-sonnet-5", name: "Persona B", mode: "prompt", content: "b" }),
    );
    const catalog = await (await routes.handle(new Request("http://localhost/prompt-injection"))).json();
    expect(catalog.entries.map((entry: { name: string }) => entry.name).sort()).toEqual([
      "Persona A",
      "Persona B",
    ]);
    expect(
      catalog.entries
        .filter((entry: { active: boolean }) => entry.active)
        .map((entry: { name: string }) => entry.name),
    ).toEqual(["Persona B"]);

    const activated = await routes.handle(
      new Request("http://localhost/prompt-injection/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "model", target: "claude-sonnet-5", name: "Persona A" }),
      }),
    );
    expect(await activated.json()).toEqual({ activated: true });
    const after = await (await routes.handle(new Request("http://localhost/prompt-injection"))).json();
    expect(
      after.entries
        .filter((entry: { active: boolean }) => entry.active)
        .map((entry: { name: string }) => entry.name),
    ).toEqual(["Persona A"]);
  });

  test("round-trips the operator-facing name", async () => {
    const { routes } = app(readWrite);
    await routes.handle(
      jsonRequest("PUT", {
        model: "claude-sonnet-5",
        name: "  Persona A  ",
        mode: "prompt",
        content: "x",
      }),
    );
    const catalog = await (await routes.handle(new Request("http://localhost/prompt-injection"))).json();
    expect(catalog.prompts["claude-sonnet-5"].name).toBe("Persona A");
  });

  test("an empty prompt removes the target", async () => {
    const { routes } = app(readWrite);
    await routes.handle(jsonRequest("PUT", { global: { mode: "prompt", content: "x" } }));
    await routes.handle(jsonRequest("PUT", { global: { mode: "prompt", content: "   " } }));
    const catalog = await (await routes.handle(new Request("http://localhost/prompt-injection"))).json();
    expect(catalog.global).toBeNull();
  });

  test("delete removes a key target", async () => {
    const { routes } = app(readWrite);
    await routes.handle(
      jsonRequest("PUT", { keyId: "key-9", mode: "prompt", content: "persona" }),
    );
    const deleted = await routes.handle(
      new Request("http://localhost/prompt-injection?keyId=key-9", { method: "DELETE" }),
    );
    expect(await deleted.json()).toEqual({ deleted: true });
  });

  test("preview returns the stack in global → key → model order", async () => {
    const { routes } = app(readWrite);
    await routes.handle(jsonRequest("PUT", { global: { mode: "prompt", content: "g" } }));
    await routes.handle(jsonRequest("PUT", { keyId: "key-9", mode: "prompt", content: "k" }));
    await routes.handle(jsonRequest("PUT", { model: "m", mode: "prompt", content: "m" }));
    const response = await routes.handle(
      new Request("http://localhost/prompt-injection?preview=1&keyId=key-9&model=m"),
    );
    const body = await response.json();
    expect(body.stack.map((entry: { scope: string }) => entry.scope)).toEqual([
      "global",
      "key",
      "model",
    ]);
  });

  test("rejects a write with only read scope", async () => {
    const { routes } = app(readOnly);
    const response = await routes.handle(
      jsonRequest("PUT", { global: { mode: "prompt", content: "x" } }),
    );
    expect(response.status).toBe(403);
  });

  test("rejects an unknown mode", async () => {
    const { routes } = app(readWrite);
    const response = await routes.handle(
      jsonRequest("PUT", { global: { mode: "jailbreak", content: "x" } }),
    );
    expect(response.status).toBe(400);
  });
});
