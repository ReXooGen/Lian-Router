import { GENERIC_API_KEY_SPECS } from "./integrations/configured-openai-providers";
import { createApiKeyAdapter } from "./integrations/configured-provider";
import { ProviderRegistry, toRegistration, type ProviderAuthentication, type ProviderModule } from "./provider-registry";
import type { OAuthLoginClient } from "./authentication/oauth-flow-store";
import type { QuotaFetcher } from "./quota/quota-support";
import { BUNDLED_PROVIDER_METADATA, PROVIDER_COMPATIBILITY_PROFILES, providerRequiresAccount, providerUpstreamHost, providerDefaultWireFamily, type BundledProviderId } from "./provider-metadata";
import { modelsDevCatalog } from "./discovery/models-dev-catalog";
import type { ProviderModelDiscovery } from "./discovery/discovery-types";

/**
 * Builds a lazy OAuth authentication loader from a dynamic module import and the
 * exported client name. The same client usually acts as its own refresher, so
 * `withRefresher` mirrors the client as the refresher.
 */
function oauthCapability<M, K extends keyof M>(
  loader: () => Promise<M>,
  exportName: K,
  options: { readonly withRefresher?: boolean } = {},
): () => Promise<ProviderAuthentication> {
  return async () => {
    const module = await loader();
    const client = (module as Record<string, unknown>)[exportName as string] as OAuthLoginClient & { refresh: unknown };
    return options.withRefresher
      ? ({ client, refresher: client } as ProviderAuthentication)
      : ({ client } as ProviderAuthentication);
  };
}

/**
 * Builds a lazy quota-collector loader from a dynamic module import and the
 * exported collector function name.
 */
function quotaCapability<M, K extends keyof M>(
  loader: () => Promise<M>,
  exportName: K,
): () => Promise<QuotaFetcher> {
  return () => loader().then((module) => (module as Record<string, unknown>)[exportName as string] as QuotaFetcher);
}

/** Implementation details merged into the canonical ProviderModule rows. */
type ProviderModuleCapabilities = Partial<Omit<ProviderModule, "loadAdapter">> &
  Pick<ProviderModule, "loadAdapter">;

function configuredProvider(
  providerId: keyof typeof GENERIC_API_KEY_SPECS,
): ProviderModuleCapabilities {
  return {
    loadAdapter: async () => createApiKeyAdapter(GENERIC_API_KEY_SPECS[providerId]),
    // Every generic host serves an OpenAI-compatible `GET <base>/models` under
    // the same bearer its dispatch sends, so discovery is the shared fetcher.
    loadModelDiscovery: openAIModelDiscovery(providerId, {
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  };
}

function openAIModelDiscovery(
  providerId: string,
  options?: {
    readonly transformBaseUrl?: (baseUrl: string) => string;
    readonly headers?: (credential: string) => Readonly<Record<string, string>>;
  },
): () => Promise<ProviderModelDiscovery> {
  return async () => async ({ baseUrl, credential, fetcher }) => {
    const { fetchOpenAICompatibleModels } = await import("./discovery/openai-model-discovery");
    return fetchOpenAICompatibleModels({
      baseUrl: options?.transformBaseUrl?.(baseUrl) ?? baseUrl,
      providerId,
      ...(options?.headers ? { headers: options.headers(credential) } : {}),
      ...(fetcher ? { fetcher } : {}),
    });
  };
}

/**
 * Adapter, model, OAuth, and quota behavior keyed by canonical provider ID.
 *
 * Adapter and model references use dynamic `import()` so a provider's module
 * graph — including bespoke protobuf adapters and their large generated
 * declarations — is evaluated on first use rather than at startup. Model
 * catalogs are declared inline in each `api-key/` provider module, so a
 * catalog load evaluates the same module the adapter uses; the dynamic import
 * still keeps that evaluation off the startup path.
 */
export const PROVIDER_CAPABILITIES = {
  openai: {
    endpointPathsByWireFamily: { chat: "/v1/chat/completions", responses: "/v1/responses", embeddings: "/v1/embeddings" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/openai")).OPENAI_SPEC),
    loadModels: async () => (await import("./integrations/openai")).OPENAI_MODELS,
    // The bundled origin is the bare host; the roster lives under `/v1`.
    loadModelDiscovery: openAIModelDiscovery("openai", {
      transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/v1`,
      headers: (credential) => ({ authorization: `Bearer ${credential}` }),
    }),
  },
  anthropic: {
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () => (await import("./integrations/anthropic")).createAnthropicAdapter(),
    loadModels: async () => (await import("./integrations/anthropic")).ANTHROPIC_MODELS,
    // Anthropic's roster is `/v1/models`; the bundled origin is the bare host.
    loadModelDiscovery: openAIModelDiscovery("anthropic", {
      transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/v1`,
      headers: (credential) => ({ "x-api-key": credential, "anthropic-version": "2023-06-01" }),
    }),
  },
  browseruse: {
    // Two dialects under one origin. Declaring both paths here is what the
    // probe layer tests against; the adapter spec declares the same pair, and
    // `endpoint-map-parity` fails if they drift.
    endpointPathsByWireFamily: {
      chat: "/api/v4/llm/v1/chat/completions",
      messages: "/api/v4/llm/anthropic/v1/messages",
    },
    // Lazy like every row in this file: a static import would pull every
    // provider integration into the boot graph, and dispatch loads exactly
    // one. The specifier is a literal, so bundlers still see the edge.
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/browseruse")).BROWSERUSE_SPEC),
    loadModels: async () => (await import("./integrations/browseruse")).BROWSERUSE_MODELS,
  },
  claude: {
    loadAdapter: async () => (await import("./integrations/claude-code/claude")).claudeAdapter,
    loadModels: async () => (await import("./integrations/claude-code/claude")).CLAUDE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/claude-code/claude-oauth"), "claudeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/claude-code/claude-quota"), "fetchClaudeQuota"),
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverClaudeModels } = await import("./integrations/claude-code/claude-oauth");
      const { modelIds } = await discoverClaudeModels(credential, ...(fetcher ? [fetcher] : []));
      return modelIds.map((modelId) => ({
        modelId,
        wireFamily: "messages",
        endpointPath: "/v1/messages",
        contextLimit: null,
        outputLimit: null,
        modalities: { input: ["text"], output: ["text"] },
        reasoning: true,
        toolCall: true,
        webSearch: true,
        cost: modelsDevCatalog.costFor("claude", modelId),
      }));
    },
  },
  codex: {
    loadAdapter: async () => (await import("./integrations/codex/codex")).createCodexAdapter({ provider_id: "codex" }),
    loadModels: async () => (await import("./integrations/codex/codex")).CODEX_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/codex/codex-oauth"), "codexOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/codex/codex-quota"), "fetchCodexQuota"),
    // The ChatGPT backend publishes the roster the account may serve; the
    // static catalog is the fallback when it cannot be read.
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverCodexModels } = await import("./discovery/provider-model-lists");
      return discoverCodexModels({ credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  grok: {
    loadAdapter: async () => (await import("./integrations/grok/grok")).GrokAdapter,
    loadModels: async () => (await import("./integrations/grok/grok")).GROK_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/grok/grok-oauth"), "grokOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/grok/grok-quota"), "fetchGrokQuota"),
    loadModelDiscovery: async () => async ({ baseUrl, credential, fetcher }) => {
      // The CLI proxy's roster is `${origin}/v1/models`; the bundled base is the
      // bare origin, so `/models` alone would 404.
      const discovery = await openAIModelDiscovery("grok", {
        transformBaseUrl: (value) => `${value.replace(/\/+$/, "")}/v1`,
        headers: (token) => ({ authorization: `Bearer ${token}` }),
      })();
      const models = await discovery({ baseUrl, credential, ...(fetcher ? { fetcher } : {}) });
      if (!models) return null;
      // The advertised allowlist is derived from `GROK_MODELS` rather than
      // restated as a regex here. A second hand-maintained list previously
      // omitted `grok-4.7` while the catalog and the request builder both
      // accepted it, so live discovery silently dropped a model the gateway
      // was willing to serve. Deriving from the catalog keeps one source of
      // truth: a model the adapter serves is a model discovery may advertise.
      const { GROK_MODELS } = await import("./integrations/grok/grok");
      const advertised = new Set(GROK_MODELS.map((model) => model.modelId.toLowerCase()));
      return models.filter((model) => advertised.has(model.modelId.toLowerCase()));
    },
  },
  cursor: {
    loadAdapter: async () => (await import("./integrations/cursor/cursor")).cursorAdapter,
    loadModels: async () => (await import("./integrations/cursor/catalog")).CURSOR_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/cursor/cursor-oauth"), "cursorOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/cursor/cursor-quota"), "fetchCursorQuota"),
  },
  devin: {
    loadAdapter: async () => (await import("./integrations/devin/devin")).devinAdapter,
    loadModels: async () => (await import("./integrations/devin/catalog")).DEVIN_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/devin/devin-oauth"), "devinOAuthClient"),
    loadQuotaCollector: quotaCapability(() => import("./integrations/devin/devin-quota"), "fetchDevinQuota"),
  },
  antigravity: {
    loadAdapter: async () => (await import("./integrations/antigravity/antigravity")).antigravityAdapter,
    loadModels: async () => (await import("./integrations/antigravity/antigravity")).ANTIGRAVITY_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/antigravity/antigravity-oauth"), "antigravityOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/antigravity/antigravity-quota"), "fetchAntigravityQuota"),
    loadModelDiscovery: async () => async ({ baseUrl, credential, fetcher }) => {
      const { discoverAntigravityModels } = await import("./integrations/antigravity/antigravity-protocol");
      return discoverAntigravityModels(credential, { baseUrl, ...(fetcher ? { fetcher } : {}) });
    },
  },
  muse: {
    loadAdapter: async () => (await import("./integrations/muse/muse")).museCodeAdapter,
    loadModels: async () => (await import("./integrations/muse/muse")).MUSE_CODE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/muse/muse-oauth"), "museCodeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/muse/muse-quota"), "fetchMuseQuota"),
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverMuseModels } = await import("./discovery/provider-model-lists");
      return discoverMuseModels({ credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  meta: {
    // Same origin, wire, and catalog as Muse Code; the only difference is the
    // credential (an operator API key rather than a subscription-minted one),
    // so the shared factory builds the adapter from the spec. No
    // `loadAuthentication`: the default key-only credential path applies.
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/meta")).META_SPEC),
    loadModels: async () => (await import("./integrations/meta")).META_MODELS,
  },
  kimi: {
    loadAdapter: async () => (await import("./integrations/kimi/kimi")).kimiCodeAdapter,
    loadModels: async () => (await import("./integrations/kimi/kimi")).KIMI_CODE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/kimi/kimi-oauth"), "kimiCodeOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/kimi/kimi-quota"), "fetchKimiQuota"),
    // Messages-wire provider: the roster ids must land on `/v1/messages`.
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverKimiModels } = await import("./discovery/provider-model-lists");
      return discoverKimiModels({ credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  cerebras: {
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/cerebras")).CEREBRAS_SPEC),
    loadModels: async () => (await import("./integrations/cerebras")).CEREBRAS_MODELS,
    loadQuotaCollector: quotaCapability(() => import("./integrations/cerebras"), "fetchCerebrasQuota"),
    loadModelDiscovery: openAIModelDiscovery("cerebras", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  groq: {
    ...configuredProvider("groq"),
    loadModels: async () => (await import("./integrations/configured-openai-providers")).GROQ_MODELS,
    loadModelDiscovery: openAIModelDiscovery("groq", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  mistral: {
    ...configuredProvider("mistral"),
    loadModels: async () => (await import("./integrations/configured-openai-providers")).MISTRAL_MODELS,
    loadModelDiscovery: openAIModelDiscovery("mistral", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  siliconflow: {
    ...configuredProvider("siliconflow"),
    loadModels: async () => (await import("./integrations/configured-openai-providers")).SILICONFLOW_MODELS,
    loadModelDiscovery: openAIModelDiscovery("siliconflow", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  fireworks: {
    ...configuredProvider("fireworks"),
    loadModels: async () => (await import("./integrations/configured-openai-providers")).FIREWORKS_MODELS,
    loadModelDiscovery: openAIModelDiscovery("fireworks", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  nvidia: {
    ...configuredProvider("nvidia"),
    loadModels: async () => (await import("./integrations/configured-openai-providers")).NVIDIA_MODELS,
    loadModelDiscovery: openAIModelDiscovery("nvidia", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  gmi: {
    ...configuredProvider("gmi"),
    loadModels: async () => (await import("./integrations/configured-openai-providers")).GMI_MODELS,
    loadModelDiscovery: openAIModelDiscovery("gmi", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  opencodeft: {
    // `messages` carries the free tier's one Claude-format model
    // (`union-alpha`); the adapter declares the family only for this tier.
    endpointPathsByWireFamily: {
      chat: "/zen/v1/chat/completions",
      responses: "/zen/v1/responses",
      messages: "/zen/v1/messages",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/opencode")).OPENCODE_FREE_SPEC),
    loadModels: async () => (await import("./integrations/opencode")).OPENCODE_FREE_MODELS,
    loadModelDiscovery: openAIModelDiscovery("opencodeft", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/zen/v1` }),
    modelDiscoveryRequiresCredential: false,
  },
  opencodezen: {
    endpointPathsByWireFamily: {
      chat: "/zen/v1/chat/completions",
      responses: "/zen/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/opencode")).OPENCODE_ZEN_SPEC),
    loadModels: async () => (await import("./integrations/opencode")).OPENCODE_ZEN_MODELS,
    loadModelDiscovery: openAIModelDiscovery("opencodezen", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/zen/v1`, headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  opencodego: {
    // The billed Go tier serves the same two wire families as the shared Zen
    // base, under its own `/zen/go/v1` prefix. Declaring them here is what the
    // endpoint-parity test guards against the catalog's own rows: without the
    // map this provider declared no paths at all, so its gate was a no-op.
    endpointPathsByWireFamily: {
      chat: "/zen/go/v1/chat/completions",
      responses: "/zen/go/v1/responses",
    },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/opencode")).OPENCODE_GO_SPEC),
    loadModels: async () => (await import("./integrations/opencode")).OPENCODE_GO_MODELS,
    loadModelDiscovery: openAIModelDiscovery("opencodego", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/zen/go/v1`, headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  agentrouter: {
    loadAdapter: async () => (await import("./integrations/agentrouter")).createAgentRouterAdapter(),
    loadModels: async () => (await import("./integrations/agentrouter")).AGENTROUTER_MODELS,
  },
  gemini: {
    loadAdapter: async () => (await import("./integrations/gemini")).createGeminiAdapter(),
    loadModels: async () => (await import("./integrations/gemini")).GEMINI_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/gemini")).discoverGeminiModels({
        credential,
        ...(fetcher ? { fetcher } : {}),
      }),
  },
  vertex: {
    loadAdapter: async () => (await import("./integrations/vertex")).createVertexAdapter(),
    loadModels: async () => (await import("./integrations/vertex")).VERTEX_MODELS,
  },
  "gemini-cli": {
    loadAdapter: async () => (await import("./integrations/gemini-cli")).createGeminiCliAdapter(),
    loadModels: async () => (await import("./integrations/gemini-cli")).GEMINI_CLI_MODELS,
    // Cloud Code Assist publishes the roster through an RPC
    // (`v1internal:fetchAvailableModels`), not a REST `/models` collection, so
    // the decoder is provider-specific and pins the `:generateContent` action.
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverGeminiCliModels } = await import("./discovery/provider-model-lists");
      return discoverGeminiCliModels({ credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  cloudflare: {
    // Root-relative: the adapter joins `…/accounts/{accountId}/ai/v1` itself.
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => (await import("./integrations/cloudflare")).createCloudflareAdapter(),
    loadModels: async () => (await import("./integrations/cloudflare")).CLOUDFLARE_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/cloudflare")).discoverCloudflareModels({
        credential,
        ...(fetcher ? { fetcher } : {}),
      }),
  },
  aihubmix: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/aihubmix")).AIHUBMIX_SPEC),
    loadModels: async () => (await import("./integrations/aihubmix")).AIHUBMIX_FALLBACK_MODELS,
    loadModelDiscovery: openAIModelDiscovery("aihubmix", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  bai: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/bai")).BAI_SPEC),
    loadModels: async () => (await import("./integrations/bai")).BAI_FALLBACK_MODELS,
    loadModelDiscovery: openAIModelDiscovery("bai", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  tokenharbor: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/tokenharbor")).TOKENHARBOR_SPEC),
    loadModels: async () => (await import("./integrations/tokenharbor")).TOKENHARBOR_FALLBACK_MODELS,
    // The fallback catalog mirrors a 59-row `/models` snapshot; the live list is
    // authoritative and grows without a release.
    loadModelDiscovery: openAIModelDiscovery("tokenharbor", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  cline: {
    loadAdapter: async () => (await import("./integrations/cline/cline")).createClineAdapter(),
    loadModels: async () => (await import("./integrations/cline/cline")).CLINE_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/cline/cline-oauth"), "clineOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/cline/cline-quota"), "fetchClineQuota"),
    loadModelDiscovery: async () => async ({ fetcher }) => {
      const { fetchClineRecommendedModels } = await import("./integrations/cline/cline");
      return fetchClineRecommendedModels(undefined, true, fetcher ?? globalThis.fetch);
    },
    modelDiscoveryRequiresCredential: false,
  },
  cb: {
    loadAdapter: async () => (await import("./integrations/buddy/codebuddy")).createCodeBuddyAdapter(),
    loadModels: async () => (await import("./integrations/buddy/codebuddy")).CODEBUDDY_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/buddy/codebuddy-oauth"), "codeBuddyOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/buddy/codebuddy-quota"), "fetchCodeBuddyIntlQuota"),
  },
  cbcn: {
    loadAdapter: async () => (await import("./integrations/buddy/codebuddy-cn")).createCodeBuddyCnAdapter(),
    loadModels: async () => (await import("./integrations/buddy/codebuddy-cn")).CODEBUDDY_CN_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/buddy/codebuddy-oauth"), "codeBuddyCnOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/buddy/codebuddy-quota"), "fetchCodeBuddyCnQuota"),
  },
  workbuddy: {
    loadAdapter: async () => (await import("./integrations/buddy/workbuddy")).createWorkBuddyAdapter(),
    loadModels: async () => (await import("./integrations/buddy/workbuddy")).WORKBUDDY_MODELS,
    loadAuthentication: oauthCapability(() => import("./integrations/buddy/workbuddy-oauth"), "workBuddyOAuthClient", { withRefresher: true }),
    loadQuotaCollector: quotaCapability(() => import("./integrations/buddy/workbuddy-quota"), "fetchWorkBuddyQuota"),
  },
  commandcode: {
    loadAdapter: async () => (await import("./integrations/commandcode")).createCommandCodeAdapter(),
    loadModels: async () => (await import("./integrations/commandcode")).COMMANDCODE_MODELS,
  },
  qoder: {
    loadAdapter: async () => (await import("./integrations/qoder")).createQoderAdapter(),
    loadModels: async () => (await import("./integrations/qoder")).QODER_MODELS,
  },
  "qoder-cn": {
    loadAdapter: async () => (await import("./integrations/qoder")).createQoderCnAdapter(),
    loadModels: async () => (await import("./integrations/qoder")).QODER_CN_MODELS,
  },
  hermes: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/hermes")).HERMES_SPEC),
    loadModels: async () => (await import("./integrations/hermes")).HERMES_MODELS,
    // Nous publishes the whole free roster on `/models`; the six static rows
    // are only the subset the portal-tag path was verified against.
    loadModelDiscovery: openAIModelDiscovery("hermes", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  openrouter: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/openrouter")).OPENROUTER_SPEC),
    loadModels: async () => (await import("./integrations/openrouter")).OPENROUTER_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/openrouter")).discoverOpenrouterModels({
        credential,
        ...(fetcher ? { fetcher } : {}),
      }),
  },
  xiaomipg: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/xiaomi")).XIAOMIPG_SPEC),
    loadModels: async () => (await import("./integrations/xiaomi")).XIAOMI_MODELS,
    loadModelDiscovery: openAIModelDiscovery("xiaomipg", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  xiaomitp: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/xiaomi")).XIAOMITP_SPEC),
    loadModels: async () => (await import("./integrations/xiaomi")).XIAOMI_MODELS,
    // Token-plan keys are cluster-specific; discovery runs against the bundled
    // SGP origin, the same one this row dispatches to.
    loadModelDiscovery: openAIModelDiscovery("xiaomitp", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  zai: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/zai/spec")).ZAI_SPEC),
    loadModels: async () => (await import("./integrations/zai/spec")).ZAI_MODELS,
    loadQuotaCollector: quotaCapability(() => import("./integrations/zai/zai-quota"), "fetchZaiQuota"),
    loadModelDiscovery: async () => async ({ credential, fetcher }) =>
      (await import("./integrations/zai/spec")).discoverZaiModels({
        credential,
        ...(fetcher ? { fetcher } : {}),
      }),
  },
  perplexity: {
    // Two surfaces: `sonar` chat and the raw `/search` codec. `native` is a
    // per-provider codec family, so it is not declared here as a dispatchable
    // OpenAI-style path.
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => (await import("./integrations/perplexity")).createPerplexityAdapter(),
    loadModels: async () => (await import("./integrations/perplexity")).PERPLEXITY_MODELS,
    // Roster on `/v1/models`, chat dispatch on the bare origin's
    // `/chat/completions`; the pin keeps discovered rows off `/v1/chat/...`.
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverPerplexityModels } = await import("./discovery/provider-model-lists");
      return discoverPerplexityModels({ credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  ollamacloud: {
    // Only the two families its adapter spec declares. `native` and `messages`
    // were listed here with no catalog row and no support in the adapter, so
    // the probe resolved a wire family that would have been rejected with
    // `capability_unsupported` had a request ever reached dispatch.
    //
    // The paths are root-relative because the bundled base already ends in
    // `/v1`: the `/v1/...` spellings joined onto it produced
    // `/v1/v1/chat/completions`, which the host answers with 404 while
    // `/v1/chat/completions` answers 401 for a bad key.
    // `chat` only: the registry map may name a path the catalog serves, and
    // every bundled row is chat. The adapter spec still serves `responses` for
    // a discovered row that asks for it.
    endpointPathsByWireFamily: { chat: "/chat/completions" },
    loadAdapter: async () => createApiKeyAdapter(GENERIC_API_KEY_SPECS.ollamacloud),
    loadModels: async () => (await import("./integrations/configured-openai-providers")).OLLAMACLOUD_MODELS,
    loadQuotaCollector: quotaCapability(() => import("./integrations/ollama-cloud-quota"), "fetchOllamaQuota"),
    loadModelDiscovery: openAIModelDiscovery("ollamacloud", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  alicode: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/alibaba")).ALICODE_SPEC),
    loadModels: async () => (await import("./integrations/alibaba")).ALICODE_MODELS,
    loadModelDiscovery: openAIModelDiscovery("alicode", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  "alicode-intl": {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/alibaba")).ALICODE_INTL_SPEC),
    loadModels: async () => (await import("./integrations/alibaba")).ALICODE_INTL_MODELS,
    loadModelDiscovery: openAIModelDiscovery("alicode-intl", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  "alims-intl": {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/alibaba")).ALIMS_INTL_SPEC),
    loadModels: async () => (await import("./integrations/alibaba")).ALIMS_INTL_MODELS,
    loadModelDiscovery: openAIModelDiscovery("alims-intl", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  "alitp-intl": {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/alibaba")).ALITP_INTL_SPEC),
    loadModels: async () => (await import("./integrations/alibaba")).ALITP_INTL_MODELS,
    loadModelDiscovery: openAIModelDiscovery("alitp-intl", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  agnes: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/agnes")).AGNES_SPEC),
    loadModels: async () => (await import("./integrations/agnes")).AGNES_MODELS,
    loadModelDiscovery: openAIModelDiscovery("agnes", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  "api-airforce": {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/api-airforce")).API_AIRFORCE_SPEC),
    loadModels: async () => (await import("./integrations/api-airforce")).API_AIRFORCE_MODELS,
    loadModelDiscovery: openAIModelDiscovery("api-airforce", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  atria: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/atria")).ATRIA_SPEC),
    loadModels: async () => (await import("./integrations/atria")).ATRIA_MODELS,
    loadModelDiscovery: openAIModelDiscovery("atria", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  baidu: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/baidu")).BAIDU_SPEC),
    loadModels: async () => (await import("./integrations/baidu")).BAIDU_MODELS,
    loadModelDiscovery: openAIModelDiscovery("baidu", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  bazaarlink: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/bazaarlink")).BAZAARLINK_SPEC),
    loadModels: async () => (await import("./integrations/bazaarlink")).BAZAARLINK_MODELS,
    loadModelDiscovery: openAIModelDiscovery("bazaarlink", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  blackbox: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/blackbox")).BLACKBOX_SPEC),
    loadModels: async () => (await import("./integrations/blackbox")).BLACKBOX_MODELS,
  },
  byteplus: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/byteplus")).BYTEPLUS_SPEC),
    loadModels: async () => (await import("./integrations/byteplus")).BYTEPLUS_MODELS,
    loadModelDiscovery: openAIModelDiscovery("byteplus", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  chutes: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/chutes")).CHUTES_SPEC),
    loadModels: async () => (await import("./integrations/chutes")).CHUTES_MODELS,
    loadModelDiscovery: openAIModelDiscovery("chutes", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  clinepass: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/clinepass")).CLINEPASS_SPEC),
    loadModels: async () => (await import("./integrations/clinepass")).CLINEPASS_MODELS,
    // Shares Cline's roster endpoint, narrowed to the `cline-pass/` bucket. The
    // bucket is entitlement-scoped: an unentitled key sees Cline's own catalog
    // with no `cline-pass/` ids at all, so this stays credential-scoped rather
    // than caching a public list that cannot contain the provider's models.
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverClinepassModels } = await import("./discovery/provider-model-lists");
      return discoverClinepassModels({ credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  cohere: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/cohere")).COHERE_SPEC),
    loadModels: async () => (await import("./integrations/cohere")).COHERE_MODELS,
    loadModelDiscovery: openAIModelDiscovery("cohere", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  dahl: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/dahl")).DAHL_SPEC),
    loadModels: async () => (await import("./integrations/dahl")).DAHL_MODELS,
    loadModelDiscovery: openAIModelDiscovery("dahl", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  deepseek: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/deepseek")).DEEPSEEK_SPEC),
    loadModels: async () => (await import("./integrations/deepseek")).DEEPSEEK_MODELS,
    loadModelDiscovery: openAIModelDiscovery("deepseek", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  featherless: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/featherless")).FEATHERLESS_SPEC),
    loadModels: async () => (await import("./integrations/featherless")).FEATHERLESS_MODELS,
    loadModelDiscovery: openAIModelDiscovery("featherless", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  github: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/github")).GITHUB_SPEC),
    loadModels: async () => (await import("./integrations/github")).GITHUB_MODELS,
    // Copilot's roster is filtered to enabled chat entries; the static catalog
    // is the fallback for an account whose policy list is unreadable.
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverGithubModels } = await import("./discovery/provider-model-lists");
      return discoverGithubModels({ credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  "glm-cn": {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/glm-cn")).GLM_CN_SPEC),
    loadModels: async () => (await import("./integrations/glm-cn")).GLM_CN_MODELS,
  },
  hyperbolic: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/hyperbolic")).HYPERBOLIC_SPEC),
    loadModels: async () => (await import("./integrations/hyperbolic")).HYPERBOLIC_MODELS,
    loadModelDiscovery: openAIModelDiscovery("hyperbolic", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  iflow: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/iflow")).IFLOW_SPEC),
    loadModels: async () => (await import("./integrations/iflow")).IFLOW_MODELS,
  },
  "kilo-gateway": {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/kilo-gateway")).KILO_GATEWAY_SPEC),
    loadModels: async () => (await import("./integrations/kilo-gateway")).KILO_GATEWAY_MODELS,
    loadModelDiscovery: openAIModelDiscovery("kilo-gateway", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  kilocode: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/kilocode")).KILOCODE_SPEC),
    loadModels: async () => (await import("./integrations/kilocode")).KILOCODE_MODELS,
    // Kilo Code proxies the OpenRouter catalog, so the 8 static rows are only a
    // fallback. The gateway catalog answers without a credential, which keeps
    // this discovery TTL-cached instead of always-live.
    loadModelDiscovery: openAIModelDiscovery("kilocode", {
      transformBaseUrl: (baseUrl) => baseUrl.replace(/\/openrouter\/?$/, "/gateway"),
    }),
    modelDiscoveryRequiresCredential: false,
  },
  llm7: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/llm7")).LLM7_SPEC),
    loadModels: async () => (await import("./integrations/llm7")).LLM7_MODELS,
    loadModelDiscovery: openAIModelDiscovery("llm7", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  morph: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/morph")).MORPH_SPEC),
    loadModels: async () => (await import("./integrations/morph")).MORPH_MODELS,
    loadModelDiscovery: openAIModelDiscovery("morph", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  nebius: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/nebius")).NEBIUS_SPEC),
    loadModels: async () => (await import("./integrations/nebius")).NEBIUS_MODELS,
    loadModelDiscovery: openAIModelDiscovery("nebius", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  poolside: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/poolside")).POOLSIDE_SPEC),
    loadModels: async () => (await import("./integrations/poolside")).POOLSIDE_MODELS,
    loadModelDiscovery: openAIModelDiscovery("poolside", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  tencent: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/tencent")).TENCENT_SPEC),
    loadModels: async () => (await import("./integrations/tencent")).TENCENT_MODELS,
    loadModelDiscovery: openAIModelDiscovery("tencent", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  together: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/together")).TOGETHER_SPEC),
    loadModels: async () => (await import("./integrations/together")).TOGETHER_MODELS,
    loadModelDiscovery: openAIModelDiscovery("together", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  tokenrouter: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/tokenrouter")).TOKENROUTER_SPEC),
    loadModels: async () => (await import("./integrations/tokenrouter")).TOKENROUTER_MODELS,
    loadModelDiscovery: openAIModelDiscovery("tokenrouter", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  venice: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/venice")).VENICE_SPEC),
    loadModels: async () => (await import("./integrations/venice")).VENICE_MODELS,
    loadModelDiscovery: openAIModelDiscovery("venice", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  "vercel-ai-gateway": {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/vercel-ai-gateway")).VERCEL_AI_GATEWAY_SPEC),
    loadModels: async () => (await import("./integrations/vercel-ai-gateway")).VERCEL_AI_GATEWAY_MODELS,
    loadModelDiscovery: openAIModelDiscovery("vercel-ai-gateway", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  "volcengine-ark": {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/volcengine-ark")).VOLCENGINE_ARK_SPEC),
    loadModels: async () => (await import("./integrations/volcengine-ark")).VOLCENGINE_ARK_MODELS,
    loadModelDiscovery: openAIModelDiscovery("volcengine-ark", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  xai: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/xai")).XAI_SPEC),
    loadModels: async () => (await import("./integrations/xai")).XAI_MODELS,
    loadModelDiscovery: openAIModelDiscovery("xai", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  // Azure's origin is per resource and its path per deployment, both supplied in
  // the credential, so neither is a static path here. The catalog is empty on
  // purpose: `/openai/models` lists base model names, while dispatch addresses a
  // deployment, and the two coincide only by operator convention.
  azure: {
    loadAdapter: async () => (await import("./integrations/azure")).createAzureAdapter(),
    loadModels: async () => [],
  },
  gitlab: {
    loadAdapter: async () => (await import("./integrations/gitlab")).createGitlabAdapter(),
    loadModels: async () => [],
  },
  // Fingerprint-gated free channel: the operator holds no key, so dispatch
  // mints its own JWT from the bootstrap exchange on first use.
  "mimo-free": {
    loadAdapter: async () => (await import("./integrations/mimo-free")).createMimoFreeAdapter(),
    loadModels: async () => (await import("./integrations/mimo-free")).MIMO_FREE_MODELS,
  },
  mmf: {
    loadAdapter: async () => (await import("./integrations/mimo-free")).createMmfAdapter(),
    loadModels: async () => (await import("./integrations/mimo-free")).MMF_MODELS,
  },
  "vertex-partner": {
    loadAdapter: async () => (await import("./integrations/vertex-partner")).createVertexPartnerAdapter(),
    loadModels: async () => (await import("./integrations/vertex-partner")).VERTEX_PARTNER_MODELS,
  },
  zed: {
    loadAdapter: async () => (await import("./integrations/zed")).createZedAdapter(),
    loadModels: async () => (await import("./integrations/zed")).ZED_MODELS,
    // Zed's hosted catalog rotates, so the static list is empty and the live
    // `/models` (behind the minted LLM token) is the only honest source.
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverZedModels } = await import("./integrations/zed");
      return discoverZedModels({ credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  minimax: {
    endpointPathsByWireFamily: { messages: "/v1/messages?beta=true" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/minimax")).MINIMAX_SPEC),
    loadModels: async () => (await import("./integrations/minimax")).MINIMAX_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverMinimaxModels } = await import("./discovery/provider-model-lists");
      return discoverMinimaxModels("minimax", { credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  "minimax-cn": {
    endpointPathsByWireFamily: { messages: "/v1/messages?beta=true" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/minimax")).MINIMAX_CN_SPEC),
    loadModels: async () => (await import("./integrations/minimax")).MINIMAX_CN_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverMinimaxModels } = await import("./discovery/provider-model-lists");
      return discoverMinimaxModels("minimax-cn", { credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  "minimax-code": {
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/minimax")).MINIMAX_CODE_SPEC),
    loadModels: async () => (await import("./integrations/minimax")).MINIMAX_CODE_MODELS,
    // The agent gateway publishes its roster unauthenticated, so this is the
    // one MiniMax plan whose discovery can be cached.
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverMinimaxCodeModels } = await import("./discovery/provider-model-lists");
      return discoverMinimaxCodeModels("minimax-code", { credential, ...(fetcher ? { fetcher } : {}) });
    },
    modelDiscoveryRequiresCredential: false,
  },
  "minimax-code-global": {
    endpointPathsByWireFamily: { messages: "/v1/messages" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/minimax")).MINIMAX_CODE_GLOBAL_SPEC),
    loadModels: async () => (await import("./integrations/minimax")).MINIMAX_CODE_GLOBAL_MODELS,
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverMinimaxCodeModels } = await import("./discovery/provider-model-lists");
      return discoverMinimaxCodeModels("minimax-code-global", { credential, ...(fetcher ? { fetcher } : {}) });
    },
    modelDiscoveryRequiresCredential: false,
  },
  bluesminds: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/bluesminds")).BLUESMINDS_SPEC),
    loadModels: async () => (await import("./integrations/bluesminds")).BLUESMINDS_MODELS,
    loadModelDiscovery: openAIModelDiscovery("bluesminds", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  kimchi: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/kimchi")).KIMCHI_SPEC),
    loadModels: async () => (await import("./integrations/kimchi")).KIMCHI_MODELS,
    // The roster endpoint sits on Kimchi's origin, not under the `/openai`
    // dispatch base, and keys ids as `slug`.
    loadModelDiscovery: async () => async ({ credential, fetcher }) => {
      const { discoverKimchiModels } = await import("./discovery/provider-model-lists");
      return discoverKimchiModels({ credential, ...(fetcher ? { fetcher } : {}) });
    },
  },
  sambanova: {
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/sambanova")).SAMBANOVA_SPEC),
    loadModels: async () => (await import("./integrations/sambanova")).SAMBANOVA_MODELS,
    loadModelDiscovery: openAIModelDiscovery("sambanova", { headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
  "perplexity-agent": {
    endpointPathsByWireFamily: { responses: "/v1/responses" },
    loadAdapter: async () => createApiKeyAdapter((await import("./integrations/perplexity-agent")).PERPLEXITY_AGENT_SPEC),
    loadModels: async () => (await import("./integrations/perplexity-agent")).PERPLEXITY_AGENT_MODELS,
    // The Responses wire lives under `/v1` while the bundled base URL is the bare
    // origin, which is the host `/v1/models` answers discovery on.
    loadModelDiscovery: openAIModelDiscovery("perplexity-agent", { transformBaseUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/v1`, headers: (credential) => ({ authorization: `Bearer ${credential}` }) }),
  },
} satisfies Readonly<Record<BundledProviderId, ProviderModuleCapabilities>>;

/** Canonical provider registry; every provider subsystem consumes these rows. */
export const BUNDLED_PROVIDER_MODULES: readonly ProviderModule[] = BUNDLED_PROVIDER_METADATA.map((definition) => {
  const implementation = PROVIDER_CAPABILITIES[definition.id];
  if (implementation === undefined) throw new Error(`Missing provider implementation: ${definition.id}`);
  const compatibility = PROVIDER_COMPATIBILITY_PROFILES[definition.id];
  return {
    id: definition.id,
    displayName: definition.displayName,
    baseUrl: definition.baseUrl,
    defaultBypassProxy: definition.defaultBypassProxy,
    ...implementation,
    upstreamHost: providerUpstreamHost(definition.id),
    ...(compatibility === undefined ? {} : { compatibility }),
    wireFamilyDefault: providerDefaultWireFamily(definition.id),
    requiresAccount: providerRequiresAccount(definition.id),
  };
});

/**
 * Eagerly composes the default provider registry from the canonical
 * bundled module. Registration itself is direct and synchronous; each
 * provider's adapter and model catalog still load lazily through
 * capability loader, so protobuf-heavy adapters stay out of the
 * startup path.
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of BUNDLED_PROVIDER_MODULES) {
    registry.register(toRegistration(provider));
  }
  return registry;
}
