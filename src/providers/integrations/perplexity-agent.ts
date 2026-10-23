import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Perplexity Agent — the 11 chat model id(s) its published catalog lists. */
export const PERPLEXITY_AGENT_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "perplexity/sonar", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", webSearch: true }),
  defineModel({ id: "openai/gpt-5.5", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "openai/gpt-5.4", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "openai/gpt-5.4-mini", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "anthropic/claude-sonnet-4-6", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "anthropic/claude-opus-4-8", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", vision: true, document: true, reasoning: true, webSearch: true }),
  defineModel({ id: "google/gemini-3.1-pro-preview", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "xai/grok-4.20-reasoning", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", vision: true, reasoning: true, webSearch: true }),
  defineModel({ id: "perplexity/glm-5.2", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", reasoning: true }),
  defineModel({ id: "perplexity/kimi-k2.7-code", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", vision: true, reasoning: true }),
  defineModel({ id: "nvidia/nemotron-3-super-120b-a12b", providerId: "perplexity-agent", wireFamily: "responses", endpoint: "/v1/responses", reasoning: true }),
];

export const PERPLEXITY_AGENT_SPEC: ApiKeyProviderSpec = {
  provider_id: "perplexity-agent",
  supported_wire_families: ["responses"],
  endpoint_paths_by_wire_family: { responses: "/v1/responses" },
};
