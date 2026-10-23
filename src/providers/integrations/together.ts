import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Together AI — the 4 chat and 2 embedding model id(s) its published catalog lists. */
export const TOGETHER_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", providerId: "together" }),
  defineModel({ id: "deepseek-ai/DeepSeek-R1", providerId: "together", reasoning: true }),
  defineModel({ id: "Qwen/Qwen3-235B-A22B", providerId: "together", reasoning: true }),
  defineModel({ id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", providerId: "together", vision: true }),
  defineModel({ id: "BAAI/bge-large-en-v1.5", providerId: "together", wireFamily: "embeddings", endpoint: "/embeddings", toolCall: false }),
  defineModel({ id: "togethercomputer/m2-bert-80M-8k-retrieval", providerId: "together", wireFamily: "embeddings", endpoint: "/embeddings", toolCall: false }),
];

export const TOGETHER_SPEC: ApiKeyProviderSpec = {
  provider_id: "together",
  supported_wire_families: ["chat", "embeddings"],
  endpoint_paths_by_wire_family: { embeddings: "/embeddings" },
};
