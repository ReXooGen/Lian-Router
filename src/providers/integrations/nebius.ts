import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Nebius AI — the 1 chat and 1 embedding model id(s) its published catalog lists. */
export const NEBIUS_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "meta-llama/Llama-3.3-70B-Instruct", providerId: "nebius" }),
  defineModel({ id: "Qwen/Qwen3-Embedding-8B", providerId: "nebius", wireFamily: "embeddings", endpoint: "/embeddings", toolCall: false }),
];

export const NEBIUS_SPEC: ApiKeyProviderSpec = {
  provider_id: "nebius",
  supported_wire_families: ["chat", "embeddings"],
  endpoint_paths_by_wire_family: { embeddings: "/embeddings" },
};
