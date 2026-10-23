import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** API.airforce — the 3 chat model id(s) its published catalog lists. */
export const API_AIRFORCE_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "gpt-oss-120b", providerId: "api-airforce", ctx: 131072, reasoning: true }),
  defineModel({ id: "gpt-oss-20b", providerId: "api-airforce", ctx: 131072, reasoning: true }),
  defineModel({ id: "kimi-k2.7-code", providerId: "api-airforce", ctx: 262144, vision: true, reasoning: true }),
];

export const API_AIRFORCE_SPEC: ApiKeyProviderSpec = {
  provider_id: "api-airforce",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
