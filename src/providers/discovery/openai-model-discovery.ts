import type { ModelDefinition } from "../provider-registry";
import { isRecord } from "../../protocol/primitives";
import {
  boundedUpstreamArray,
  boundedUpstreamNumber,
  sanitizeUpstreamLabel,
} from "../provider-metadata";
import { modelsDevCatalog } from "./models-dev-catalog";
import { isResponsesNativeModelId } from "../model-definition";
interface FetchModelsOptions {
  readonly baseUrl: string;
  /**
   * Canonical provider id for this discovery run. Passed through to the base
   * catalog so a model's context/output limits and pricing come from the row
   * for the provider actually serving it; omitting it opts into the
   * unambiguous-bare lookup, which fails closed when the catalog disagrees.
   */
  readonly providerId?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

/**
 * Tolerant OpenAI-compatible `/models` fetcher — provider-specific
 * `src/providers/discovery/openai-model-discovery.ts`. Handles `data|models|items`, various
 * pricing/context shapes, and responses wire family detection.
 */
export async function fetchOpenAICompatibleModels(
  options: FetchModelsOptions,
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`;
  const timeoutSignal = AbortSignal.timeout(10_000);
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  try {
    const response = await fetcher(url, {
      headers: {
        ...(options.headers ?? {}),
        accept: "application/json",
      },
      signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const entries = extractEntries(payload);
    if (entries === null) return null;
    const byId = new Map<string, ModelDefinition>();
    for (const entry of entries) {
      const id = sanitizeUpstreamLabel(entry.id);
      if (id === undefined) continue;
      const fallback = modelsDevCatalog.resolve(options.providerId ?? "", id);
      const parsedContext =
        positiveNumber(entry.context_length) ??
        positiveNumber((entry as Record<string, unknown>).input_token_limit) ??
        positiveNumber(entry.contextWindow) ??
        positiveNumber(entry.max_input_tokens);
      const contextWindow = parsedContext ?? fallback?.contextLimit ?? 200_000;

      const parsedOutput =
        positiveNumber(entry.max_output_tokens) ??
        positiveNumber((entry as Record<string, unknown>).max_completion_tokens) ??
        positiveNumber(entry.maxTokens);
      const maxOutputTokens = parsedOutput ?? fallback?.outputLimit ?? 64_192;
      const outputTokens = Math.min(maxOutputTokens, contextWindow);

      const cost = modelsDevCatalog.costFor(options.providerId ?? "", id);

      // Capability comes from the upstream's own fields, never from
      // the base catalog: that lookup is keyed by bare model id and keeps only
      // the first provider row, so it would attribute a stranger's capabilities
      // to this gateway's serving. An undeclared capability is left to the
      // routing ladder's filter → degrade path.
      const rawModality = typeof entry.modality === "string" ? entry.modality : "";
      const hasImage = rawModality.includes("image");
      // An OpenAI-style `/models` entry may declare what it *generates*, not
      // only what it accepts. The `kind` discriminant (image/video/chat) is the
      // unambiguous form; `output_modalities` is the OpenRouter-style array.
      // Without this, a text-to-image model was recorded as text-out, so the
      // generation catalog could not tell it apart from a chat model.
      const rawKind = typeof entry.kind === "string" ? entry.kind.trim().toLowerCase() : "";
      const declaredOutput = Array.isArray(entry.output_modalities)
        ? entry.output_modalities.filter((value): value is string => typeof value === "string")
        : Array.isArray(entry.outputModalities)
          ? entry.outputModalities.filter((value): value is string => typeof value === "string")
          : [];
      const output: string[] = rawKind === "image" ? ["image"] : rawKind === "video" ? ["video"] : ["text"];
      for (const modality of declaredOutput) {
        const normalized = modality.trim().toLowerCase();
        if ((normalized === "image" || normalized === "video") && !output.includes(normalized)) {
          output.push(normalized);
        }
      }
      // Input modalities beyond the `modality` string: OpenRouter-style
      // `architecture.input_modalities`, Ollama-style
      // `capabilities: ["vision","tools","thinking"]`, and generic
      // `input_modalities`. A model the upstream declares image-capable must
      // not lose that flag just because its `/models` row uses a different
      // field name than the convention the code happened to read.
      const archInput = (entry as Record<string, unknown>).architecture;
      const archInputList = isRecord(archInput) && Array.isArray(archInput.input_modalities)
        ? archInput.input_modalities.filter((v): v is string => typeof v === "string")
        : Array.isArray((entry as Record<string, unknown>).input_modalities)
          ? ((entry as Record<string, unknown>).input_modalities as unknown[]).filter(
              (v): v is string => typeof v === "string",
            )
          : [];
      // OpenAI-style nested object: `capabilities: { input: [...], output: [...] }`
      const nestedCaps = (entry as Record<string, unknown>).capabilities;
      const nestedInput = isRecord(nestedCaps) && Array.isArray(nestedCaps.input)
        ? nestedCaps.input.filter((v): v is string => typeof v === "string")
        : [];
      // Router-style nested object may also carry boolean flags directly.
      const nestedReasoning = isRecord(nestedCaps) && nestedCaps.reasoning === true;
      const nestedToolCall = isRecord(nestedCaps) && nestedCaps.tool_call === true;
      const declaredCaps = Array.isArray((entry as Record<string, unknown>).capabilities)
        ? ((entry as Record<string, unknown>).capabilities as unknown[]).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      const supportsImageInput =
        hasImage ||
        archInputList.some((v) => v.trim().toLowerCase() === "image") ||
        nestedInput.some((v) => v.trim().toLowerCase() === "image") ||
        declaredCaps.some((v) => v.trim().toLowerCase() === "vision");
      // Reasoning: `reasoning: true` / `thinking` capability, or OpenRouter's
      // `supported_parameters` carrying `reasoning`/`include_reasoning`.
      const supportedParams = Array.isArray((entry as Record<string, unknown>).supported_parameters)
        ? ((entry as Record<string, unknown>).supported_parameters as unknown[]).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      const paramsLower = supportedParams.map((v) => v.trim().toLowerCase());
      const supportsReasoning =
        entry.reasoning === true ||
        nestedReasoning ||
        (entry as Record<string, unknown>).thinking === true ||
        declaredCaps.some((v) => v.trim().toLowerCase() === "thinking") ||
        paramsLower.some((v) => v === "reasoning" || v === "include_reasoning");
      // Tool calling: explicit flag or the two ecosystem parameter spellings.
      const supportsTools =
        entry.tool_call === true ||
        nestedToolCall ||
        entry.tools === true ||
        declaredCaps.some((v) => v.trim().toLowerCase() === "tools") ||
        paramsLower.some((v) => v === "tools" || v === "tool_call" || v === "function_calling");
      const responsesWire = isResponsesNativeModelId(id);
      byId.set(id, {
        modelId: id,
        wireFamily: responsesWire ? "responses" : "chat",
        endpointPath: responsesWire ? "/v1/responses" : "/v1/chat/completions",
        contextLimit: contextWindow,
        outputLimit: outputTokens,
        modalities: {
          input: supportsImageInput ? ["text", "image"] : ["text"],
          output,
        },
        reasoning: supportsReasoning,
        toolCall: supportsTools,
        webSearch: false,
        cost,
      });
    }
    return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  } catch {
    return null;
  }
}

function positiveNumber(value: unknown): number | null {
  return boundedUpstreamNumber(value, { min: 1, max: 1_000_000_000 }) ?? null;
}




function extractEntries(payload: unknown): readonly Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (typeof payload !== "object" || payload === null) return null;
  const rec = payload as Record<string, unknown>;
  for (const key of ["data", "models", "items"] as const) {
    const value = rec[key];
    const bounded = boundedUpstreamArray(value);
    if (bounded) return bounded.filter(isRecord) as Record<string, unknown>[];
  }
  return null;
}
