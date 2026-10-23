import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Cohere — the 3 chat model id(s) its published catalog lists. */
export const COHERE_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "command-r-plus-08-2024", providerId: "cohere" }),
  defineModel({ id: "command-r-08-2024", providerId: "cohere" }),
  defineModel({ id: "command-a-03-2025", providerId: "cohere" }),
];

export const COHERE_SPEC: ApiKeyProviderSpec = {
  provider_id: "cohere",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
