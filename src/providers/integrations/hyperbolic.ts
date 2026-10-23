import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Hyperbolic — the 8 chat model id(s) its published catalog lists. */
export const HYPERBOLIC_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "Qwen/QwQ-32B", providerId: "hyperbolic", reasoning: true }),
  defineModel({ id: "deepseek-ai/DeepSeek-R1", providerId: "hyperbolic", reasoning: true }),
  defineModel({ id: "deepseek-ai/DeepSeek-V3", providerId: "hyperbolic", reasoning: true }),
  defineModel({ id: "meta-llama/Llama-3.3-70B-Instruct", providerId: "hyperbolic" }),
  defineModel({ id: "meta-llama/Llama-3.2-3B-Instruct", providerId: "hyperbolic" }),
  defineModel({ id: "Qwen/Qwen2.5-72B-Instruct", providerId: "hyperbolic", reasoning: true }),
  defineModel({ id: "Qwen/Qwen2.5-Coder-32B-Instruct", providerId: "hyperbolic", reasoning: true }),
  defineModel({ id: "NousResearch/Hermes-3-Llama-3.1-70B", providerId: "hyperbolic" }),
];

export const HYPERBOLIC_SPEC: ApiKeyProviderSpec = {
  provider_id: "hyperbolic",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
