// Generation console routes.
//
// GET  /generation/catalog                 → image/video models this tenant can use
// POST /generation/images                  → submit an image job (upstream async task)
// GET  /generation/images/:id?providerId=  → poll one image task
// POST /generation/videos                  → submit a video job
// GET  /generation/videos/:id?providerId=  → poll one video task
// GET  /generation/media?providerId=&name= → stream one provider-hosted result
//
// Reads require `dashboard:read`; submissions require `dashboard:write` and
// write an audit row. The upstream call uses the provider's configured
// account and egress, never the caller's console session.
import { Elysia } from "elysia";
import { errorResponse, requireTenantScope } from "../shared/errors";
import {
  parseGenerationImageInput,
  parseGenerationVideoInput,
  requireMediaName,
  requireProviderQuery,
  requireTaskId,
  type GenerationRoutesConfig,
} from "./contracts";

function queryValue(query: Record<string, string | undefined>, key: string): string | undefined {
  const value = query[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createGenerationRoutes(config: GenerationRoutesConfig): Elysia {
  const { store, accessResolver, auditSink } = config;
  return new Elysia({ prefix: "/generation" })
    .get("/catalog", async ({ request, set }) => {
      try {
        const access = requireTenantScope(accessResolver(request), "dashboard:read");
        return await store.catalog(access.tenantId);
      } catch (error) {
        return errorResponse(error, set, "Failed to read the generation catalog");
      }
    })
    .post("/images", async ({ request, body, set }) => {
      try {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        const input = parseGenerationImageInput(body);
        const task = await store.generateImage(access.tenantId, input);
        await auditSink.record({
          access,
          action: "generation.image",
          target: `${input.providerId}/${input.model}`,
          detail: { providerId: input.providerId, model: input.model, promptChars: input.prompt.length, n: input.n },
        });
        return task;
      } catch (error) {
        return errorResponse(error, set, "Image generation failed");
      }
    })
    .get("/images/:id", async ({ request, params, query, set }) => {
      try {
        const access = requireTenantScope(accessResolver(request), "dashboard:read");
        const providerId = requireProviderQuery(queryValue(query, "providerId"));
        const taskId = requireTaskId(params.id);
        return await store.getImageTask(access.tenantId, providerId, taskId);
      } catch (error) {
        return errorResponse(error, set, "Failed to read the image task");
      }
    })
    .post("/videos", async ({ request, body, set }) => {
      try {
        const access = requireTenantScope(accessResolver(request), "dashboard:write");
        const input = parseGenerationVideoInput(body);
        const task = await store.generateVideo(access.tenantId, input);
        await auditSink.record({
          access,
          action: "generation.video",
          target: `${input.providerId}/${input.model}`,
          detail: {
            providerId: input.providerId,
            model: input.model,
            promptChars: input.prompt.length,
            ...(input.duration ? { duration: input.duration } : {}),
          },
        });
        return task;
      } catch (error) {
        return errorResponse(error, set, "Video generation failed");
      }
    })
    .get("/videos/:id", async ({ request, params, query, set }) => {
      try {
        const access = requireTenantScope(accessResolver(request), "dashboard:read");
        const providerId = requireProviderQuery(queryValue(query, "providerId"));
        const taskId = requireTaskId(params.id);
        return await store.getVideoTask(access.tenantId, providerId, taskId);
      } catch (error) {
        return errorResponse(error, set, "Failed to read the video task");
      }
    })
    .get("/media", async ({ request, query, set }) => {
      try {
        const access = requireTenantScope(accessResolver(request), "dashboard:read");
        const providerId = requireProviderQuery(queryValue(query, "providerId"));
        const name = requireMediaName(queryValue(query, "name"));
        const media = await store.fetchMedia(access.tenantId, providerId, name);
        return media.response;
      } catch (error) {
        return errorResponse(error, set, "Failed to read generated media");
      }
    }) as unknown as Elysia;
}
