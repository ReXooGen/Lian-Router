import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Alibaba — the 8 chat model id(s) its published catalog lists. */
export const ALICODE_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "qwen3.5-plus", providerId: "alicode", vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2.5", providerId: "alicode", vision: true, reasoning: true }),
  defineModel({ id: "glm-5", providerId: "alicode", reasoning: true }),
  defineModel({ id: "MiniMax-M2.5", providerId: "alicode", vision: true, reasoning: true }),
  defineModel({ id: "qwen3-max-2026-01-23", providerId: "alicode", vision: true, reasoning: true }),
  defineModel({ id: "qwen3-coder-next", providerId: "alicode", reasoning: true }),
  defineModel({ id: "qwen3-coder-plus", providerId: "alicode", reasoning: true }),
  defineModel({ id: "glm-4.7", providerId: "alicode", reasoning: true }),
];

/** Alibaba Coding — the 7 chat model id(s) its published catalog lists. */
export const ALICODE_INTL_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "qwen3.5-plus", providerId: "alicode-intl", vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2.5", providerId: "alicode-intl", vision: true, reasoning: true }),
  defineModel({ id: "glm-5", providerId: "alicode-intl", reasoning: true }),
  defineModel({ id: "MiniMax-M2.5", providerId: "alicode-intl", vision: true, reasoning: true }),
  defineModel({ id: "qwen3-coder-next", providerId: "alicode-intl", reasoning: true }),
  defineModel({ id: "qwen3-coder-plus", providerId: "alicode-intl", reasoning: true }),
  defineModel({ id: "glm-4.7", providerId: "alicode-intl", reasoning: true }),
];

/** Alibaba Studio — the 7 chat model id(s) its published catalog lists. */
export const ALIMS_INTL_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "qwen3.5-plus", providerId: "alims-intl", vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2.5", providerId: "alims-intl", vision: true, reasoning: true }),
  defineModel({ id: "glm-5", providerId: "alims-intl", reasoning: true }),
  defineModel({ id: "MiniMax-M2.5", providerId: "alims-intl", vision: true, reasoning: true }),
  defineModel({ id: "qwen3-coder-next", providerId: "alims-intl", reasoning: true }),
  defineModel({ id: "qwen3-coder-plus", providerId: "alims-intl", reasoning: true }),
  defineModel({ id: "glm-4.7", providerId: "alims-intl", reasoning: true }),
];

/** Alibaba Token Plan — the 6 chat model id(s) its published catalog lists. */
export const ALITP_INTL_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "qwen3.8-max-preview", providerId: "alitp-intl", vision: true, reasoning: true }),
  defineModel({ id: "qwen3.7-max", providerId: "alitp-intl", vision: true, reasoning: true }),
  defineModel({ id: "qwen3.7-plus", providerId: "alitp-intl", vision: true, reasoning: true }),
  defineModel({ id: "qwen3.6-flash", providerId: "alitp-intl", vision: true, reasoning: true }),
  defineModel({ id: "glm-5.2", providerId: "alitp-intl", reasoning: true }),
  defineModel({ id: "deepseek-v4-pro", providerId: "alitp-intl", reasoning: true }),
];

export const ALICODE_SPEC: ApiKeyProviderSpec = {
  provider_id: "alicode",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};

export const ALICODE_INTL_SPEC: ApiKeyProviderSpec = {
  provider_id: "alicode-intl",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};

export const ALIMS_INTL_SPEC: ApiKeyProviderSpec = {
  provider_id: "alims-intl",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};

export const ALITP_INTL_SPEC: ApiKeyProviderSpec = {
  provider_id: "alitp-intl",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
