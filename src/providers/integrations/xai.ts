import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** xAI (Grok) — the 6 chat model id(s) its published catalog lists. */
export const XAI_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "grok-4.6", providerId: "xai", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "grok-4.5", providerId: "xai", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "grok-4", providerId: "xai", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "grok-4-fast-reasoning", providerId: "xai", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "grok-code-fast-1", providerId: "xai", reasoning: true }),
  defineModel({ id: "grok-3", providerId: "xai", vision: true, reasoning: true, webSearch: true }),
];

export const XAI_SPEC: ApiKeyProviderSpec = {
  provider_id: "xai",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
