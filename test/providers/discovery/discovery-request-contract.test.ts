import { afterEach, describe, expect, test } from "bun:test";
import { createDefaultProviderRegistry } from "../../../src/providers/default-registry";
import { BUNDLED_PROVIDER_METADATA, providerBaseUrl } from "../../../src/providers/provider-metadata";
import {
  VERSION_SOURCES,
  _resetCodexVersion,
  getCodexVersion,
} from "../../../src/providers/operations/client-versions";

/**
 * Every provider whose `loadModelDiscovery` is wired, with the request its
 * discovery must build. The fetcher seam is injected, so nothing here touches
 * the network: the assertion is over the URL and headers the capability
 * constructs, which is exactly what a live call would send.
 *
 * A wrong header is worse than no discovery at all — it looks wired in the
 * console and fails silently on every Sync — so the auth shape is part of the
 * contract below, not an afterthought.
 */
interface ExpectedDiscovery {
  /** Documented request URL, or the stable prefix when `deriveUrl` is set. */
  readonly url: string;
  /**
   * Builds the URL from runtime state for providers whose request embeds a
   * value the process resolves at runtime. The assertion uses this; `url`
   * stays as the human-readable shape in the test name.
   */
  readonly deriveUrl?: () => string;
  /** Exact request body for an RPC roster; omitted for a GET listing. */
  readonly body?: string;
  /** Header the upstream reads the credential from. */
  readonly authHeader: "authorization" | "x-api-key" | "x-goog-api-key" | "none";
  /** Methods other than GET are listed so a POST-only roster is explicit. */
  readonly method?: "POST";
  /** Extra headers that must be present verbatim. */
  readonly headers?: Readonly<Record<string, string>>;
}

const CREDENTIAL = "sk-discovery-test";

/**
 * Deliberately not the pinned fallback: if discovery ignored the resolver and
 * hardcoded the fallback, the seeded value would not appear in the URL.
 */
const SEEDED_CODEX_VERSION = "0.144.1";

afterEach(() => {
  _resetCodexVersion(null);
});

const EXPECTED: Readonly<Record<string, ExpectedDiscovery>> = {
  openai: { url: "https://api.openai.com/v1/models", authHeader: "authorization" },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    authHeader: "x-api-key",
    headers: { "anthropic-version": "2023-06-01" },
  },
  claude: {
    url: "https://api.anthropic.com/v1/models",
    authHeader: "authorization",
    headers: { "anthropic-version": "2023-06-01" },
  },
  codex: {
    // The version is resolved at runtime from the npm registry and cached
    // process-wide, so the literal is not assertable: any other test that
    // constructs a codex adapter warms that cache and moves the query value.
    // Assert the stable shape here and derive the query from the same resolver
    // the discovery path reads.
    url: "https://chatgpt.com/backend-api/codex/models?client_version=<resolved>",
    deriveUrl: () =>
      `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(getCodexVersion())}`,
    authHeader: "authorization",
    headers: { originator: "codex_cli_rs" },
  },
  grok: { url: "https://cli-chat-proxy.grok.com/v1/models", authHeader: "authorization" },
  antigravity: {
    url: "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    authHeader: "authorization",
    method: "POST",
  },
  muse: {
    url: "https://api.meta.ai/v1/models",
    authHeader: "authorization",
    headers: { "x-api-version": "1.0.0" },
  },
  kimi: { url: "https://api.kimi.com/coding/v1/models", authHeader: "authorization" },
  opencodeft: { url: "https://opencode.ai/zen/v1/models", authHeader: "none" },
  opencodezen: { url: "https://opencode.ai/zen/v1/models", authHeader: "authorization" },
  opencodego: { url: "https://opencode.ai/zen/go/v1/models", authHeader: "authorization" },
  cerebras: { url: "https://api.cerebras.ai/v1/models", authHeader: "authorization" },
  groq: { url: "https://api.groq.com/openai/v1/models", authHeader: "authorization" },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    authHeader: "authorization",
    headers: { "HTTP-Referer": "https://endpoint-proxy.local", "X-Title": "Endpoint Proxy" },
  },
  mistral: { url: "https://api.mistral.ai/v1/models", authHeader: "authorization" },
  siliconflow: { url: "https://api.siliconflow.cn/v1/models", authHeader: "authorization" },
  fireworks: { url: "https://api.fireworks.ai/inference/v1/models", authHeader: "authorization" },
  nvidia: { url: "https://integrate.api.nvidia.com/v1/models", authHeader: "authorization" },
  gmi: { url: "https://api.gmi-serving.com/v1/models", authHeader: "authorization" },
  zai: { url: "https://api.z.ai/api/paas/v4/models", authHeader: "authorization" },
  hermes: { url: "https://inference-api.nousresearch.com/v1/models", authHeader: "authorization" },
  bai: { url: "https://api.b.ai/v1/models", authHeader: "authorization" },
  aihubmix: { url: "https://aihubmix.com/v1/models", authHeader: "authorization" },
  tokenharbor: { url: "https://tokenharbor.ai/v1/models", authHeader: "authorization" },
  cline: { url: "https://api.cline.bot/api/v1/ai/cline/recommended-models", authHeader: "none" },
  cloudflare: {
    url: "https://api.cloudflare.com/client/v4/accounts/account-1/ai/v1/models",
    authHeader: "authorization",
  },
  ollamacloud: { url: "https://ollama.com/v1/models", authHeader: "authorization" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models", authHeader: "x-goog-api-key" },
  xiaomipg: { url: "https://api.xiaomimimo.com/v1/models", authHeader: "authorization" },
  xiaomitp: { url: "https://token-plan-sgp.xiaomimimo.com/v1/models", authHeader: "authorization" },
  agnes: { url: "https://apihub.agnes-ai.com/v1/models", authHeader: "authorization" },
  alicode: { url: "https://coding.dashscope.aliyuncs.com/v1/models", authHeader: "authorization" },
  "alicode-intl": { url: "https://coding-intl.dashscope.aliyuncs.com/v1/models", authHeader: "authorization" },
  "alims-intl": {
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    authHeader: "authorization",
  },
  "alitp-intl": {
    url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
    authHeader: "authorization",
  },
  byteplus: { url: "https://ark.ap-southeast.bytepluses.com/api/coding/v3/models", authHeader: "authorization" },
  "volcengine-ark": {
    url: "https://ark.cn-beijing.volces.com/api/coding/v3/models",
    authHeader: "authorization",
  },
  "api-airforce": { url: "https://api.airforce/v1/models", authHeader: "authorization" },
  atria: { url: "https://api.atria-asi.ai/v1/models", authHeader: "authorization" },
  baidu: { url: "https://qianfan.baidubce.com/v2/models", authHeader: "authorization" },
  bazaarlink: { url: "https://bazaarlink.ai/api/v1/models", authHeader: "authorization" },
  bluesminds: { url: "https://api.bluesminds.com/v1/models", authHeader: "authorization" },
  chutes: { url: "https://llm.chutes.ai/v1/models", authHeader: "authorization" },
  clinepass: { url: "https://api.cline.bot/api/v1/models", authHeader: "authorization" },
  cohere: { url: "https://api.cohere.ai/v1/models", authHeader: "authorization" },
  dahl: { url: "https://inference.dahl.global/v1/models", authHeader: "authorization" },
  deepseek: { url: "https://api.deepseek.com/models", authHeader: "authorization" },
  featherless: { url: "https://api.featherless.ai/v1/models", authHeader: "authorization" },
  github: { url: "https://api.githubcopilot.com/models", authHeader: "authorization" },
  hyperbolic: { url: "https://api.hyperbolic.xyz/v1/models", authHeader: "authorization" },
  "kilo-gateway": { url: "https://api.kilo.ai/api/gateway/models", authHeader: "authorization" },
  kilocode: { url: "https://api.kilo.ai/api/gateway/models", authHeader: "none" },
  kimchi: {
    url: "https://llm.kimchi.dev/v1/models/metadata?include_in_cli=true",
    authHeader: "authorization",
    headers: { "user-agent": "kimchi/0.1.50" },
  },
  llm7: { url: "https://api.llm7.io/v1/models", authHeader: "authorization" },
  minimax: {
    url: "https://api.minimax.io/anthropic/v1/models",
    authHeader: "x-api-key",
    headers: { "anthropic-version": "2023-06-01" },
  },
  "minimax-cn": {
    url: "https://api.minimaxi.com/anthropic/v1/models",
    authHeader: "x-api-key",
    headers: { "anthropic-version": "2023-06-01" },
  },
  // The agent gateways publish an unauthenticated roster; the `x-api-key` they
  // receive is the adapter's own placeholder, not the account secret.
  "minimax-code": {
    url: "https://agent.minimax.cn/mavis/api/v1/models?region=cn&buildEnv=prod",
    authHeader: "none",
    headers: { "x-api-key": "sk-xxx", "x-mavis-agent-id": "main" },
  },
  "minimax-code-global": {
    url: "https://agent.minimax.io/mavis/api/v1/models?region=en&buildEnv=prod",
    authHeader: "none",
    headers: { "x-api-key": "sk-xxx", "x-mavis-agent-id": "main" },
  },
  morph: { url: "https://api.morphllm.com/v1/models", authHeader: "authorization" },
  nebius: { url: "https://api.studio.nebius.ai/v1/models", authHeader: "authorization" },
  // RPC roster: POST with a `{project}` envelope, not a REST collection.
  "gemini-cli": {
    url: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    authHeader: "authorization",
    method: "POST",
    // An empty envelope: `project` is omitted rather than sent blank, because
    // Cloud Code Assist rejects an empty string and resolves a default project
    // for a token that has not onboarded one.
    body: "{}",
  },
  perplexity: { url: "https://api.perplexity.ai/v1/models", authHeader: "authorization" },
  "perplexity-agent": { url: "https://api.perplexity.ai/v1/models", authHeader: "authorization" },
  poolside: { url: "https://inference.poolside.ai/v1/models", authHeader: "authorization" },
  sambanova: { url: "https://api.sambanova.ai/v1/models", authHeader: "authorization" },
  tencent: { url: "https://api.hunyuan.cloud.tencent.com/v1/models", authHeader: "authorization" },
  together: { url: "https://api.together.xyz/v1/models", authHeader: "authorization" },
  tokenrouter: { url: "https://api.tokenrouter.com/v1/models", authHeader: "authorization" },
  venice: { url: "https://api.venice.ai/api/v1/models", authHeader: "authorization" },
  "vercel-ai-gateway": { url: "https://ai-gateway.vercel.sh/v1/models", authHeader: "authorization" },
  xai: { url: "https://api.x.ai/v1/models", authHeader: "authorization" },
  // Zed mints an LLM token first, then reads `/models`; the first request is
  // the one that proves the credential reached the right host.
  zed: {
    url: "https://cloud.zed.dev/client/llm_tokens",
    authHeader: "authorization",
    method: "POST",
  },
};

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

/**
 * Credential shape per provider. Most read the raw secret; the four that wrap
 * it (or mint one) are named here so the test sends what the account actually
 * stores.
 */
function credentialFor(providerId: string): string {
  if (providerId === "cloudflare") {
    return JSON.stringify({ accountId: "account-1", apiKey: CREDENTIAL });
  }
  if (providerId === "muse") {
    return JSON.stringify({ oauthAccessToken: "oauth-access", apiKey: CREDENTIAL });
  }
  if (providerId === "kimi") {
    return JSON.stringify({ accessToken: CREDENTIAL, deviceId: "device-1" });
  }
  if (providerId === "zed") {
    // `organizationId` is present so discovery mints the LLM token directly
    // instead of looking the organization up first.
    return JSON.stringify({ userId: "user-1", accessToken: CREDENTIAL, organizationId: "org-1" });
  }
  return CREDENTIAL;
}

/**
 * A minimal catalog body each provider's parser accepts, so the assertion is
 * about the request rather than about parsing. The minimax agent envelope and
 * the flat OpenAI list are both present; each parser picks its own key.
 */
function catalogBody(providerId: string): string {
  if (providerId === "minimax-code" || providerId === "minimax-code-global") {
    return JSON.stringify({ providers: [{ providerId: "minimax", config: { models: { "MiniMax-M3": {} } } }] });
  }
  if (providerId === "github") {
    return JSON.stringify({ data: [{ id: "gpt-5.2", capabilities: { type: "chat" }, policy: { state: "enabled" } }] });
  }
  if (providerId === "clinepass") {
    return JSON.stringify({ data: [{ id: "cline-pass/glm-5.2" }] });
  }
  if (providerId === "kimchi") {
    return JSON.stringify({ models: [{ slug: "minimax-m3" }] });
  }
  if (providerId === "gemini-cli") {
    // Object-shaped roster: one routable model plus one the backend marks as
    // internal, which must be dropped.
    return JSON.stringify({
      models: {
        "gemini-3.1-pro-preview": { displayName: "Gemini 3.1 Pro Preview" },
        "internal-routing-model": { isInternal: true },
      },
    });
  }
  return JSON.stringify({ data: [{ id: "discovered-model" }] });
}

async function recordDiscoveryRequests(providerId: string): Promise<readonly RecordedRequest[]> {
  const registry = createDefaultProviderRegistry();
  const discovery = await registry.resolveModelDiscovery(providerId);
  expect(discovery).toBeDefined();
  if (discovery === undefined) return [];
  const requests: RecordedRequest[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(catalogBody(providerId), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  await discovery({
    baseUrl: providerBaseUrl(providerId),
    credential: credentialFor(providerId),
    fetcher,
  });
  return requests;
}

describe("every wired provider's discovery builds its documented request", () => {
  test("the wired set matches the audited table", async () => {
    const registry = createDefaultProviderRegistry();
    const wired: string[] = [];
    for (const provider of BUNDLED_PROVIDER_METADATA) {
      if ((await registry.resolveModelDiscovery(provider.id)) !== undefined) wired.push(provider.id);
    }
    // A new entry here means a provider gained discovery; it must also gain a
    // row in EXPECTED, because this suite is what proves its request is right.
    expect(wired.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [providerId, expected] of Object.entries(EXPECTED)) {
    test(`${providerId} → ${expected.method ?? "GET"} ${expected.url}`, async () => {
      // The codex URL embeds a version the process resolves at runtime from the
      // npm registry and caches process-wide. Seed the resolver so this test
      // cannot race another suite that constructs a codex adapter, while the
      // assertion below still proves the URL is read from the resolver.
      if (providerId === "codex") _resetCodexVersion(SEEDED_CODEX_VERSION);
      const expectedUrl = expected.deriveUrl?.() ?? expected.url;
      const requests = await recordDiscoveryRequests(providerId);
      expect(requests.length).toBeGreaterThan(0);
      const request = requests[0];
      if (request === undefined) throw new Error(`${providerId} built no request`);
      expect(request.url).toBe(expectedUrl);
      expect(request.method).toBe(expected.method ?? "GET");
      if (expected.body !== undefined) expect(request.body).toBe(expected.body);
      if (expected.authHeader === "none") {
        // Public rosters must not leak a credential the upstream ignores. A
        // header the expectation names explicitly is a documented placeholder,
        // not the secret.
        const declared = new Set(Object.keys(expected.headers ?? {}).map((name) => name.toLowerCase()));
        for (const header of ["authorization", "x-api-key", "x-goog-api-key"]) {
          if (declared.has(header)) continue;
          expect(request.headers[header]).toBeUndefined();
        }
        if (declared.has("x-api-key")) expect(request.headers["x-api-key"]).not.toContain(CREDENTIAL);
      } else {
        expect(request.headers[expected.authHeader]).toBeDefined();
        expect(request.headers[expected.authHeader]).toContain(CREDENTIAL);
      }
      for (const [name, value] of Object.entries(expected.headers ?? {})) {
        expect(request.headers[name.toLowerCase()]).toBe(value);
      }
    });
  }
});

describe("codex client version resolver", () => {
  test("cold start reports the checked-in fallback without a network probe", () => {
    // `reset(null)` drops the resolved value and the shared TTL cache, so the
    // next `get()` is a genuine cold read. `get()` is documented as synchronous
    // and network-free, which is the property this asserts: the discovery URL
    // on a fresh process carries the pinned constant, not a stale live value.
    _resetCodexVersion(null);
    expect(getCodexVersion()).toBe(VERSION_SOURCES.codex.fallback);
  });
});

describe("discovery never registers a model on a wire the adapter rejects", () => {
  test("Messages-wire providers pin every discovered id to their own endpoint", async () => {
    const registry = createDefaultProviderRegistry();
    for (const providerId of ["kimi", "minimax", "minimax-cn", "minimax-code", "minimax-code-global"]) {
      const discovery = await registry.resolveModelDiscovery(providerId);
      if (discovery === undefined) throw new Error(`${providerId} has no discovery`);
      const models = await discovery({
        baseUrl: providerBaseUrl(providerId),
        credential: credentialFor(providerId),
        fetcher: (async () =>
          new Response(catalogBody(providerId), { status: 200 })) as unknown as typeof fetch,
      });
      expect(models).not.toBeNull();
      for (const model of models ?? []) {
        expect(model.wireFamily).toBe("messages");
        expect(model.endpointPath.startsWith("/v1/messages")).toBe(true);
      }
    }
  });

  test("a malformed wrapped credential yields no data instead of blaming the upstream", async () => {
    // Muse's parser throws on a blob that is not `{oauthAccessToken, apiKey}`.
    // A throw here surfaces through `syncModels` as `transport_unavailable`,
    // which reads as an upstream outage for a credential the operator can fix;
    // `null` is the honest answer and keeps the static catalog in place.
    const registry = createDefaultProviderRegistry();
    const discovery = await registry.resolveModelDiscovery("muse");
    if (discovery === undefined) throw new Error("muse has no discovery");
    const models = await discovery({
      baseUrl: providerBaseUrl("muse"),
      credential: "not-a-credential-blob",
      fetcher: (async () => new Response(catalogBody("muse"), { status: 200 })) as unknown as typeof fetch,
    });
    expect(models).toBeNull();
  });

  test("Gemini CLI reads the RPC roster and drops internal models", async () => {
    // The response is not OpenAI-shaped and the endpoint is an RPC action, so
    // this decoder is provider-specific: it must read the object map, skip
    // `isInternal` entries, and pin ids to the `:generateContent` action the
    // adapter builds its URL from.
    const registry = createDefaultProviderRegistry();
    const discovery = await registry.resolveModelDiscovery("gemini-cli");
    if (discovery === undefined) throw new Error("gemini-cli has no discovery");
    const models = await discovery({
      baseUrl: providerBaseUrl("gemini-cli"),
      credential: CREDENTIAL,
      fetcher: (async () => new Response(catalogBody("gemini-cli"), { status: 200 })) as unknown as typeof fetch,
    });
    expect(models?.map((model) => model.modelId)).toEqual(["gemini-3.1-pro-preview"]);
    for (const model of models ?? []) {
      expect(model.wireFamily).toBe("chat");
      expect(model.endpointPath).toBe(":generateContent");
    }
  });

  test("Perplexity pins discovered chat ids to the bare-origin chat path", async () => {
    // The roster is `/v1/models`, but `/v1/chat/completions` answers 404 while
    // `/chat/completions` answers 401 for a rejected key — so a discovered row
    // must not inherit the `/v1` prefix the listing path carries.
    const registry = createDefaultProviderRegistry();
    const discovery = await registry.resolveModelDiscovery("perplexity");
    if (discovery === undefined) throw new Error("perplexity has no discovery");
    const models = await discovery({
      baseUrl: providerBaseUrl("perplexity"),
      credential: CREDENTIAL,
      fetcher: (async () => new Response(catalogBody("perplexity"), { status: 200 })) as unknown as typeof fetch,
    });
    expect(models).not.toBeNull();
    for (const model of models ?? []) {
      expect(model.wireFamily).toBe("chat");
      expect(model.endpointPath).toBe("/chat/completions");
    }
  });

  test("Codex and Muse pin their ids to the Responses wire", async () => {
    const registry = createDefaultProviderRegistry();
    for (const providerId of ["codex", "muse"]) {
      const discovery = await registry.resolveModelDiscovery(providerId);
      if (discovery === undefined) throw new Error(`${providerId} has no discovery`);
      const models = await discovery({
        baseUrl: providerBaseUrl(providerId),
        credential: credentialFor(providerId),
        fetcher: (async () => new Response(catalogBody(providerId), { status: 200 })) as unknown as typeof fetch,
      });
      expect(models).not.toBeNull();
      for (const model of models ?? []) {
        expect(model.wireFamily).toBe("responses");
      }
    }
  });
});
