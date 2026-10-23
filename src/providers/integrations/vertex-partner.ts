/**
 * Vertex AI partner models (MaaS) adapter.
 *
 * Partner models are served from the OpenAI-compatible `endpoints/openapi`
 * surface, not the `generateContent` envelope `vertex` and `vertex-partner`'s
 * Gemini sibling use:
 *
 *   `POST /v1/projects/{project}/locations/global/endpoints/openapi/chat/completions`
 *
 * The project is per credential, so the URL cannot be a static path in the
 * declarative spec — it is derived from the same Google credential `vertex`
 * already parses (service-account JSON, ADC JSON, or a raw API key). Partner
 * MaaS is global-only, so no location is configurable here.
 *
 * The wire is plain OpenAI chat, so request encoding and response decoding
 * reuse the shared chat codecs.
 */
import { GatewayError } from "../../transport/gateway-error";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import type { CanonicalEvent, CanonicalRequest } from "../../transport/canonical-model";
import { canonicalToChatPayload } from "../../protocol/request/chat";
import { postUpstreamJson } from "../../protocol/transport/openai";
import { decodeWireResponse, decodeWireStream } from "../../protocol/registry";
import {
  readCredentialSecret,
  type ModelDefinition,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
} from "../provider-registry";
import { defineModel } from "../model-definition";
import { providerBaseUrl } from "../provider-metadata";
import { isRecord } from "../../protocol/primitives";
import { mintVertexAccessToken, parseVertexCredential, type ParsedVertexCredential } from "./vertex";

export const VERTEX_PARTNER_PROVIDER_ID = "vertex-partner" as const;
export const VERTEX_PARTNER_BASE_URL = providerBaseUrl(VERTEX_PARTNER_PROVIDER_ID);

/** Partner MaaS is served from the multi-region `global` endpoint only. */
const VERTEX_PARTNER_LOCATION = "global";

/**
 * The four partner ids the upstream registry publishes. Limits and pricing are
 * left to the shared catalog fallback rather than guessed here.
 */
export const VERTEX_PARTNER_MODELS: readonly ModelDefinition[] = [
  "deepseek-ai/deepseek-v3.2-maas",
  "qwen/qwen3-next-80b-a3b-thinking-maas",
  "qwen/qwen3-next-80b-a3b-instruct-maas",
  "zai-org/glm-5-maas",
].map((id) => defineModel({ id, providerId: VERTEX_PARTNER_PROVIDER_ID, reasoning: true }));

export function buildVertexPartnerUrl(
  baseUrl: string,
  projectId: string,
  apiKey: string | undefined,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const url =
    `${base}/v1/projects/${encodeURIComponent(projectId)}/locations/${VERTEX_PARTNER_LOCATION}` +
    "/endpoints/openapi/chat/completions";
  return apiKey === undefined ? url : `${url}?key=${encodeURIComponent(apiKey)}`;
}

export interface VertexPartnerAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

interface VertexPartnerCredential {
  readonly projectId: string;
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly google?: ParsedVertexCredential;
}

/**
 * Resolves the project and the auth form.
 *
 * A service-account or ADC JSON carries its own project, and a raw API key has
 * nowhere to put one — Vertex's partner path is project-scoped, so the key form
 * needs an explicit `{apiKey, projectId}` object. Both shapes are operator input
 * and both are supported; anything else is rejected before dispatch.
 */
function parseVertexPartnerCredential(raw: string): VertexPartnerCredential {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new GatewayError("authentication_failed", 401, "Vertex partner credential is not valid JSON");
    }
    if (isRecord(parsed) && typeof parsed["projectId"] === "string" && parsed["projectId"].length > 0) {
      const apiKey = typeof parsed["apiKey"] === "string" ? parsed["apiKey"] : undefined;
      const accessToken = typeof parsed["accessToken"] === "string" ? parsed["accessToken"] : undefined;
      if (apiKey === undefined && accessToken === undefined) {
        throw new GatewayError(
          "authentication_failed",
          401,
          "Vertex partner credential needs apiKey or accessToken alongside projectId",
        );
      }
      return {
        projectId: parsed["projectId"],
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(accessToken === undefined ? {} : { accessToken }),
      };
    }
  }
  const google = parseVertexCredential(trimmed);
  if (google.projectId === undefined) {
    throw new GatewayError(
      "authentication_failed",
      401,
      'Vertex partner models are project-scoped — supply service-account JSON, ADC JSON, or {"apiKey": "…", "projectId": "…"}',
    );
  }
  return { projectId: google.projectId, google };
}

class VertexPartnerAdapter implements ProviderAdapter {
  readonly provider_id = VERTEX_PARTNER_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: VertexPartnerAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? VERTEX_PARTNER_BASE_URL).replace(/\/+$/, "");
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        `vertex-partner supports chat only, got ${candidate.wire_family}`,
      );
    }
    const secret = readCredentialSecret(context.credential, "Vertex partner credential is required");
    const credential = parseVertexPartnerCredential(secret);

    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
    };
    let apiKey: string | undefined;
    if (credential.apiKey !== undefined) {
      apiKey = credential.apiKey;
    } else if (credential.accessToken !== undefined) {
      headers["authorization"] = `Bearer ${credential.accessToken}`;
    } else if (credential.google !== undefined) {
      // The mint is bounded by the caller's abort signal, so a stalled token
      // endpoint cannot outlive the request that needed it.
      headers["authorization"] = `Bearer ${await mintVertexAccessToken(credential.google, secret, outboundFetch, context.abort_signal)}`;
    }

    const payload = canonicalToChatPayload(request);
    payload["model"] = candidate.model_id || request.model;

    const { res, signal, release } = await postUpstreamJson(
      buildVertexPartnerUrl(this.baseUrl, credential.projectId, apiKey),
      headers,
      payload,
      context,
      outboundFetch,
    );
    try {
      if (!res.ok) throw await mapUpstreamHttpError(res, VERTEX_PARTNER_PROVIDER_ID);
      if (request.stream && res.body !== null) {
        yield* decodeWireStream("chat", res.body, request, { signal });
        return;
      }
      const json = (await res.json()) as Record<string, unknown>;
      yield* decodeWireResponse("chat", json, request);
    } finally {
      release();
    }
  }
}

export function createVertexPartnerAdapter(options: VertexPartnerAdapterOptions = {}): ProviderAdapter {
  return new VertexPartnerAdapter(options);
}
