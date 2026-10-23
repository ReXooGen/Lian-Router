import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Morph — the 6 chat model id(s) its published catalog lists. */
export const MORPH_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "morph-v3-large", providerId: "morph" }),
  defineModel({ id: "morph-v3-fast", providerId: "morph" }),
  defineModel({ id: "morph-qwen35-397b", providerId: "morph", ctx: 262144, reasoning: true }),
  defineModel({ id: "morph-minimax27-230b", providerId: "morph", ctx: 200704, reasoning: true }),
  defineModel({ id: "morph-qwen36-27b", providerId: "morph", ctx: 262144, reasoning: true }),
  defineModel({ id: "morph-dsv4flash", providerId: "morph", ctx: 1048576 }),
];

export const MORPH_SPEC: ApiKeyProviderSpec = {
  provider_id: "morph",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
