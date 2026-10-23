import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Kimchi — the 8 chat model id(s) its published catalog lists. */
export const KIMCHI_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "minimax-m3", providerId: "kimchi", vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2.7", providerId: "kimchi", vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2.6", providerId: "kimchi", vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2.5", providerId: "kimchi", vision: true, reasoning: true }),
  defineModel({ id: "nemotron-3-ultra-fp4", providerId: "kimchi", reasoning: true }),
  defineModel({ id: "minimax-m2.7", providerId: "kimchi", vision: true, reasoning: true }),
  defineModel({ id: "claude-opus-4-6", providerId: "kimchi", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "claude-sonnet-4-6", providerId: "kimchi", vision: true, document: true, reasoning: true, webSearch: true }),
];

export const KIMCHI_SPEC: ApiKeyProviderSpec = {
  provider_id: "kimchi",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
  extra_headers: {
    "user-agent": "kimchi/0.1.50",
  },
};
