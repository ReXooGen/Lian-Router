import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** GLM (China) — the 10 chat model id(s) its published catalog lists. */
export const GLM_CN_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "glm-5.3", providerId: "glm-cn", reasoning: true }),
  defineModel({ id: "glm-5.3-flash", providerId: "glm-cn", vision: true, document: true, reasoning: true }),
  defineModel({ id: "glm-5.2", providerId: "glm-cn", reasoning: true }),
  defineModel({ id: "glm-5.1", providerId: "glm-cn", reasoning: true }),
  defineModel({ id: "glm-5-turbo", providerId: "glm-cn", reasoning: true }),
  defineModel({ id: "glm-5", providerId: "glm-cn", reasoning: true }),
  defineModel({ id: "glm-4.7", providerId: "glm-cn", reasoning: true }),
  defineModel({ id: "glm-4.6v", providerId: "glm-cn", vision: true, reasoning: true }),
  defineModel({ id: "glm-4.6", providerId: "glm-cn", reasoning: true }),
  defineModel({ id: "glm-4.5-air", providerId: "glm-cn", reasoning: true }),
];

export const GLM_CN_SPEC: ApiKeyProviderSpec = {
  provider_id: "glm-cn",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
