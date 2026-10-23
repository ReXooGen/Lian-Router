import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Kilo Code — the 8 chat model id(s) its published catalog lists. */
export const KILOCODE_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "anthropic/claude-sonnet-4-20250514", providerId: "kilocode", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "anthropic/claude-opus-4-20250514", providerId: "kilocode", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "google/gemini-2.5-pro", providerId: "kilocode", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "google/gemini-2.5-flash", providerId: "kilocode", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "openai/gpt-4.1", providerId: "kilocode", vision: true }),
  defineModel({ id: "openai/o3", providerId: "kilocode", vision: true, reasoning: true }),
  defineModel({ id: "deepseek/deepseek-chat", providerId: "kilocode" }),
  defineModel({ id: "deepseek/deepseek-reasoner", providerId: "kilocode", reasoning: true }),
];

export const KILOCODE_SPEC: ApiKeyProviderSpec = {
  provider_id: "kilocode",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
