import type { ApiKeyProviderSpec } from "./configured-provider";
import type { ModelDefinition } from "../model-definition";

/**
 * Vercel AI Gateway resells every model its upstreams carry and publishes no
 * static list of its own — the roster is only served by `GET /v1/models`, so the
 * catalog stays empty and `loadModelDiscovery` fills it.
 */
export const VERCEL_AI_GATEWAY_MODELS: readonly ModelDefinition[] = [];

export const VERCEL_AI_GATEWAY_SPEC: ApiKeyProviderSpec = {
  provider_id: "vercel-ai-gateway",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
