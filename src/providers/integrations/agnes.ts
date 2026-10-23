import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Agnes AI — the 4 chat model id(s) its published catalog lists. */
export const AGNES_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "agnes-2.5-flash", providerId: "agnes" }),
  defineModel({ id: "agnes-2.5-pro", providerId: "agnes" }),
  defineModel({ id: "agnes-2.5-pro-beta", providerId: "agnes" }),
  defineModel({ id: "agnes-3.0-flash", providerId: "agnes" }),
];

export const AGNES_SPEC: ApiKeyProviderSpec = {
  provider_id: "agnes",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
