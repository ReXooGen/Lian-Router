import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Baidu Qianfan — the 7 chat model id(s) its published catalog lists. */
export const BAIDU_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "deepseek-v4-pro", providerId: "baidu", ctx: 1048576, reasoning: true }),
  defineModel({ id: "deepseek-v4-flash", providerId: "baidu", ctx: 1048576, reasoning: true }),
  defineModel({ id: "glm-5.2", providerId: "baidu", ctx: 512000, reasoning: true }),
  defineModel({ id: "glm-5.1", providerId: "baidu", ctx: 198000, reasoning: true }),
  defineModel({ id: "kimi-k2.6", providerId: "baidu", ctx: 262144, vision: true, reasoning: true }),
  defineModel({ id: "qwen3.5-397b-a17b", providerId: "baidu", ctx: 262144, vision: true, reasoning: true }),
  defineModel({ id: "qwen3.5-27b", providerId: "baidu", ctx: 262144, vision: true, reasoning: true }),
];

export const BAIDU_SPEC: ApiKeyProviderSpec = {
  provider_id: "baidu",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
