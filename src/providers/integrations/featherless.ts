import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Featherless — the 7 chat model id(s) its published catalog lists. */
export const FEATHERLESS_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "deepseek-ai/DeepSeek-V4-Pro", providerId: "featherless", reasoning: true }),
  defineModel({ id: "deepseek-ai/DeepSeek-V4-Flash", providerId: "featherless", reasoning: true }),
  defineModel({ id: "zai-org/GLM-5.2", providerId: "featherless", reasoning: true }),
  defineModel({ id: "zai-org/GLM-5.1", providerId: "featherless", reasoning: true }),
  defineModel({ id: "moonshotai/Kimi-K2.7-Code", providerId: "featherless", vision: true, reasoning: true }),
  defineModel({ id: "moonshotai/Kimi-K2.6", providerId: "featherless", vision: true, reasoning: true }),
  defineModel({ id: "moonshotai/Kimi-K2.5", providerId: "featherless", vision: true, reasoning: true }),
];

export const FEATHERLESS_SPEC: ApiKeyProviderSpec = {
  provider_id: "featherless",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
