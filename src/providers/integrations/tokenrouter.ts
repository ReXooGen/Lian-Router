import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** TokenRouter — the 22 chat model id(s) its published catalog lists. */
export const TOKENROUTER_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "anthropic/claude-haiku-4.5", providerId: "tokenrouter", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "anthropic/claude-sonnet-4.6", providerId: "tokenrouter", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "anthropic/claude-opus-4.8", providerId: "tokenrouter", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "anthropic/claude-opus-4.8-fast", providerId: "tokenrouter", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "openai/gpt-5.4", providerId: "tokenrouter", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "openai/gpt-5.4-mini", providerId: "tokenrouter", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "openai/gpt-5.4-pro", providerId: "tokenrouter", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "openai/gpt-5.5", providerId: "tokenrouter", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "openai/gpt-5.6-sol", providerId: "tokenrouter", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "google/gemini-3.5-flash", providerId: "tokenrouter", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "google/gemini-3.6-flash", providerId: "tokenrouter", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "deepseek/deepseek-v4-flash", providerId: "tokenrouter", reasoning: true }),
  defineModel({ id: "deepseek/deepseek-v4-pro", providerId: "tokenrouter", reasoning: true }),
  defineModel({ id: "qwen/qwen3-coder-next", providerId: "tokenrouter", reasoning: true }),
  defineModel({ id: "qwen/qwen3.7-max", providerId: "tokenrouter", vision: true, reasoning: true }),
  defineModel({ id: "qwen/qwen3.8-max", providerId: "tokenrouter", vision: true, reasoning: true }),
  defineModel({ id: "moonshotai/kimi-k2.7-code", providerId: "tokenrouter", vision: true, reasoning: true }),
  defineModel({ id: "moonshotai/kimi-k3-free", providerId: "tokenrouter", vision: true, reasoning: true }),
  defineModel({ id: "z-ai/glm-5.3-free", providerId: "tokenrouter", reasoning: true }),
  defineModel({ id: "z-ai/glm-5.2", providerId: "tokenrouter", reasoning: true }),
  defineModel({ id: "z-ai/glm-5-turbo", providerId: "tokenrouter", reasoning: true }),
  defineModel({ id: "x-ai/grok-4.5", providerId: "tokenrouter", vision: true, reasoning: true, webSearch: true }),
];

export const TOKENROUTER_SPEC: ApiKeyProviderSpec = {
  provider_id: "tokenrouter",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
