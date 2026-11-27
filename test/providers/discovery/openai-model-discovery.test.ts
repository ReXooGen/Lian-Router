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

describe("fetchOpenAICompatibleModels capability inheritance", () => {
  /**
   * A reseller's `/models` row can carry nothing but an id (`{"id":"gpt-6.1-sol",
   * "object":"model","owned_by":"openai"}`). Reading capability from that row
   * alone marked a model that really calls tools, reasons and accepts images as
   * having none of them, and the routing ladder then refused to send it work it
   * could do. The base catalog is the second opinion; 32 rows agree on all
   * three for this id.
   */
  test("a bare upstream row inherits capabilities the base catalog agrees on", async () => {
    const models = await fetchOpenAICompatibleModels({
      baseUrl: "http://127.0.0.1:18610/v1",
      providerId: "xingchi",
      fetcher: fetcherFor({
        object: "list",
        data: [{ id: "gpt-6.1-sol", object: "model", owned_by: "openai" }],
      }),
    });
    const model = (models ?? []).find((entry) => entry.modelId === "gpt-6.1-sol");
    expect(model?.reasoning).toBe(true);
    expect(model?.toolCall).toBe(true);
    expect(model?.modalities.input).toContain("image");
  });

  test("an upstream row that declares nothing and an unknown model still says no", async () => {
    // Inheritance must not become invention: a model the catalog has never
    // heard of keeps the conservative answer.
    const models = await fetchOpenAICompatibleModels({
      baseUrl: "http://127.0.0.1:18610/v1",
      providerId: "xingchi",
      fetcher: fetcherFor({
        object: "list",
        data: [{ id: "totally-unknown-model-xyz", object: "model" }],
      }),
    });
    const model = (models ?? []).find((entry) => entry.modelId === "totally-unknown-model-xyz");
    expect(model?.reasoning).toBe(false);
    expect(model?.toolCall).toBe(false);
    expect(model?.modalities.input).not.toContain("image");
  });

  test("a capability the upstream declares is not downgraded by the catalog", async () => {
    // `capabilities: ["tools"]` is the upstream speaking. The union rule means
    // the catalogue may still add what it knows (image input), but it can never
    // take away something the serving provider promised.
    const models = await fetchOpenAICompatibleModels({
      baseUrl: "http://127.0.0.1:18610/v1",
      providerId: "xingchi",
      fetcher: fetcherFor({
        object: "list",
        data: [
          {
            id: "gpt-6.1-sol",
            object: "model",
            capabilities: ["tools"],
          },
        ],
      }),
    });
    const model = (models ?? []).find((entry) => entry.modelId === "gpt-6.1-sol");
    expect(model?.toolCall).toBe(true);
    // The catalog knows this model reads images; the upstream stayed silent, so
    // the union keeps it. A wrong image claim costs a filtered request, while a
    // missing one silently refuses work the model can do.
    expect(model?.modalities.input).toEqual(["text", "image"]);
  });
});
