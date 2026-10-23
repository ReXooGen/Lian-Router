/**
 * Azure OpenAI adapter.
 *
 * Two things put this outside the declarative `ApiKeyProviderSpec` factory:
 *
 *   1. The origin is per resource (`https://<resource>.openai.azure.com`) and
 *      the path is per deployment, so neither can live in
 *      `BUNDLED_PROVIDER_METADATA` as one shared constant. The operator supplies
 *      both in the credential — the same shape a BYOK row's own base URL has —
 *      and `BUNDLED_PROVIDER_METADATA.baseUrl` stays the service front door the
 *      identity is declared against.
 *   2. The credential header is `api-key`, which is neither of the two shapes
 *      `authHeaders()` emits (`Authorization: Bearer` / `x-api-key`).
 *
 * The wire itself is the OpenAI chat envelope, so request encoding and response
 * decoding reuse the shared chat codecs rather than a second implementation.
 *
 * The catalog is deliberately empty and there is no discovery: Azure's
 * `/openai/models` lists *base model* names available to the resource, while
 * dispatch addresses a *deployment*. Those names coincide only by operator
 * convention, so a discovered id would advertise a path that may not exist.
 * Deployments are registered as manual model rows, named exactly as deployed.
 */
import { GatewayError } from "../../transport/gateway-error";
import { mapUpstreamHttpError } from "../../transport/failure-policy";
import type { CanonicalEvent, CanonicalRequest } from "../../transport/canonical-model";
import { canonicalToChatPayload } from "../../protocol/request/chat";
import { postUpstreamJson } from "../../protocol/transport/openai";
import { decodeWireResponse, decodeWireStream } from "../../protocol/registry";
import { isRecord } from "../../protocol/primitives";
import {
  readCredentialSecret,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
} from "../provider-registry";
import { providerBaseUrl } from "../provider-metadata";

export const AZURE_PROVIDER_ID = "azure" as const;
export const AZURE_BASE_URL = providerBaseUrl(AZURE_PROVIDER_ID);

/**
 * Preview API version used when the credential names none. Pinned rather than
 * "latest": an Azure API version is part of the wire contract, and a silent
 * drift would change request semantics under an operator who never asked.
 */
const DEFAULT_AZURE_API_VERSION = "2024-10-21";

/**
 * Suffixes Azure OpenAI resources are reachable under, one per cloud. The
 * credential carries the resource endpoint, so this is the SSRF boundary: a
 * typo (or a pasted non-Azure URL) must not receive the operator's key.
 */
const AZURE_RESOURCE_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".openai.azure.us",
  ".openai.azure.cn",
] as const;

export interface AzureCredential {
  /** Resource endpoint, without a trailing slash. */
  readonly endpoint: string;
  readonly apiKey: string;
  /** Deployment every request targets; defaults to the routed model id. */
  readonly deployment?: string;
  readonly apiVersion: string;
  readonly organization?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Parses the operator-supplied credential. Accepted forms:
 *
 *   `{"endpoint": "https://res.openai.azure.com", "apiKey": "…", …}`
 *   `{"resource": "res", "apiKey": "…", …}`  (endpoint derived from the name)
 *
 * `deployment`, `apiVersion`, and `organization` are optional; a deployment is
 * otherwise taken from the routed model id, which is how one account can serve
 * several deployments registered as separate models.
 */
export function parseAzureCredential(raw: string): AzureCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new GatewayError(
      "authentication_failed",
      401,
      'Azure OpenAI requires a JSON credential: {"endpoint": "https://<resource>.openai.azure.com", "apiKey": "…"}',
    );
  }
  if (!isRecord(parsed)) {
    throw new GatewayError(
      "authentication_failed",
      401,
      "Azure OpenAI credential must be a JSON object with endpoint and apiKey",
    );
  }

  const apiKey = nonEmptyString(parsed["apiKey"]) ?? nonEmptyString(parsed["api_key"]);
  if (apiKey === undefined) {
    throw new GatewayError("authentication_failed", 401, "Azure OpenAI credential is missing apiKey");
  }

  const resource = nonEmptyString(parsed["resource"]);
  const endpointText =
    nonEmptyString(parsed["endpoint"]) ?? (resource === undefined ? undefined : `https://${resource}.openai.azure.com`);
  if (endpointText === undefined) {
    throw new GatewayError(
      "authentication_failed",
      401,
      "Azure OpenAI credential is missing endpoint (or resource name)",
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(endpointText);
  } catch {
    throw new GatewayError("authentication_failed", 401, "Azure OpenAI endpoint is not a valid URL");
  }
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "") {
    throw new GatewayError("authentication_failed", 401, "Azure OpenAI endpoint must be an https origin");
  }
  const host = endpoint.hostname.toLowerCase();
  if (!AZURE_RESOURCE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new GatewayError(
      "authentication_failed",
      401,
      `Azure OpenAI endpoint host must end with ${AZURE_RESOURCE_HOST_SUFFIXES.join(", ")}`,
    );
  }

  const deployment = nonEmptyString(parsed["deployment"]);
  const organization = nonEmptyString(parsed["organization"]);
  return {
    endpoint: endpoint.toString().replace(/\/+$/, ""),
    apiKey,
    ...(deployment === undefined ? {} : { deployment }),
    apiVersion: nonEmptyString(parsed["apiVersion"]) ?? DEFAULT_AZURE_API_VERSION,
    ...(organization === undefined ? {} : { organization }),
  };
}

/** Deployment-scoped chat URL; `api-version` is required by the service. */
export function buildAzureUrl(credential: AzureCredential, deployment: string): string {
  const path = `/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`;
  return `${credential.endpoint}${path}?api-version=${encodeURIComponent(credential.apiVersion)}`;
}

export interface AzureAdapterOptions {
  readonly fetch?: typeof fetch;
}

class AzureAdapter implements ProviderAdapter {
  readonly provider_id = AZURE_PROVIDER_ID;
  private readonly fetchFn: typeof fetch;

  constructor(options: AzureAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
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
        `azure supports chat only, got ${candidate.wire_family}`,
      );
    }
    const secret = readCredentialSecret(context.credential, "Azure OpenAI credential is required");
    const credential = parseAzureCredential(secret);
    const deployment = credential.deployment ?? (candidate.model_id || request.model);
    if (deployment.length === 0) {
      throw new GatewayError("invalid_request", 400, "Azure OpenAI deployment is required");
    }

    const payload = canonicalToChatPayload(request);
    payload["model"] = deployment;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      "api-key": credential.apiKey,
    };
    if (credential.organization !== undefined) headers["OpenAI-Organization"] = credential.organization;

    const outboundFetch: typeof fetch = (context.outbound_fetch as unknown as typeof fetch) ?? this.fetchFn;
    const { res, signal, release } = await postUpstreamJson(
      buildAzureUrl(credential, deployment),
      headers,
      payload,
      context,
      outboundFetch,
    );
    try {
      if (!res.ok) throw await mapUpstreamHttpError(res, AZURE_PROVIDER_ID);
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

export function createAzureAdapter(options: AzureAdapterOptions = {}): ProviderAdapter {
  return new AzureAdapter(options);
}
