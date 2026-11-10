import { describe, expect, test } from "bun:test";
import { fetchOpenAICompatibleModels } from "../../../src/providers/discovery/openai-model-discovery";

function fetcherFor(payload: unknown): typeof fetch {
  // The discovery boundary only calls the function form; the full fetch
  // surface (preconnect, etc.) is not part of what it consumes.
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("fetchOpenAICompatibleModels generation kinds", () => {
  test("records the upstream's own output kind instead of assuming text", async () => {
    const models = await fetchOpenAICompatibleModels({
      baseUrl: "http://127.0.0.1:18610/v1",
      fetcher: fetcherFor({
        object: "list",
        data: [
          { id: "muse-chat", kind: "chat" },
          { id: "muse-image", kind: "image" },
          { id: "muse-video", kind: "video" },
          { id: "or-image", output_modalities: ["image", "text"] },
        ],
      }),
    });
    expect(models).not.toBeNull();
    const byId = new Map((models ?? []).map((model) => [model.modelId, model]));
    expect(byId.get("muse-chat")?.modalities.output).toEqual(["text"]);
    expect(byId.get("muse-image")?.modalities.output).toEqual(["image"]);
    expect(byId.get("muse-video")?.modalities.output).toEqual(["video"]);
    expect(byId.get("or-image")?.modalities.output).toEqual(["text", "image"]);
  });
});
