import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Dahl Inference — the 3 chat model id(s) its published catalog lists. */
export const DAHL_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "zai-org/GLM-5.3-Flash", providerId: "dahl", reasoning: true }),
  defineModel({ id: "deepseek-ai/DeepSeek-V4-Flash-0731", providerId: "dahl", reasoning: true }),
  defineModel({ id: "MiniMaxAI/MiniMax-M2.7", providerId: "dahl", vision: true, reasoning: true }),
];

export const DAHL_SPEC: ApiKeyProviderSpec = {
  provider_id: "dahl",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
