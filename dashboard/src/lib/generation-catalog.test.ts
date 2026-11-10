import { describe, expect, test } from "bun:test";
import { groupGenerationProviders, providerOptionLabel } from "./generation-catalog";
import type { GenerationModel } from "./contracts";

const models: readonly GenerationModel[] = [
  { providerId: "alpha", providerLabel: "Alpha", modelId: "shared-model", kind: "image" },
  { providerId: "beta", providerLabel: "Beta", modelId: "shared-model", kind: "image" },
  { providerId: "alpha", providerLabel: "Alpha", modelId: "alpha-video", kind: "video" },
  { providerId: "beta", providerLabel: "Beta", modelId: "beta-image", kind: "image" },
];

describe("groupGenerationProviders", () => {
  test("keeps same-named models under their own provider", () => {
    const groups = groupGenerationProviders(models, "image");
    expect(groups.map((group) => group.id)).toEqual(["alpha", "beta"]);
    expect(groups[0]?.models.map((model) => model.modelId)).toEqual(["shared-model"]);
    expect(groups[1]?.models.map((model) => model.modelId)).toEqual(["beta-image", "shared-model"]);
  });

  test("filters by kind and exposes the provider id when it differs from the label", () => {
    const groups = groupGenerationProviders(models, "video");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.models.map((model) => model.modelId)).toEqual(["alpha-video"]);
    expect(providerOptionLabel({ id: "alpha", label: "Alpha", models: [] })).toBe("Alpha · alpha");
    expect(providerOptionLabel({ id: "muse2api", label: "muse2api", models: [] })).toBe("muse2api");
  });
});
