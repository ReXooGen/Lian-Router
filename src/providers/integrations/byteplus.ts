import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** BytePlus ModelArk — the 7 chat model id(s) its published catalog lists. */
export const BYTEPLUS_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "seed-2-0-pro-260328", providerId: "byteplus" }),
  defineModel({ id: "seed-2-0-code-preview-260328", providerId: "byteplus" }),
  defineModel({ id: "seed-2-0-mini-260215", providerId: "byteplus" }),
  defineModel({ id: "seed-2-0-lite-260228", providerId: "byteplus" }),
  defineModel({ id: "kimi-k2-thinking-251104", providerId: "byteplus", vision: true, reasoning: true }),
  defineModel({ id: "glm-4-7-251222", providerId: "byteplus", reasoning: true }),
  defineModel({ id: "gpt-oss-120b-250805", providerId: "byteplus", reasoning: true }),
];

export const BYTEPLUS_SPEC: ApiKeyProviderSpec = {
  provider_id: "byteplus",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
