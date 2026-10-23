/**
 * Discovery for providers whose `/models` payload is not the OpenAI chat
 * envelope, or whose wire is not `chat`.
 *
 * `fetchOpenAICompatibleModels` assumes two things this module cannot: that the
 * roster arrives as a flat `data|models|items` array of chat models, and that
 * every id dispatches on `/v1/chat/completions`. A Messages-only upstream that
 * answered through it would be discovered onto `chat` rows its adapter rejects
 * with `capability_unsupported` — a listing that looks populated and routes
 * nowhere. Each entry point here therefore names the wire family and endpoint
 * its provider's adapter actually serves, and reads only the ids.
 *
 * These live beside the contract rather than in `integrations/` because the
 * payload shape is a discovery concern: the adapters never see it.
 */
import type { WireFamily } from "../../transport/canonical-model";
import type { ModelDefinition } from "../model-definition";
import { isRecord } from "../../protocol/primitives";
import {
  boundedUpstreamArray,
  sanitizeUpstreamLabel,
} from "../provider-metadata";
import type { FetchLike } from "../quota/quota-contracts";
import { modelsDevCatalog } from "./models-dev-catalog";

/** One provider's model list endpoint plus the headers it authenticates with. */
export interface ModelListRequest {
  /** Canonical provider id the roster is served by; keys the billing catalog. */
  readonly providerId: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly wireFamily: WireFamily;
  readonly endpointPath: string;
  /** Defaults to `GET`; an RPC roster (Gemini CLI) posts its project envelope. */
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly fetcher?: FetchLike | undefined;
  readonly signal?: AbortSignal | undefined;
}

const DISCOVERY_TIMEOUT_MS = 10_000;

/** Runs one model-list request and returns its parsed JSON, or `null`. */
export async function readModelList(request: ModelListRequest): Promise<unknown> {
  const fetcher = request.fetcher ?? fetch;
  const timeoutSignal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const signal =
    request.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([request.signal, timeoutSignal]);
  try {
    const response = await fetcher(request.url, {
      method: request.method ?? "GET",
      headers: { ...request.headers, accept: "application/json" },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** Ids from a flat `data|models|items` array, the shape most gateways serve. */
export function flatModelIds(payload: unknown): readonly string[] {
  const entries = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? (boundedUpstreamArray(payload["data"]) ??
        boundedUpstreamArray(payload["models"]) ??
        boundedUpstreamArray(payload["items"]))
      : undefined;
  if (entries === undefined) return [];
  const ids: string[] = [];
  for (const entry of entries) {
    const id = sanitizeUpstreamLabel(isRecord(entry) ? entry["id"] : entry);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * Wraps discovered ids as catalog rows. Limits and pricing come from the
 * offline billing catalog — a `/models` roster states neither — keyed by the
 * provider actually serving the model, and stay `null` when the catalog has no
 * row, so a row keeps its own declaration instead of inheriting a stranger's.
 */
export function toDefinitions(
  providerId: string,
  ids: readonly string[],
  wireFamily: WireFamily,
  endpointPath: string,
): readonly ModelDefinition[] {
  const seen = new Set<string>();
  const definitions: ModelDefinition[] = [];
  for (const modelId of ids) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    const fallback = modelsDevCatalog.resolve(providerId, modelId);
    definitions.push({
      modelId,
      wireFamily,
      endpointPath,
      contextLimit: fallback?.contextLimit ?? null,
      outputLimit: fallback?.outputLimit ?? null,
      modalities: { input: ["text"], output: ["text"] },
      reasoning: false,
      toolCall: true,
      webSearch: false,
      cost: modelsDevCatalog.costFor(providerId, modelId),
    });
  }
  return definitions.sort((left, right) => left.modelId.localeCompare(right.modelId));
}

/**
 * A flat id roster served on any wire — the shape Kimi, MiniMax, Muse, and
 * Codex publish. `request.wireFamily`/`request.endpointPath` decide where the
 * discovered ids dispatch, so a Messages-only upstream never lands on chat.
 */
export async function discoverFlatModelList(
  request: ModelListRequest,
): Promise<readonly ModelDefinition[] | null> {
  const payload = await readModelList(request);
  if (payload === null) return null;
  const ids = flatModelIds(payload);
  if (ids.length === 0) return null;
  return toDefinitions(request.providerId, ids, request.wireFamily, request.endpointPath);
}

/**
 * MiniMax's agent gateways (`minimax-code`, `minimax-code-global`) publish a
 * nested product envelope instead of a flat list:
 * `{ providers: [{ providerId, config: { models: { "<id>": { … } } } }] }`.
 * The model keys are the roster; per-model metadata comes from this gateway's
 * own catalog.
 */
export async function discoverMinimaxAgentEnvelope(
  request: ModelListRequest,
): Promise<readonly ModelDefinition[] | null> {
  const payload = await readModelList(request);
  if (!isRecord(payload)) return null;
  const providers = boundedUpstreamArray(payload["providers"]);
  if (providers === undefined) return null;
  const ids: string[] = [];
  for (const provider of providers) {
    if (!isRecord(provider)) continue;
    const config = provider["config"];
    if (!isRecord(config)) continue;
    const models = config["models"];
    if (!isRecord(models)) continue;
    for (const rawId of Object.keys(models)) {
      const id = sanitizeUpstreamLabel(rawId);
      if (id !== undefined) ids.push(id);
    }
  }
  if (ids.length === 0) return null;
  return toDefinitions(request.providerId, ids, request.wireFamily, request.endpointPath);
}
