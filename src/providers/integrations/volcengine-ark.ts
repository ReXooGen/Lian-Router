import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Volcengine Ark — the 9 chat model id(s) its published catalog lists. */
export const VOLCENGINE_ARK_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "Doubao-Seed-2.0-Code", providerId: "volcengine-ark" }),
  defineModel({ id: "Doubao-Seed-2.0-pro", providerId: "volcengine-ark" }),
  defineModel({ id: "Doubao-Seed-2.0-lite", providerId: "volcengine-ark" }),
  defineModel({ id: "Doubao-Seed-Code", providerId: "volcengine-ark" }),
  defineModel({ id: "DeepSeek-V4-Flash", providerId: "volcengine-ark", reasoning: true }),
  defineModel({ id: "DeepSeek-V4-Pro", providerId: "volcengine-ark", reasoning: true }),
  defineModel({ id: "GLM-5.1", providerId: "volcengine-ark", reasoning: true }),
  defineModel({ id: "MiniMax-M2.7", providerId: "volcengine-ark", vision: true, reasoning: true }),
  defineModel({ id: "Kimi-K2.6", providerId: "volcengine-ark", vision: true, reasoning: true }),
];

export const VOLCENGINE_ARK_SPEC: ApiKeyProviderSpec = {
  provider_id: "volcengine-ark",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
