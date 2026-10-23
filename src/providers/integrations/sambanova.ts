import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** SambaNova — the 1 chat model id(s) its published catalog lists. */
export const SAMBANOVA_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "MiniMax-M2.7", providerId: "sambanova", ctx: 196608, vision: true, reasoning: true }),
];

export const SAMBANOVA_SPEC: ApiKeyProviderSpec = {
  provider_id: "sambanova",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
