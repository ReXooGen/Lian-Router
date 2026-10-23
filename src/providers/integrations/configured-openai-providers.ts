import type { ApiKeyProviderSpec } from "./configured-provider";
import { defineModel, type ModelDefinition } from "../model-definition";

/**
 * Wire paths for a base that already carries its version segment.
 *
 * `BUILTIN_DEFAULT_ENDPOINTS.responses` is `/v1/responses` because the OpenAI
 * row's base is the bare host; joining that onto `…/v1` produces
 * `/v1/v1/responses`. Every base in this module ends in `/v1` (or
 * `/openai/v1`, `/inference/v1`), so the version lives in the base and the
 * paths stay root-relative.
 */
const VERSIONED_ROOT_ENDPOINTS = {
  chat: "/chat/completions",
  responses: "/responses",
  embeddings: "/embeddings",
} as const;

/**
 * Builtin providers whose entire adapter contract is "bearer auth against the
 * provider's `BUNDLED_PROVIDER_METADATA` base URL, OpenAI-compatible chat +
 * responses, `/v1`-prefixed paths". They carry no OAuth and no
 * provider-specific payload hook, so they share one spec shape rather than one
 * module each; their static catalogs live here too, beside the spec that serves
 * them.
 *
 * `base_url` is resolved per provider by `providerBaseUrl(provider_id)`.
 *
 * Every base below already carries its version segment (`/v1`,
 * `/openai/v1`, `/inference/v1`), so the wire paths are the root-relative
 * `BUILTIN_DEFAULT_ENDPOINTS` values. The `/v1`-prefixed `BARE_ROOT_ENDPOINTS`
 * pair belongs to operator-supplied bare hosts only; joining it onto these
 * bases produced `/v1/v1/chat/completions`, which every one of them answers
 * with 404.
 */
export const GENERIC_API_KEY_PROVIDER_IDS = [
  "groq",
  "mistral",
  "siliconflow",
  "fireworks",
  "nvidia",
  "gmi",
  "ollamacloud",
] as const;

type GenericApiKeyProviderId = (typeof GENERIC_API_KEY_PROVIDER_IDS)[number];

function genericApiKeySpec(
  providerId: GenericApiKeyProviderId,
  options: { readonly embeddings?: boolean; readonly responses?: boolean } = {},
): ApiKeyProviderSpec {
  const servesResponses = options.responses !== false;
  const servesEmbeddings = options.embeddings === true;
  return {
    provider_id: providerId,
    endpoint_paths_by_wire_family: {
      chat: VERSIONED_ROOT_ENDPOINTS.chat,
      ...(servesResponses ? { responses: VERSIONED_ROOT_ENDPOINTS.responses } : {}),
      ...(servesEmbeddings ? { embeddings: VERSIONED_ROOT_ENDPOINTS.embeddings } : {}),
    },
    supported_wire_families: [
      "chat",
      ...(servesResponses ? (["responses"] as const) : []),
      ...(servesEmbeddings ? (["embeddings"] as const) : []),
    ],
  };
}

export const GENERIC_API_KEY_SPECS = {
  groq: genericApiKeySpec("groq"),
  mistral: genericApiKeySpec("mistral", { embeddings: true }),
  // `POST /v1/responses` is not a route on this host: it answers 404 while
  // `/chat/completions` and `/embeddings` answer 401 for a bad key. Declaring
  // `responses` would advertise a family dispatch cannot serve.
  siliconflow: genericApiKeySpec("siliconflow", { responses: false }),
  fireworks: genericApiKeySpec("fireworks", { embeddings: true }),
  nvidia: genericApiKeySpec("nvidia"),
  gmi: genericApiKeySpec("gmi"),
  ollamacloud: genericApiKeySpec("ollamacloud"),
} satisfies Readonly<Record<GenericApiKeyProviderId, ApiKeyProviderSpec>>;

/**
 * Groq's published chat roster. The registry also lists three Whisper
 * transcription ids; this gateway has no audio wire family, so they are
 * deliberately absent rather than registered as `chat` rows that dispatch
 * cannot serve.
 */
export const GROQ_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "llama-3.3-70b-versatile", providerId: "groq" }),
  defineModel({ id: "meta-llama/llama-4-maverick-17b-128e-instruct", providerId: "groq" }),
  defineModel({ id: "qwen/qwen3-32b", providerId: "groq", reasoning: true }),
  defineModel({ id: "openai/gpt-oss-120b", providerId: "groq", reasoning: true }),
];

/** Mistral's published roster: three chat ids plus its embedding model. */
export const MISTRAL_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "mistral-large-latest", providerId: "mistral", vision: true }),
  defineModel({ id: "codestral-latest", providerId: "mistral" }),
  defineModel({ id: "mistral-medium-latest", providerId: "mistral", vision: true, reasoning: true }),
  defineModel({
    id: "mistral-embed",
    providerId: "mistral",
    wireFamily: "embeddings",
    toolCall: false,
  }),
];

/** SiliconFlow's published roster (16 chat ids). */
export const SILICONFLOW_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "deepseek-ai/DeepSeek-V4-Pro", providerId: "siliconflow", reasoning: true }),
  defineModel({ id: "deepseek-ai/DeepSeek-V4-Flash", providerId: "siliconflow", reasoning: true }),
  defineModel({ id: "deepseek-ai/DeepSeek-V3.2", providerId: "siliconflow", reasoning: true }),
  defineModel({ id: "deepseek-ai/DeepSeek-V3.2-Exp", providerId: "siliconflow", reasoning: true }),
  defineModel({ id: "deepseek-ai/DeepSeek-V3.1", providerId: "siliconflow", reasoning: true }),
  defineModel({ id: "deepseek-ai/DeepSeek-V3.1-Terminus", providerId: "siliconflow", reasoning: true }),
  defineModel({ id: "deepseek-ai/DeepSeek-R1", providerId: "siliconflow", reasoning: true }),
  defineModel({ id: "Qwen/Qwen3.5-397B-A17B", providerId: "siliconflow" }),
  defineModel({ id: "Qwen/Qwen3.5-122B-A10B", providerId: "siliconflow" }),
  defineModel({ id: "zai-org/GLM-5.1", providerId: "siliconflow", reasoning: true }),
  defineModel({ id: "zai-org/GLM-5", providerId: "siliconflow", reasoning: true }),
  defineModel({ id: "moonshotai/Kimi-K2.6", providerId: "siliconflow", vision: true, reasoning: true }),
  defineModel({ id: "moonshotai/Kimi-K2.5", providerId: "siliconflow", vision: true, reasoning: true }),
  defineModel({ id: "openai/gpt-oss-120b", providerId: "siliconflow", reasoning: true }),
  defineModel({ id: "MiniMaxAI/MiniMax-M2.5", providerId: "siliconflow" }),
  defineModel({ id: "inclusionAI/Ling-flash-2.0", providerId: "siliconflow" }),
];

/** Fireworks' published roster: three chat ids plus one embedding model. */
export const FIREWORKS_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "accounts/fireworks/models/deepseek-v3p1", providerId: "fireworks", reasoning: true }),
  defineModel({ id: "accounts/fireworks/models/llama-v3p3-70b-instruct", providerId: "fireworks" }),
  defineModel({ id: "accounts/fireworks/models/qwen3-235b-a22b", providerId: "fireworks", reasoning: true }),
  defineModel({
    id: "nomic-ai/nomic-embed-text-v1.5",
    providerId: "fireworks",
    wireFamily: "embeddings",
    toolCall: false,
  }),
];

/**
 * NVIDIA NIM's published chat roster. The registry entry also lists one
 * embedding model (retired upstream: `nvidia/nv-embedqa-e5-v5` answers 410
 * "reached its end of life" on 2026-08-25) and three audio ids (`parakeet-*`
 * speech-to-text, `fastpitch`/`tacotron2` text-to-speech). A retired id would
 * be an unroutable row and this gateway has no audio wire family, so neither
 * class is registered.
 */
export const NVIDIA_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "minimaxai/minimax-m2.7", providerId: "nvidia", reasoning: true }),
  defineModel({ id: "minimaxai/minimax-m3", providerId: "nvidia", vision: true, reasoning: true }),
  defineModel({ id: "z-ai/glm-5.2", providerId: "nvidia", reasoning: true }),
  defineModel({ id: "deepseek-ai/deepseek-v4-pro", providerId: "nvidia", reasoning: true }),
  defineModel({ id: "deepseek-ai/deepseek-v4-flash", providerId: "nvidia", reasoning: true }),
  defineModel({ id: "moonshotai/kimi-k2.6", providerId: "nvidia", vision: true, reasoning: true }),
  defineModel({ id: "nvidia/nemotron-3-ultra-550b-a55b", providerId: "nvidia", reasoning: true }),
];

/**
 * Ollama Cloud's published roster.
 *
 * The catalog is what keeps this provider routable at all: it declares no
 * endpoint map of its own beyond the two wire families its spec serves, so
 * without a row to carry an endpoint the probe/registration fallback hands
 * dispatch the generic `/v1/...` path, which joins onto the `/v1` base as
 * `/v1/v1/chat/completions` — a 404. Rows pin the root-relative path instead.
 */
export const OLLAMACLOUD_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "gpt-oss:120b", providerId: "ollamacloud", reasoning: true }),
  defineModel({ id: "kimi-k2.5", providerId: "ollamacloud", vision: true, reasoning: true }),
  defineModel({ id: "glm-5", providerId: "ollamacloud", reasoning: true }),
  defineModel({ id: "minimax-m2.5", providerId: "ollamacloud", reasoning: true }),
  defineModel({ id: "glm-4.7-flash", providerId: "ollamacloud", reasoning: true }),
  defineModel({ id: "qwen3.5", providerId: "ollamacloud" }),
  defineModel({ id: "minimax-m3", providerId: "ollamacloud", vision: true, reasoning: true }),
  defineModel({ id: "deepseek-v4.1-flash:cloud", providerId: "ollamacloud", reasoning: true }),
];

/**
 * GMI Cloud's static catalog.
 *
 * The upstream registry this workspace mirrors has no `gmi` entry at all
 * (verified against both the local checkout and the published registry
 * directory), so no id can be transcribed from it. The provider is instead
 * served by live discovery against its documented OpenAI-compatible
 * `/v1/models`, which is what `loadModelDiscovery` wires in
 * `default-registry.ts`. A static list here would have to be invented.
 */
export const GMI_MODELS: readonly ModelDefinition[] = [];
