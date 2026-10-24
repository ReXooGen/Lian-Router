/**
 * Meta Model API — direct API-key access to Meta's first-party Responses wire.
 *
 * Distinct from `muse` (Muse Code): both land on the same `api.meta.ai/v1`
 * OpenAI-Responses-compatible surface and serve the same `muse-spark-*`
 * catalog, but the Model API is authenticated with an operator-supplied API
 * key from the Meta developer dashboard, whereas Muse Code mints its key from a
 * subscription OAuth device login. Because the wire and models are identical,
 * the adapter is the shared `createApiKeyAdapter` with the `/v1`-prefixed
 * paths, and the catalog is the same list `muse` uses — one declaration of the
 * `muse-spark` roster, not a copy that can drift.
 *
 * Only the spec and catalog are exported: the registry builds the adapter
 * lazily through `createApiKeyAdapter(META_SPEC)`, the same shape as every
 * other plain api-key provider, so this module stays out of the boot graph.
 * `base_url` is omitted on purpose — the origin has one declaration, the
 * bundled metadata row, and the factory resolves it via `providerBaseUrl`.
 */
import type { ApiKeyProviderSpec } from "./configured-provider";
import type { ModelDefinition } from "../provider-registry";
import { MUSE_CODE_MODELS } from "./muse/muse";

export const META_PROVIDER_ID = "meta" as const;

/** The `muse-spark` roster, shared with Muse Code (same upstream catalog). */
export const META_MODELS: readonly ModelDefinition[] = MUSE_CODE_MODELS;

export const META_SPEC: ApiKeyProviderSpec = {
  provider_id: META_PROVIDER_ID,
  endpoint_paths_by_wire_family: {
    chat: "/v1/chat/completions",
    responses: "/v1/responses",
  },
  supported_wire_families: ["chat", "responses"],
};
