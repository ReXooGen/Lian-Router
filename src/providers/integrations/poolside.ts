import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Poolside — the 2 chat model id(s) its published catalog lists. */
export const POOLSIDE_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "poolside/laguna-s-2.1", providerId: "poolside", reasoning: true }),
  defineModel({ id: "poolside/laguna-xs-2.1", providerId: "poolside", reasoning: true }),
];

export const POOLSIDE_SPEC: ApiKeyProviderSpec = {
  provider_id: "poolside",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
