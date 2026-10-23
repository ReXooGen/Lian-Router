import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Tencent Hunyuan — the 2 chat model id(s) its published catalog lists. */
export const TENCENT_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "hunyuan-turbos-latest", providerId: "tencent", ctx: 200000, reasoning: true }),
  defineModel({ id: "hunyuan-t1-latest", providerId: "tencent", ctx: 256000, reasoning: true }),
];

export const TENCENT_SPEC: ApiKeyProviderSpec = {
  provider_id: "tencent",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
