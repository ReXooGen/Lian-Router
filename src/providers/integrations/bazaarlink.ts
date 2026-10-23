import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Bazaarlink — the 24 chat model id(s) its published catalog lists. */
export const BAZAARLINK_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "auto:free", providerId: "bazaarlink" }),
  defineModel({ id: "claude-opus-4.7", providerId: "bazaarlink", ctx: 1000000, vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-sonnet-4.6", providerId: "bazaarlink", ctx: 1000000, vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-haiku-4.5", providerId: "bazaarlink", ctx: 200000, vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.5", providerId: "bazaarlink", ctx: 1050000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.4", providerId: "bazaarlink", ctx: 1050000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.4-mini", providerId: "bazaarlink", ctx: 400000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gpt-5.4-nano", providerId: "bazaarlink", ctx: 400000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "grok-4.3", providerId: "bazaarlink", ctx: 1000000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "grok-4.20", providerId: "bazaarlink", ctx: 2000000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gemini-3.1-pro-preview", providerId: "bazaarlink", ctx: 1048576, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gemini-3-flash-preview", providerId: "bazaarlink", ctx: 1048576, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gemini-3.1-flash-lite-preview", providerId: "bazaarlink", ctx: 1048576, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "kimi-k2.6", providerId: "bazaarlink", ctx: 262144, vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2.5", providerId: "bazaarlink", ctx: 262144, vision: true, reasoning: true }),
  defineModel({ id: "glm-5.1", providerId: "bazaarlink", ctx: 204800, reasoning: true }),
  defineModel({ id: "glm-5", providerId: "bazaarlink", ctx: 204800, reasoning: true }),
  defineModel({ id: "mimo-v2.5-pro", providerId: "bazaarlink", ctx: 1050000, vision: true, reasoning: true }),
  defineModel({ id: "mimo-v2.5", providerId: "bazaarlink", ctx: 1050000, vision: true, reasoning: true }),
  defineModel({ id: "minimax-m3", providerId: "bazaarlink", ctx: 1048576, vision: true, reasoning: true }),
  defineModel({ id: "minimax-m2.7", providerId: "bazaarlink", ctx: 204800, vision: true, reasoning: true }),
  defineModel({ id: "minimax-m2.5", providerId: "bazaarlink", ctx: 204800, vision: true, reasoning: true }),
  defineModel({ id: "qwen3.6-plus", providerId: "bazaarlink", ctx: 1000000, vision: true, reasoning: true }),
  defineModel({ id: "nemotron-3-super-120b-a12b", providerId: "bazaarlink", ctx: 1000000, reasoning: true }),
];

export const BAZAARLINK_SPEC: ApiKeyProviderSpec = {
  provider_id: "bazaarlink",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
