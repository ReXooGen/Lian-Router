// Prompt Injection console routes.
//
// GET    /prompt-injection            → catalog, or `{ stack }` when `preview`
// PUT    /prompt-injection            → { global: entry|null }
//                                     | { keyId, ...entry }
//                                     | { model, ...entry }
// DELETE /prompt-injection?global=1   | ?keyId=<id> | ?model=<name>
//
// `entry` is the editor payload: mode (prompt|script), preset
// (custom|assistant|uncensored), content, turns, position, enabled. An empty
// prompt or a script with no non-empty turns deletes the target.

import { Elysia } from "elysia";
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../shared/errors";
import {
  normalizeInjectionTarget,
  normalizePromptInjectionInput,
  toPromptInjectionCatalog,
  toPromptInjectionEntry,
  toPromptInjectionPreview,
  type PromptInjectionEntryResponse,
  type PromptInjectionRoutesConfig,
} from "./contracts";

export function createPromptInjectionRoutes(config: PromptInjectionRoutesConfig): Elysia {
  return new Elysia({ prefix: "/prompt-injection" })
    .get("/", async ({ request, set }) => {
      try {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:read");
        const params = new URL(request.url).searchParams;
        const rows = await config.store.list(access.tenantId);
        if (params.has("preview")) {
          const keyId = params.get("keyId") ?? undefined;
          const model = params.get("model") ?? undefined;
          return {
            stack: toPromptInjectionPreview(rows, {
              ...(keyId ? { apiKeyId: keyId } : {}),
              ...(model ? { model } : {}),
            }),
          };
        }
        return toPromptInjectionCatalog(rows);
      } catch (error) {
        return errorResponse(error, set, "Failed to read prompt injections");
      }
    })
    .put("/", async ({ request, body, set }) => {
      try {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new ConsoleDomainError("invalid_request", 400, "Provide global, keyId, or model");
        }
        const payload = body as Record<string, unknown>;

        const save = async (
          scope: "global" | "key" | "model",
          target: string,
          rawEntry: unknown,
        ): Promise<{ entry: PromptInjectionEntryResponse | null }> => {
          const input = normalizePromptInjectionInput(rawEntry);
          if (input === null) {
            const removedName = typeof (rawEntry as { name?: unknown })?.name === "string"
              ? ((rawEntry as { name: string }).name).trim()
              : "";
            await config.store.remove(access.tenantId, scope, target, removedName);
            await config.auditSink?.record({
              access,
              action: "prompt_injection.deleted",
              target: scope === "global" ? "global" : target,
              detail: { scope },
            });
            return { entry: null };
          }
          const saved = await config.store.upsert(access.tenantId, scope, target, input);
          await config.auditSink?.record({
            access,
            action: "prompt_injection.updated",
            target: scope === "global" ? "global" : target,
            detail: {
              scope,
              mode: input.mode,
              preset: input.preset,
              position: input.position,
              enabled: input.enabled,
              contentChars: input.content.length,
              turns: input.turns.length,
            },
          });
          return { entry: toPromptInjectionEntry(saved) };
        };

        if ("global" in payload) {
          return { global: (await save("global", "", payload["global"])).entry };
        }
        if (typeof payload["keyId"] === "string" && payload["keyId"].trim().length > 0) {
          const keyId = payload["keyId"].trim();
          return { keyId, ...(await save("key", keyId, payload)) };
        }
        if (typeof payload["model"] === "string" && payload["model"].trim().length > 0) {
          const model = normalizeInjectionTarget(payload["model"]);
          return { model, ...(await save("model", model, payload)) };
        }
        throw new ConsoleDomainError("invalid_request", 400, "Provide global, keyId, or model");
      } catch (error) {
        return errorResponse(error, set, "Failed to save prompt injection");
      }
    })
    .post("/activate", async ({ request, body, set }) => {
      try {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new ConsoleDomainError("invalid_request", 400, "Provide scope, target, and name");
        }
        const payload = body as Record<string, unknown>;
        const scope = payload["scope"];
        if (scope !== "global" && scope !== "key" && scope !== "model") {
          throw new ConsoleDomainError("invalid_request", 400, "scope must be global, key, or model");
        }
        const target = scope === "global" ? "" : normalizeInjectionTarget(payload["target"]);
        const name = typeof payload["name"] === "string" ? payload["name"].trim() : "";
        const activated = await config.store.activate(access.tenantId, scope, target, name);
        if (activated) {
          await config.auditSink?.record({
            access,
            action: "prompt_injection.activated",
            target: scope === "global" ? "global" : target,
            detail: { scope, name },
          });
        }
        return { activated };
      } catch (error) {
        return errorResponse(error, set, "Failed to activate prompt injection");
      }
    })
    .delete("/", async ({ request, set }) => {
      try {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
        const params = new URL(request.url).searchParams;
        let scope: "global" | "key" | "model";
        let target = "";
        if (params.has("global")) scope = "global";
        else if (params.has("keyId")) {
          scope = "key";
          target = normalizeInjectionTarget(params.get("keyId"));
        } else if (params.has("model")) {
          scope = "model";
          target = normalizeInjectionTarget(params.get("model"));
        } else {
          throw new ConsoleDomainError("invalid_request", 400, "Provide global, keyId, or model");
        }
        const name = (params.get("name") ?? "").trim();
        const deleted = await config.store.remove(access.tenantId, scope, target, name);
        if (deleted) {
          await config.auditSink?.record({
            access,
            action: "prompt_injection.deleted",
            target: scope === "global" ? "global" : target,
            detail: { scope },
          });
        }
        return { deleted };
      } catch (error) {
        return errorResponse(error, set, "Failed to delete prompt injection");
      }
    }) as unknown as Elysia;
}
