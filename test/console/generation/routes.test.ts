import { describe, expect, test } from "bun:test";
import { createGenerationRoutes } from "../../../src/console/generation/routes";
import type {
  GenerationCatalog,
  GenerationImageTask,
  GenerationMedia,
  GenerationStore,
  GenerationVideoTask,
} from "../../../src/console/generation/contracts";
import {
  createAccessDecision,
  type AccessDecision,
  type AccessScope,
} from "../../../src/security/access-control";

function access(scopes: readonly AccessScope[]): AccessDecision {
  return createAccessDecision({ id: "session", tenantId: "tenant-1", scopes });
}

function store(overrides: Partial<GenerationStore> = {}): GenerationStore {
  return {
    catalog: async (): Promise<GenerationCatalog> => ({
      models: [
        { providerId: "muse2api", providerLabel: "muse2api", modelId: "muse-image", kind: "image" },
      ],
    }),
    generateImage: async (): Promise<GenerationImageTask> => ({
      id: "task_1",
      status: "queued",
      progress: 0,
      createdAt: 1,
      images: [],
    }),
    generateVideo: async (): Promise<GenerationVideoTask> => ({
      id: "task_v",
      status: "queued",
      progress: 0,
      createdAt: 1,
    }),
    getImageTask: async (): Promise<GenerationImageTask> => ({
      id: "task_1",
      status: "succeeded",
      progress: 100,
      createdAt: 1,
      images: [{ url: "/console/api/generation/media?providerId=muse2api&name=a.png" }],
    }),
    getVideoTask: async (): Promise<GenerationVideoTask> => ({
      id: "task_v",
      status: "succeeded",
      progress: 100,
      createdAt: 1,
      video: { url: "/console/api/generation/media?providerId=muse2api&name=v.mp4" },
    }),
    fetchMedia: async (): Promise<GenerationMedia> => ({
      response: new Response(new Uint8Array([9, 8, 7]), {
        headers: { "content-type": "video/mp4" },
      }),
    }),
    ...overrides,
  };
}

function app(
  scopeFor: (request: Request) => AccessDecision | undefined,
  generationStore: GenerationStore = store(),
  audited: unknown[] = [],
) {
  return createGenerationRoutes({
    store: generationStore,
    accessResolver: scopeFor,
    auditSink: {
      record: async (entry) => {
        audited.push(entry);
      },
    },
  });
}

describe("generation routes", () => {
  test("catalog requires dashboard:read", async () => {
    const reader = app(() => access(["dashboard:read"]));
    const response = await reader.handle(new Request("http://x/generation/catalog"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      models: [{ modelId: "muse-image", kind: "image" }],
    });

    const anonymous = app(() => undefined);
    expect((await anonymous.handle(new Request("http://x/generation/catalog"))).status).toBe(401);

    const writerOnly = app(() => access(["dashboard:write"]));
    expect((await writerOnly.handle(new Request("http://x/generation/catalog"))).status).toBe(403);
  });

  test("submission requires dashboard:write and audits the action", async () => {
    const audited: unknown[] = [];
    const writer = app(() => access(["dashboard:write"]), store(), audited);
    const response = await writer.handle(
      new Request("http://x/generation/images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "muse2api", model: "muse-image", prompt: "cube", n: 1 }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "task_1", status: "queued" });
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ action: "generation.image", target: "muse2api/muse-image" });

    const reader = app(() => access(["dashboard:read"]));
    const denied = await reader.handle(
      new Request("http://x/generation/images", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "muse2api", model: "muse-image", prompt: "cube", n: 1 }),
      }),
    );
    expect(denied.status).toBe(403);
  });

  test("invalid input is rejected before the upstream is called", async () => {
    const writer = app(() => access(["dashboard:write"]));
    const response = await writer.handle(
      new Request("http://x/generation/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "muse2api", model: "muse-video", prompt: "x", duration: 61 }),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("task polling requires providerId and a path-safe id", async () => {
    const reader = app(() => access(["dashboard:read"]));
    expect((await reader.handle(new Request("http://x/generation/images/task_1"))).status).toBe(400);
    const response = await reader.handle(
      new Request("http://x/generation/images/task_1?providerId=muse2api"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "succeeded" });
  });

  test("media streams the provider bytes with its content type", async () => {
    const reader = app(() => access(["dashboard:read"]));
    const response = await reader.handle(
      new Request("http://x/generation/media?providerId=muse2api&name=v.mp4"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([9, 8, 7]);
  });

  test("a provider or model mismatch maps to the store's typed error", async () => {
    const failing = app(
      () => access(["dashboard:write"]),
      store({
        generateVideo: async () => {
          throw Object.assign(new Error("Model muse2api/muse-image does not generate video"), {
            code: "generation_model_not_found",
            status: 404,
          });
        },
      }),
    );
    const response = await failing.handle(
      new Request("http://x/generation/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "muse2api", model: "muse-image", prompt: "x" }),
      }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "generation_model_not_found" });
  });
});
