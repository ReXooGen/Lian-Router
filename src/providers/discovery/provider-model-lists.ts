/**
 * Per-provider model-list entry points whose request shape differs from the
 * generic OpenAI `/models` fetch: a non-`/v1` path, a credential that is not
 * the raw secret, a payload that needs filtering, or a wire family other than
 * `chat`.
 *
 * Each function returns catalog rows already pinned to the wire family and
 * endpoint its provider's adapter dispatches on, so a discovered id can never
 * land on a path the adapter rejects. `null` means "no usable data", never an
 * error — the caller decides how to surface that.
 *
 * This module is itself only reached through a dynamic `loadModelDiscovery`
 * import, so its static imports of provider code stay off the boot path.
 */
import type { ModelDefinition } from "../model-definition";
import type { FetchLike } from "../quota/quota-contracts";
import { isRecord } from "../../protocol/primitives";
import { providerBaseUrl, sanitizeUpstreamLabel } from "../provider-metadata";
import { getCodexVersion } from "../operations/client-versions";
import { getKimiCommonHeaders, parseKimiCredential } from "../integrations/kimi/kimi-oauth";
import { parseMuseCodeCredential } from "../integrations/muse/muse";
import {
  discoverFlatModelList,
  discoverMinimaxAgentEnvelope,
  flatModelIds,
  readModelList,
  toDefinitions,
} from "./bespoke-model-discovery";

export interface ProviderDiscoveryInput {
  readonly credential: string;
  readonly fetcher?: FetchLike | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Credential decoders below fail closed. Both parsers throw on a malformed
 * blob, and a discovery that throws surfaces through `syncModels` as
 * `transport_unavailable` — blaming the upstream for a credential the operator
 * can fix. `null` keeps the contract honest: no data, not a provider fault.
 */
function readKimiCredential(credential: string): ReturnType<typeof parseKimiCredential> | null {
  if (credential.trim().length === 0) return null;
  try {
    return parseKimiCredential(credential);
  } catch {
    return null;
  }
}

function readMuseApiKey(credential: string): string | null {
  try {
    const { apiKey } = parseMuseCodeCredential(credential);
    return apiKey.length === 0 ? null : apiKey;
  } catch {
    return null;
  }
}

/** Fields every entry point here forwards to the shared request builder. */
function transport(input: ProviderDiscoveryInput): {
  fetcher?: FetchLike;
  signal?: AbortSignal;
} {
  return {
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

/**
 * Kimi Code serves Messages only, and its `/v1/models` roster sits under the
 * `/coding` base. The credential is `{accessToken, deviceId}` JSON (legacy
 * installs hold a raw token), and the roster endpoint wants the same CLI
 * identity headers as inference.
 */
export async function discoverKimiModels(
  input: ProviderDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const credential = readKimiCredential(input.credential);
  if (credential === null) return null;
  return discoverFlatModelList({
    providerId: "kimi",
    url: `${providerBaseUrl("kimi")}/v1/models`,
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      ...getKimiCommonHeaders(credential.deviceId),
    },
    wireFamily: "messages",
    endpointPath: "/v1/messages",
    ...transport(input),
  });
}

/**
 * The two MiniMax coding plans publish a flat roster on their Anthropic root
 * and authenticate with `x-api-key` — the same header their Messages wire
 * reads. Their ids dispatch on the beta Messages path the catalog declares.
 */
export async function discoverMinimaxModels(
  providerId: "minimax" | "minimax-cn",
  input: ProviderDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return discoverFlatModelList({
    providerId,
    url: `${providerBaseUrl(providerId)}/v1/models`,
    headers: { "x-api-key": input.credential, "anthropic-version": "2023-06-01" },
    wireFamily: "messages",
    endpointPath: "/v1/messages?beta=true",
    ...transport(input),
  });
}

/**
 * The MiniMax agent gateways answer their roster without a credential, so this
 * stays credential-free and TTL-cached. `x-api-key` is the adapter's own
 * placeholder: the gateway reads the bearer token for inference and only
 * checks that the header is present.
 */
export async function discoverMinimaxCodeModels(
  providerId: "minimax-code" | "minimax-code-global",
  input: ProviderDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const region = providerId === "minimax-code" ? "cn" : "en";
  return discoverMinimaxAgentEnvelope({
    providerId,
    // The roster lives on the origin's `/mavis/api/v1/models`, a sibling of the
    // bundled `/mavis/api/v1/llm` dispatch base — joining onto the base would
    // produce `/llm/models`, which the gateway does not serve.
    url: `${new URL(providerBaseUrl(providerId)).origin}/mavis/api/v1/models?region=${region}&buildEnv=prod`,
    headers: {
      "user-agent": "MiniMaxAgent",
      "x-mavis-agent-id": "main",
      "x-api-key": "sk-xxx",
    },
    wireFamily: "messages",
    endpointPath: "/v1/messages",
    ...transport(input),
  });
}

/**
 * Muse bills against a minted `api_key` inside the `{oauthAccessToken,
 * apiKey}` credential; the OAuth token only refreshes. The roster and the
 * Responses wire both read the minted key as a bearer.
 */
export async function discoverMuseModels(
  input: ProviderDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const apiKey = readMuseApiKey(input.credential);
  if (apiKey === null) return null;
  return discoverFlatModelList({
    providerId: "muse",
    url: `${providerBaseUrl("muse")}/v1/models`,
    headers: { authorization: `Bearer ${apiKey}`, "x-api-version": "1.0.0" },
    wireFamily: "responses",
    endpointPath: "/v1/responses",
    ...transport(input),
  });
}

/**
 * Codex publishes its roster on the ChatGPT backend, not the API host. The
 * query names the codex-rs release the gateway also reports at inference, and
 * `originator` marks the caller as that CLI — the same identity pair dispatch
 * sends, so a roster fetched here matches what the account may actually serve.
 */
export async function discoverCodexModels(
  input: ProviderDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const version = encodeURIComponent(getCodexVersion());
  return discoverFlatModelList({
    providerId: "codex",
    url: `${providerBaseUrl("codex")}/backend-api/codex/models?client_version=${version}`,
    headers: {
      authorization: `Bearer ${input.credential}`,
      originator: "codex_cli_rs",
    },
    wireFamily: "responses",
    endpointPath: "/backend-api/codex/responses",
    ...transport(input),
  });
}

/**
 * Gemini CLI (Cloud Code Assist) publishes its roster through an RPC, not a
 * REST collection: `POST v1internal:fetchAvailableModels` with an optional
 * `{project}` envelope, answered by a `models` field that is either an array of
 * entries or an object map keyed by model id.
 *
 * The response is not OpenAI-shaped, so it gets its own decoder. Object entries
 * flagged `isInternal` are the backend's own models and are dropped — the CLI
 * cannot route to them. Discovered rows pin the same `:generateContent` action
 * path the static catalog declares, because this adapter builds its URL from
 * the action and ignores a per-candidate endpoint.
 */
export async function discoverGeminiCliModels(
  input: ProviderDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const payload = await readModelList({
    providerId: "gemini-cli",
    url: `${providerBaseUrl("gemini-cli")}:fetchAvailableModels`,
    headers: { authorization: `Bearer ${input.credential}` },
    method: "POST",
    // Cloud Code Assist resolves a default project for a token that has not
    // onboarded one, and rejects an empty string — so the envelope is omitted
    // rather than sent blank.
    body: {},
    wireFamily: "chat",
    endpointPath: ":generateContent",
    ...transport(input),
  });
  if (!isRecord(payload)) return null;
  const roster = payload["models"];
  const ids: string[] = [];
  if (Array.isArray(roster)) {
    for (const entry of roster) {
      if (!isRecord(entry)) continue;
      const raw = entry["id"] ?? entry["model"] ?? entry["name"];
      const id = sanitizeUpstreamLabel(raw);
      if (id !== undefined) ids.push(id);
    }
  } else if (isRecord(roster)) {
    for (const [rawId, entry] of Object.entries(roster)) {
      if (isRecord(entry) && entry["isInternal"] === true) continue;
      const id = sanitizeUpstreamLabel(rawId);
      if (id !== undefined) ids.push(id);
    }
  }
  if (ids.length === 0) return null;
  return toDefinitions("gemini-cli", ids, "chat", ":generateContent");
}

/**
 * Perplexity publishes its roster on `/v1/models`, but every chat model
 * dispatches on the bare origin's `/chat/completions` — the `/v1` prefix is a
 * listing-only path (`POST /v1/chat/completions` answers 404 while
 * `/chat/completions` answers 401 for a rejected key). The endpoint is pinned
 * here because the generic fetcher would otherwise stamp `/v1/chat/completions`
 * onto every discovered row, which is exactly the unreachable path this pin
 * prevents.
 */
export async function discoverPerplexityModels(
  input: ProviderDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return discoverFlatModelList({
    providerId: "perplexity",
    url: `${providerBaseUrl("perplexity")}/v1/models`,
    headers: { authorization: `Bearer ${input.credential}` },
    wireFamily: "chat",
    endpointPath: "/chat/completions",
    ...transport(input),
  });
}

/**
 * Kimchi's roster lives on its own host (the dispatch base carries an
 * `/openai` prefix the metadata endpoint does not), and the client identifies
 * itself with the same `kimchi/<version>` user agent its traffic uses. The
 * catalog is a `{models: [...]}` envelope whose entries key the id as `slug`.
 */
export async function discoverKimchiModels(
  input: ProviderDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const payload = await readModelList({
    providerId: "kimchi",
    url: `${new URL(providerBaseUrl("kimchi")).origin}/v1/models/metadata?include_in_cli=true`,
    headers: { authorization: `Bearer ${input.credential}`, "user-agent": "kimchi/0.1.50" },
    wireFamily: "chat",
    endpointPath: "/chat/completions",
    ...transport(input),
  });
  if (!isRecord(payload)) return null;
  const entries = payload["models"];
  if (!Array.isArray(entries)) return null;
  const ids: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = entry["slug"] ?? entry["id"];
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  if (ids.length === 0) return null;
  return toDefinitions("kimchi", ids, "chat", "/chat/completions");
}

/**
 * Copilot's roster carries chat and embedding entries plus a per-model policy
 * state. Only chat entries that are not explicitly disabled belong in the
 * catalog, and they dispatch on the bare `/chat/completions` path — Copilot has
 * no `/v1` segment.
 */
export async function discoverGithubModels(
  input: ProviderDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const payload = await readModelList({
    providerId: "github",
    url: `${providerBaseUrl("github")}/models`,
    headers: {
      authorization: `Bearer ${input.credential}`,
      "copilot-integration-id": "vscode-chat",
      "editor-version": "vscode/1.110.0",
      "editor-plugin-version": "copilot-chat/0.38.0",
      "user-agent": "GitHubCopilotChat/0.38.0",
      "x-github-api-version": "2025-04-01",
    },
    wireFamily: "chat",
    endpointPath: "/chat/completions",
    ...transport(input),
  });
  if (!isRecord(payload)) return null;
  const entries = payload["data"];
  if (!Array.isArray(entries)) return null;
  const ids: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const capabilities = entry["capabilities"];
    const kind = isRecord(capabilities) ? capabilities["type"] : undefined;
    if (kind !== undefined && kind !== "chat") continue;
    const policy = entry["policy"];
    if (isRecord(policy) && policy["state"] === "disabled") continue;
    const id = entry["id"];
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  if (ids.length === 0) return null;
  return toDefinitions("github", ids, "chat", "/chat/completions");
}

/**
 * ClinePass shares Cline's roster endpoint and keeps only the `cline-pass/`
 * bucket. The list is public, so the same Bearer the adapter forwards is sent
 * when a key exists — Cline's API accepts either and never requires it.
 */
export async function discoverClinepassModels(
  input: ProviderDiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const payload = await readModelList({
    providerId: "clinepass",
    url: `${providerBaseUrl("clinepass")}/models`,
    headers:
      input.credential.length === 0
        ? {}
        : {
            authorization: `Bearer ${input.credential}`,
            "http-referer": "https://cline.bot",
            "x-title": "Cline",
          },
    wireFamily: "chat",
    endpointPath: "/chat/completions",
    ...transport(input),
  });
  const ids = flatModelIds(payload).filter((id) => id.startsWith("cline-pass/"));
  if (ids.length === 0) return null;
  return toDefinitions("clinepass", ids, "chat", "/chat/completions");
}
