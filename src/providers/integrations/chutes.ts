import type { ApiKeyProviderSpec } from "./configured-provider";
import type { ModelDefinition } from "../model-definition";

/**
 * Chutes AI publishes no static model list: the roster is only served by
 * `GET /v1/models`, so the catalog stays empty and `loadModelDiscovery` fills it.
 */
export const CHUTES_MODELS: readonly ModelDefinition[] = [];

export const CHUTES_SPEC: ApiKeyProviderSpec = {
  provider_id: "chutes",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
