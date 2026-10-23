import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Atria Dawn — the 1 chat model id(s) its published catalog lists. */
export const ATRIA_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "Atria-Dawn-Preview", providerId: "atria" }),
];

export const ATRIA_SPEC: ApiKeyProviderSpec = {
  provider_id: "atria",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
