import { describe, expect, test } from "bun:test";
import { DrizzleGenerationStore } from "../../../src/console/generation/store";
import {
  parseGenerationImageInput,
  parseGenerationVideoInput,
} from "../../../src/console/generation/contracts";
import { ConsoleDomainError } from "../../../src/console/shared/errors";
import { parseProviderId, type ResolvedCredential } from "../../../src/providers/provider-registry";
import type { LianRouterDatabase } from "../../../src/persistence/postgres";
import { models, providerAccounts, providers } from "../../../src/persistence/schema";

const PROVIDER = {
  id: "muse2api",
  baseUrl: "http://127.0.0.1:18610/v1",
  enabled: true,
  tenantId: "tenant-1",
};
const IMAGE_MODEL = {
  providerId: "muse2api",
  modelId: "muse-image",
  enabled: true,
  modalities: { input: ["text"], output: ["image"] },
};
const VIDEO_MODEL = {
  providerId: "muse2api",
  modelId: "muse-video",
  enabled: true,
  modalities: { input: ["text"], output: ["video"] },
};
const CHAT_MODEL = {
  providerId: "muse2api",
  modelId: "muse-chat",
  enabled: true,
  modalities: { input: ["text"], output: ["text"] },
};
const ACCOUNT = {
  id: "acct-1",
  cooldownUntil: null,
  lastErrorAt: null,
  consecutiveFailures: 0,
  lastSuccessAt: null,
};

interface FakeDbOptions {
  readonly provider?: { id: string; baseUrl: string | null; enabled: boolean; tenantId: string | null };
  readonly catalogModels?: readonly { providerId: string; modelId: string; modalities: unknown }[];
}

function fakeDb(options: FakeDbOptions = {}): LianRouterDatabase {
  const modelsForProvider = options.catalogModels ?? [
    { providerId: IMAGE_MODEL.providerId, modelId: IMAGE_MODEL.modelId, modalities: IMAGE_MODEL.modalities },
    { providerId: VIDEO_MODEL.providerId, modelId: VIDEO_MODEL.modelId, modalities: VIDEO_MODEL.modalities },
    { providerId: CHAT_MODEL.providerId, modelId: CHAT_MODEL.modelId, modalities: CHAT_MODEL.modalities },
  ];
  const providerRow = options.provider ?? PROVIDER;
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === models) {
          return {
            innerJoin: () => ({ where: async () => modelsForProvider }),
            where: () => ({
              limit: async () => modelsForProvider.map((model) => ({ ...model, enabled: true })),
            }),
          };
        }
        void providerAccounts;
        const rows = table === providers ? [providerRow] : [ACCOUNT];
        return { where: () => ({ limit: async () => rows }) };
      },
    }),
  };
  // The store only issues table-shaped reads; the schema type is irrelevant
  // to those fakes, so the boundary cast is explicit and local.
  return db as unknown as LianRouterDatabase;
}

function credential(): ResolvedCredential {
  return {
    provider_id: parseProviderId("muse2api"),
    account_id: "acct-1",
    credential_kind: "api_key",
    secret: new TextEncoder().encode("sk-muse"),
  };
}

function harness(payloads: unknown[], database: LianRouterDatabase = fakeDb()): {
  store: DrizzleGenerationStore;
  requests: Array<{ url: string; init: RequestInit | undefined }>;
  releases: () => number;
} {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  let releases = 0;
  const store = new DrizzleGenerationStore(database, {
    resolveCredential: async () => credential(),
    outboundFetchFor: async () => ({
      fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({ url: String(input), init });
        const payload = payloads.shift() ?? {};
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      networkPoolId: "pool-1",
      release: () => {
        releases += 1;
      },
    }),
  });
  return { store, requests, releases: () => releases };
}

describe("generation contracts", () => {
  test("image input rejects an out-of-range count and a malformed size", () => {
    expect(() =>
      parseGenerationImageInput({ providerId: "p", model: "m", prompt: "x", n: 5 }),
    ).toThrow(ConsoleDomainError);
    expect(() =>
      parseGenerationImageInput({ providerId: "p", model: "m", prompt: "x", size: "big" }),
    ).toThrow(ConsoleDomainError);
    expect(parseGenerationImageInput({ providerId: "p", model: "m", prompt: " x " })).toEqual({
      providerId: "p",
      model: "m",
      prompt: "x",
      n: 1,
    });
  });

  test("video input bounds the duration", () => {
    expect(() =>
      parseGenerationVideoInput({ providerId: "p", model: "m", prompt: "x", duration: 61 }),
    ).toThrow(ConsoleDomainError);
    expect(
      parseGenerationVideoInput({ providerId: "p", model: "m", prompt: "x", duration: 5 }),
    ).toMatchObject({ duration: 5 });
  });
});

describe("DrizzleGenerationStore", () => {
  test("catalog lists only image/video output models", async () => {
    const { store } = harness([]);
    const catalog = await store.catalog("tenant-1");
    expect(catalog.models).toEqual([
      { providerId: "muse2api", providerLabel: "muse2api", modelId: "muse-image", kind: "image" },
      { providerId: "muse2api", providerLabel: "muse2api", modelId: "muse-video", kind: "video" },
    ]);
  });

  test("image submission forwards the async task contract and rewrites media URLs", async () => {
    const { store, requests, releases } = harness([
      {
        id: "task_1",
        object: "image.task",
        status: "queued",
        progress: 0,
        created_at: 1_700_000_000,
        model: "muse-image",
        result: null,
      },
      {
        id: "task_1",
        status: "succeeded",
        progress: 100,
        created_at: 1_700_000_000,
        model: "muse-image",
        result: {
          created: 1_700_000_010,
          data: [
            {
              url: "http://127.0.0.1:18610/v1/media/img_abc.png",
              revised_prompt: "a red cube",
            },
          ],
        },
      },
    ]);
    const submitted = await store.generateImage("tenant-1", {
      providerId: "muse2api",
      model: "muse-image",
      prompt: "a red cube",
      n: 1,
      size: "1024x1024",
    });
    expect(submitted).toMatchObject({ id: "task_1", status: "queued", progress: 0 });
    expect(requests[0]?.url).toBe("http://127.0.0.1:18610/v1/images/generations");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-muse");
    const body: unknown = JSON.parse(String(requests[0]?.init?.body));
    expect(body).toMatchObject({
      model: "muse-image",
      prompt: "a red cube",
      n: 1,
      size: "1024x1024",
      response_format: "url",
      async: true,
    });

    const polled = await store.getImageTask("tenant-1", "muse2api", "task_1");
    expect(polled.status).toBe("succeeded");
    expect(polled.images).toEqual([
      {
        url: "/console/api/generation/media?providerId=muse2api&name=img_abc.png",
        revisedPrompt: "a red cube",
      },
    ]);
    expect(releases()).toBe(2);
  });

  test("video task carries the provider media URL through the console proxy", async () => {
    const { store } = harness([
      {
        id: "task_v",
        object: "video",
        status: "running",
        progress: 40,
        created_at: 1_700_000_000,
        model: "muse-video",
        result: null,
      },
      {
        id: "task_v",
        status: "succeeded",
        progress: 100,
        created_at: 1_700_000_000,
        model: "muse-video",
        result: {
          url: "http://127.0.0.1:18610/v1/media/vid_1.mp4",
          mime: "video/mp4",
          width: 1280,
          height: 720,
        },
      },
    ]);
    await store.generateVideo("tenant-1", {
      providerId: "muse2api",
      model: "muse-video",
      prompt: "waves",
      duration: 5,
    });
    const polled = await store.getVideoTask("tenant-1", "muse2api", "task_v");
    expect(polled.video).toEqual({
      url: "/console/api/generation/media?providerId=muse2api&name=vid_1.mp4",
      mime: "video/mp4",
      width: 1280,
      height: 720,
    });
  });

  test("a bundled provider with a null row base URL falls back to the metadata origin", async () => {
    const bundledProvider = { id: "openai", baseUrl: null, enabled: true, tenantId: null };
    const bundledModel = {
      providerId: "openai",
      modelId: "gpt-image-1",
      modalities: { input: ["text"], output: ["image"] },
    };
    const { store, requests } = harness(
      [{ id: "task_1", status: "queued", progress: 0, created_at: 1, result: null }],
      fakeDb({ provider: bundledProvider, catalogModels: [bundledModel] }),
    );
    await store.generateImage("tenant-1", {
      providerId: "openai",
      model: "gpt-image-1",
      prompt: "cube",
      n: 1,
    });
    expect(requests[0]?.url).toBe("https://api.openai.com/images/generations");
  });

  test("upstream errors surface their status and message", async () => {
    const requests: string[] = [];
    const store = new DrizzleGenerationStore(fakeDb(), {
      resolveCredential: async () => credential(),
      outboundFetchFor: async () => ({
        fetch: (async (input: Parameters<typeof fetch>[0]) => {
          requests.push(String(input));
          return new Response(JSON.stringify({ error: { message: "prompt rejected" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
        release: () => undefined,
      }),
    });
    const failure = store
      .generateImage("tenant-1", {
        providerId: "muse2api",
        model: "muse-image",
        prompt: "x",
        n: 1,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const error = await failure;
    expect(error).toBeInstanceOf(ConsoleDomainError);
    expect(error).toMatchObject({
      code: "generation_upstream_error",
      status: 400,
    });
    expect((error as ConsoleDomainError).message).toContain("prompt rejected");
    expect(requests).toHaveLength(1);
  });

  test("a chat model is not accepted as an image target", async () => {
    const { store } = harness([]);
    const failure = store
      .generateImage("tenant-1", {
        providerId: "muse2api",
        model: "muse-chat",
        prompt: "x",
        n: 1,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(await failure).toMatchObject({ code: "generation_model_not_found", status: 404 });
  });

  test("media streams bytes from the provider namespace and releases the slot", async () => {
    let releases = 0;
    const store = new DrizzleGenerationStore(fakeDb(), {
      resolveCredential: async () => credential(),
      outboundFetchFor: async () => ({
        fetch: (async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/png" },
          })) as unknown as typeof fetch,
        release: () => {
          releases += 1;
        },
      }),
    });
    const media = await store.fetchMedia("tenant-1", "muse2api", "img_abc.png");
    expect(media.response.headers.get("content-type")).toBe("image/png");
    const bytes = await media.response.arrayBuffer();
    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
    expect(releases).toBe(1);
  });
});
