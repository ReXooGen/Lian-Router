import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** ClinePass — the 10 chat model id(s) its published catalog lists. */
export const CLINEPASS_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "cline-pass/glm-5.2", providerId: "clinepass", reasoning: true }),
  defineModel({ id: "cline-pass/kimi-k2.7-code", providerId: "clinepass", vision: true, reasoning: true }),
  defineModel({ id: "cline-pass/kimi-k2.6", providerId: "clinepass", vision: true, reasoning: true }),
  defineModel({ id: "cline-pass/deepseek-v4-pro", providerId: "clinepass", reasoning: true }),
  defineModel({ id: "cline-pass/deepseek-v4-flash", providerId: "clinepass", reasoning: true }),
  defineModel({ id: "cline-pass/mimo-v2.5", providerId: "clinepass", vision: true, reasoning: true }),
  defineModel({ id: "cline-pass/mimo-v2.5-pro", providerId: "clinepass", vision: true, reasoning: true }),
  defineModel({ id: "cline-pass/minimax-m3", providerId: "clinepass", vision: true, reasoning: true }),
  defineModel({ id: "cline-pass/qwen3.7-max", providerId: "clinepass", vision: true, reasoning: true }),
  defineModel({ id: "cline-pass/qwen3.7-plus", providerId: "clinepass", vision: true, reasoning: true }),
];

export const CLINEPASS_SPEC: ApiKeyProviderSpec = {
  provider_id: "clinepass",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
  extra_headers: {
    "http-referer": "https://cline.bot",
    "x-title": "Cline",
  },
};
