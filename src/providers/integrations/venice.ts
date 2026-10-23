import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Venice AI — the 9 chat and 3 embedding model id(s) its published catalog lists. */
export const VENICE_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "venice-uncensored-1-2", providerId: "venice" }),
  defineModel({ id: "zai-org-glm-5", providerId: "venice", reasoning: true }),
  defineModel({ id: "qwen3-235b-a22b-instruct-2507", providerId: "venice", reasoning: true }),
  defineModel({ id: "qwen3-coder-480b-a35b-instruct-turbo", providerId: "venice", reasoning: true }),
  defineModel({ id: "qwen3-vl-235b-a22b", providerId: "venice", vision: true, reasoning: true }),
  defineModel({ id: "deepseek-v4-pro", providerId: "venice", reasoning: true }),
  defineModel({ id: "llama-3.3-70b", providerId: "venice" }),
  defineModel({ id: "hermes-3-llama-3.1-405b", providerId: "venice" }),
  defineModel({ id: "mistral-small-3-2-24b-instruct", providerId: "venice" }),
  defineModel({ id: "text-embedding-3-large", providerId: "venice", wireFamily: "embeddings", endpoint: "/embeddings", toolCall: false }),
  defineModel({ id: "text-embedding-bge-m3", providerId: "venice", wireFamily: "embeddings", endpoint: "/embeddings", toolCall: false }),
  defineModel({ id: "text-embedding-qwen3-8b", providerId: "venice", wireFamily: "embeddings", endpoint: "/embeddings", toolCall: false }),
];

export const VENICE_SPEC: ApiKeyProviderSpec = {
  provider_id: "venice",
  supported_wire_families: ["chat", "embeddings"],
  endpoint_paths_by_wire_family: { embeddings: "/embeddings" },
};
