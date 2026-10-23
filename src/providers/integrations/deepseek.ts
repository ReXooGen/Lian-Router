import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** DeepSeek — the 8 chat model id(s) its published catalog lists. */
export const DEEPSEEK_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "deepseek-v4-pro", providerId: "deepseek", reasoning: true }),
  defineModel({ id: "deepseek-v4-pro-max", providerId: "deepseek", reasoning: true }),
  defineModel({ id: "deepseek-v4-pro-none", providerId: "deepseek", reasoning: true }),
  defineModel({ id: "deepseek-v4.1-flash", providerId: "deepseek", vision: true, reasoning: true }),
  defineModel({ id: "deepseek-v4-flash", providerId: "deepseek", reasoning: true }),
  defineModel({ id: "deepseek-v4-flash-vision-exp", providerId: "deepseek", vision: true, reasoning: true }),
  defineModel({ id: "deepseek-chat", providerId: "deepseek" }),
  defineModel({ id: "deepseek-reasoner", providerId: "deepseek", reasoning: true }),
];

export const DEEPSEEK_SPEC: ApiKeyProviderSpec = {
  provider_id: "deepseek",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
  // The catalog id is a routing alias; the upstream `model` field carries
  // the id the provider actually serves.
  prePayload: (payload) => {
    const model = payload["model"];
    if (typeof model !== "string") return;
    const upstream: Readonly<Record<string, string>> = {"deepseek-v4-pro-max": "deepseek-v4-pro", "deepseek-v4-pro-none": "deepseek-v4-pro"};
    const mapped = upstream[model];
    if (mapped !== undefined) payload["model"] = mapped;
  },
};
