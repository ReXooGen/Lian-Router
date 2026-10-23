import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** iFlow AI — the 15 chat model id(s) its published catalog lists. */
export const IFLOW_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "qwen3-coder-plus", providerId: "iflow", reasoning: true }),
  defineModel({ id: "qwen3-max", providerId: "iflow", vision: true, reasoning: true }),
  defineModel({ id: "qwen3-vl-plus", providerId: "iflow", vision: true, reasoning: true }),
  defineModel({ id: "qwen3-max-preview", providerId: "iflow", vision: true, reasoning: true }),
  defineModel({ id: "qwen3-235b", providerId: "iflow", reasoning: true }),
  defineModel({ id: "qwen3-235b-a22b-instruct", providerId: "iflow", reasoning: true }),
  defineModel({ id: "qwen3-235b-a22b-thinking-2507", providerId: "iflow", reasoning: true }),
  defineModel({ id: "qwen3-32b", providerId: "iflow", reasoning: true }),
  defineModel({ id: "kimi-k2", providerId: "iflow", vision: true, reasoning: true }),
  defineModel({ id: "deepseek-v3.2", providerId: "iflow", reasoning: true }),
  defineModel({ id: "deepseek-v3.1", providerId: "iflow", reasoning: true }),
  defineModel({ id: "deepseek-v3", providerId: "iflow", reasoning: true }),
  defineModel({ id: "deepseek-r1", providerId: "iflow", reasoning: true }),
  defineModel({ id: "glm-4.7", providerId: "iflow", reasoning: true }),
  defineModel({ id: "iflow-rome-30ba3b", providerId: "iflow" }),
];

export const IFLOW_SPEC: ApiKeyProviderSpec = {
  provider_id: "iflow",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
  extra_headers: {
    "user-agent": "iFlow-Cli",
  },
};
