import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** LLM7 — the 5 chat model id(s) its published catalog lists. */
export const LLM7_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "gpt-5.5", providerId: "llm7", ctx: 1050000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-opus-5", providerId: "llm7", ctx: 1000000, vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "deepseek-v4-flash", providerId: "llm7", ctx: 1000000, reasoning: true }),
  defineModel({ id: "grok-4.5", providerId: "llm7", ctx: 500000, vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "kimi-k3", providerId: "llm7", ctx: 1000000, vision: true, reasoning: true }),
];

export const LLM7_SPEC: ApiKeyProviderSpec = {
  provider_id: "llm7",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
