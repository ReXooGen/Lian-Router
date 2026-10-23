import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/** Kilo Gateway — the 6 chat model id(s) its published catalog lists. */
export const KILO_GATEWAY_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "kilo-auto/free", providerId: "kilo-gateway", ctx: 256000 }),
  defineModel({ id: "nvidia/nemotron-3-super-120b-a12b:free", providerId: "kilo-gateway", ctx: 262144, reasoning: true }),
  defineModel({ id: "nvidia/nemotron-3-ultra-550b-a55b:free", providerId: "kilo-gateway", ctx: 1000000, reasoning: true }),
  defineModel({ id: "kwaipilot/kat-coder-pro-v2.5:free", providerId: "kilo-gateway", ctx: 256000 }),
  defineModel({ id: "kilo-auto/frontier", providerId: "kilo-gateway", ctx: 1000000 }),
  defineModel({ id: "kilo-auto/balanced", providerId: "kilo-gateway", ctx: 1000000 }),
];

export const KILO_GATEWAY_SPEC: ApiKeyProviderSpec = {
  provider_id: "kilo-gateway",
  supported_wire_families: ["chat"],
  endpoint_paths_by_wire_family: {},
};
