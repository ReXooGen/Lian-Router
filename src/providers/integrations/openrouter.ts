import type { ApiKeyProviderSpec } from "./configured-provider";
import type { ModelDefinition } from "../provider-registry";
import { fetchOpenAICompatibleModels } from "../discovery/openai-model-discovery";
import { providerBaseUrl } from "../provider-metadata";
import { defineModel } from "../model-definition";
import type { DiscoveryInput } from "../discovery/discovery-types";

const OPENROUTER_PROVIDER_ID = "openrouter" as const;

/** OpenRouter requires these on every request for ranking/attribution. */
const OPENROUTER_REQUIRED_HEADERS: Readonly<Record<string, string>> = {
  "HTTP-Referer": "https://endpoint-proxy.local",
  "X-Title": "Endpoint Proxy",
};

/** OpenRouter adapter spec; the registry builds it via `createApiKeyAdapter`. */
export const OPENROUTER_SPEC: ApiKeyProviderSpec = {
  provider_id: OPENROUTER_PROVIDER_ID,
  // The bundled base already ends in `/api/v1`, so the paths are
  // root-relative. `/embeddings` is a real route (401 for a bad key, 404 for a
  // path that does not exist); the rest of the catalog is chat.
  endpoint_paths_by_wire_family: { embeddings: "/embeddings" },
  supported_wire_families: ["chat", "embeddings"],
  extra_headers: OPENROUTER_REQUIRED_HEADERS,
};

/**
 * OpenRouter's static catalog.
 *
 * Only the embedding rows are registered: the upstream roster is 389 chat
 * models that change weekly, so a static chat list would be a stale duplicate
 * of what `/models` already answers. The embedding surface is small, stable,
 * and is the one family the generic discovery fetcher cannot classify — a
 * `/models` entry carries no wire information, so a discovered embedding id
 * would land on a `chat` row the adapter dispatches to `/chat/completions`.
 *
 * The upstream entry also lists TTS, image, video, and `systemone` ids; this
 * gateway has no wire family for any of them.
 */
export const OPENROUTER_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "openai/text-embedding-3-large", providerId: "openrouter", wireFamily: "embeddings", toolCall: false }),
  defineModel({ id: "openai/text-embedding-3-small", providerId: "openrouter", wireFamily: "embeddings", toolCall: false }),
  defineModel({ id: "openai/text-embedding-ada-002", providerId: "openrouter", wireFamily: "embeddings", toolCall: false }),
  defineModel({ id: "qwen/qwen3-embedding-8b", providerId: "openrouter", wireFamily: "embeddings", toolCall: false }),
  defineModel({ id: "perplexity/pplx-embed-v1-4b", providerId: "openrouter", wireFamily: "embeddings", toolCall: false }),
  defineModel({ id: "perplexity/pplx-embed-v1-0.6b", providerId: "openrouter", wireFamily: "embeddings", toolCall: false }),
  defineModel({ id: "nvidia/llama-nemotron-embed-vl-1b-v2:free", providerId: "openrouter", wireFamily: "embeddings", toolCall: false }),
];

export async function discoverOpenrouterModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchOpenAICompatibleModels({
    baseUrl: providerBaseUrl("openrouter"),
    headers: {
      authorization: `Bearer ${input.credential}`,
      ...OPENROUTER_REQUIRED_HEADERS,
    },
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}
