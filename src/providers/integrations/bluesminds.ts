import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** BluesMinds — the 14 chat model id(s) its published catalog lists. */
export const BLUESMINDS_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "gpt-4.1", providerId: "bluesminds", ctx: 1048576, vision: true }),
  defineModel({ id: "gpt-4.1-mini", providerId: "bluesminds", ctx: 1048576, vision: true }),
  defineModel({ id: "gpt-4.1-nano", providerId: "bluesminds", ctx: 1048576, vision: true }),
  defineModel({ id: "claude-sonnet-4-5", providerId: "bluesminds", ctx: 200000, vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-haiku-4-5", providerId: "bluesminds", ctx: 200000, vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gemini-2.0-flash", providerId: "bluesminds", ctx: 1048576, vision: true, webSearch: true }),
  defineModel({ id: "gemini-2.0-flash-exp", providerId: "bluesminds", ctx: 1048576, vision: true, webSearch: true }),
  defineModel({ id: "qwen-turbo", providerId: "bluesminds", ctx: 1000000, reasoning: true }),
  defineModel({ id: "kimi-k2", providerId: "bluesminds", ctx: 262144, vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2-thinking", providerId: "bluesminds", ctx: 262144, vision: true, reasoning: true }),
  defineModel({ id: "glm-4.7", providerId: "bluesminds", ctx: 204800, reasoning: true }),
  defineModel({ id: "minimax-m2.5", providerId: "bluesminds", ctx: 204800, vision: true, reasoning: true }),
  defineModel({ id: "claude-opus-4-5", providerId: "bluesminds", ctx: 200000, vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "gemini-2.5-pro", providerId: "bluesminds", ctx: 1048576, vision: true, reasoning: true, webSearch: true }),
];

export const BLUESMINDS_SPEC: ApiKeyProviderSpec = {
  provider_id: "bluesminds",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
