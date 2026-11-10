// Drizzle-backed generation store: resolves a tenant-visible provider/model,
// one health-eligible account, the provider's credential and egress, then
// proxies the upstream's OpenAI-style image/video task API.
//
// The upstream contract this surface speaks is deliberately narrow:
//   POST <base>/images/generations  { prompt, model, n, size, response_format, async }
//   GET  <base>/images/generations/<task>
//   POST <base>/videos              { prompt, model, size, duration }
//   GET  <base>/videos/<task>
// Generation models are identified by their persisted output modalities
// (image/video), not by a name heuristic: model-discovery records the
// upstream's own `kind`/`output_modalities`.
import { and, eq, isNull, or } from "drizzle-orm";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { models, providerAccounts, providers } from "../../persistence/schema";
import { providerBaseUrl, providerDisplayName } from "../../providers/provider-metadata";
import type {
  ProbeOutboundBinding,
  ProbeOutboundResolver,
} from "../../providers/discovery/probing-service";
import {
  resolveCredentialForAccount,
  type ResolveCredentialOAuth,
} from "../../providers/operations/provider-credential-service";
import {
  readCredentialSecret,
  type ResolvedCredential,
  type ValidatedOutboundFetch,
} from "../../providers/provider-registry";
import { GATEWAY_USER_AGENT } from "../../providers/operations/gateway-user-agent";
import { isRecord } from "../../protocol/primitives";
import { ConsoleDomainError } from "../shared/errors";
import type {
  GenerationCatalog,
  GenerationImageInput,
  GenerationImageItem,
  GenerationImageTask,
  GenerationKind,
  GenerationMedia,
  GenerationModel,
  GenerationStore,
  GenerationTaskStatus,
  GenerationVideoAsset,
  GenerationVideoInput,
  GenerationVideoTask,
} from "./contracts";

/** Submission and polling are cheap once the upstream runs the job in the background. */
const GENERATION_REQUEST_TIMEOUT_MS = 30_000;
/** Media can be a multi-megabyte video; the bound is the transfer, not the job. */
const GENERATION_MEDIA_TIMEOUT_MS = 120_000;
/** Accounts tried for one generation when a credential row is unusable. */
const GENERATION_ACCOUNT_ATTEMPTS = 5;

export interface GenerationStoreDeps {
  readonly outboundFetchFor: ProbeOutboundResolver;
  /** OAuth refresh collaborators; API-key providers ignore them. */
  readonly oauth?: ResolveCredentialOAuth;
  /**
   * Credential seam for tests and alternate composition roots. Production
   * leaves it unset and reads the account row through the shared resolver, so
   * generation can never drift onto a different credential path.
   */
  readonly resolveCredential?: (
    providerId: string,
    accountId: string,
  ) => Promise<ResolvedCredential>;
}

interface ProviderTarget {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly tenantId: string | null;
}

function upstreamOutputs(modalities: unknown): readonly string[] {
  if (!isRecord(modalities)) return [];
  const output = modalities["output"];
  if (!Array.isArray(output)) return [];
  return output.filter((value): value is string => typeof value === "string");
}

function normalizeStatus(value: unknown): GenerationTaskStatus {
  switch (value) {
    case "queued":
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "unknown";
  }
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim().slice(0, 500);
  if (isRecord(value)) {
    const message = value["message"];
    if (typeof message === "string" && message.trim().length > 0) return message.trim().slice(0, 500);
  }
  return undefined;
}

/** Joins a configured base (which may already end in `/v1`) onto one path. */
function joinUpstream(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The resolver may hand back a bare fetch; generation needs its release hook. */
function toBinding(resolved: ValidatedOutboundFetch | ProbeOutboundBinding): ProbeOutboundBinding {
  return typeof resolved === "function" ? { fetch: resolved } : resolved;
}

/** A bundled provider's origin lives in metadata when the row leaves base_url null. */
function configuredBaseUrl(providerId: string, baseUrl: string | null): string | undefined {
  if (baseUrl !== null && baseUrl.trim().length > 0) return baseUrl.trim();
  try {
    const bundled = providerBaseUrl(providerId).trim();
    return bundled.length > 0 ? bundled : undefined;
  } catch {
    return undefined;
  }
}

function parseBaseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {
    // Fall through to the typed configuration error.
  }
  throw new ConsoleDomainError(
    "generation_provider_misconfigured",
    500,
    "Generation provider base URL is not an http(s) URL",
  );
}

/**
 * Rewrites a provider-hosted media URL onto the console proxy. Only the
 * provider's own origin and its `/v1/media/` namespace qualify; anything else
 * (signed CDN links, data URLs) is returned untouched and loaded directly.
 */
function consoleMediaUrl(
  providerId: string,
  providerOrigin: string,
  rawUrl: string,
): string {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== providerOrigin) return rawUrl;
    const prefix = "/v1/media/";
    if (!url.pathname.startsWith(prefix)) return rawUrl;
    const name = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/.test(name)) return rawUrl;
    return `/console/api/generation/media?providerId=${encodeURIComponent(providerId)}&name=${encodeURIComponent(name)}`;
  } catch {
    return rawUrl;
  }
}

export class DrizzleGenerationStore implements GenerationStore {
  constructor(
    private readonly db: LianRouterDatabase,
    private readonly deps: GenerationStoreDeps,
  ) {}

  async catalog(tenantId: string): Promise<GenerationCatalog> {
    const rows = await this.db
      .select({
        providerId: providers.id,
        modelId: models.modelId,
        modalities: models.modalities,
      })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.enabled, true),
          eq(providers.enabled, true),
          or(isNull(providers.tenantId), eq(providers.tenantId, tenantId)),
        ),
      );
    const entries: GenerationModel[] = [];
    for (const row of rows) {
      const output = upstreamOutputs(row.modalities);
      const kind: GenerationKind | undefined = output.includes("image")
        ? "image"
        : output.includes("video")
          ? "video"
          : undefined;
      if (kind === undefined) continue;
      entries.push({
        providerId: row.providerId,
        providerLabel: providerDisplayName(row.providerId),
        modelId: row.modelId,
        kind,
      });
    }
    entries.sort(
      (left, right) =>
        left.providerId.localeCompare(right.providerId) ||
        left.modelId.localeCompare(right.modelId),
    );
    return { models: entries };
  }

  async generateImage(tenantId: string, input: GenerationImageInput): Promise<GenerationImageTask> {
    const target = await this.resolveTarget(tenantId, input.providerId, input.model, "image");
    const payload = await this.upstreamJson(
      tenantId,
      target,
      joinUpstream(target.baseUrl, "images/generations"),
      {
        model: input.model,
        prompt: input.prompt,
        n: input.n,
        ...(input.size ? { size: input.size } : {}),
        response_format: "url",
        // A synchronous call can outlive the server's idle timeout; the
        // upstream returns a pollable task instead.
        async: true,
      },
    );
    return this.normalizeImageTask(target, payload);
  }

  async generateVideo(tenantId: string, input: GenerationVideoInput): Promise<GenerationVideoTask> {
    const target = await this.resolveTarget(tenantId, input.providerId, input.model, "video");
    const payload = await this.upstreamJson(
      tenantId,
      target,
      joinUpstream(target.baseUrl, "videos"),
      {
        model: input.model,
        prompt: input.prompt,
        ...(input.size ? { size: input.size } : {}),
        ...(input.duration ? { duration: input.duration } : {}),
      },
    );
    return this.normalizeVideoTask(target, payload);
  }

  async getImageTask(
    tenantId: string,
    providerId: string,
    taskId: string,
  ): Promise<GenerationImageTask> {
    const target = await this.resolveProvider(tenantId, providerId);
    const payload = await this.upstreamJson(
      tenantId,
      target,
      joinUpstream(target.baseUrl, `images/generations/${encodeURIComponent(taskId)}`),
      undefined,
    );
    return this.normalizeImageTask(target, payload);
  }

  async getVideoTask(
    tenantId: string,
    providerId: string,
    taskId: string,
  ): Promise<GenerationVideoTask> {
    const target = await this.resolveProvider(tenantId, providerId);
    const payload = await this.upstreamJson(
      tenantId,
      target,
      joinUpstream(target.baseUrl, `videos/${encodeURIComponent(taskId)}`),
      undefined,
    );
    return this.normalizeVideoTask(target, payload);
  }

  async fetchMedia(tenantId: string, providerId: string, name: string): Promise<GenerationMedia> {
    const target = await this.resolveProvider(tenantId, providerId);
    const base = parseBaseUrl(target.baseUrl);
    const url = `${base.origin}/v1/media/${encodeURIComponent(name)}`;
    const binding = toBinding(await this.deps.outboundFetchFor(tenantId, providerId));
    let release = binding.release;
    const releaseOnce = (): void => {
      const current = release;
      release = undefined;
      current?.();
    };
    let response: Response;
    try {
      response = await binding.fetch(url, {
        method: "GET",
        headers: { accept: "*/*", "user-agent": GATEWAY_USER_AGENT },
        signal: AbortSignal.timeout(GENERATION_MEDIA_TIMEOUT_MS),
      });
    } catch (error) {
      releaseOnce();
      throw new ConsoleDomainError(
        "generation_upstream_unreachable",
        502,
        `Generation media is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        { providerId },
      );
    }
    if (!response.ok) {
      releaseOnce();
      throw new ConsoleDomainError(
        "generation_media_not_found",
        response.status === 404 ? 404 : 502,
        `Generation media returned HTTP ${response.status}`,
        { providerId, providerStatus: response.status },
      );
    }
    const body = response.body;
    if (body === null) {
      releaseOnce();
      return { response: new Response(null, { status: 200 }) };
    }
    const reader = body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            releaseOnce();
            controller.close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          releaseOnce();
          controller.error(error);
        }
      },
      cancel(reason) {
        releaseOnce();
        void reader.cancel(reason).catch(() => undefined);
      },
    });
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const contentLength = response.headers.get("content-length");
    return {
      response: new Response(stream, {
        status: 200,
        headers: {
          "content-type": contentType,
          ...(contentLength ? { "content-length": contentLength } : {}),
          "cache-control": "private, max-age=0, no-store",
        },
      }),
    };
  }

  private async resolveProvider(tenantId: string, providerId: string): Promise<ProviderTarget> {
    const rows = await this.db
      .select({
        id: providers.id,
        baseUrl: providers.baseUrl,
        enabled: providers.enabled,
        tenantId: providers.tenantId,
      })
      .from(providers)
      .where(
        and(
          eq(providers.id, providerId),
          or(isNull(providers.tenantId), eq(providers.tenantId, tenantId)),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || !row.enabled) {
      throw new ConsoleDomainError(
        "generation_provider_not_found",
        404,
        `Provider ${providerId} is not available for generation`,
      );
    }
    const baseUrl = configuredBaseUrl(row.id, row.baseUrl);
    if (baseUrl === undefined) {
      throw new ConsoleDomainError(
        "generation_provider_misconfigured",
        500,
        `Provider ${providerId} has no base URL`,
      );
    }
    return { providerId: row.id, baseUrl, tenantId: row.tenantId };
  }

  private async resolveTarget(
    tenantId: string,
    providerId: string,
    modelId: string,
    kind: GenerationKind,
  ): Promise<ProviderTarget> {
    const target = await this.resolveProvider(tenantId, providerId);
    const rows = await this.db
      .select({ modelId: models.modelId, modalities: models.modalities, enabled: models.enabled })
      .from(models)
      .where(and(eq(models.providerId, providerId), eq(models.modelId, modelId)))
      .limit(10);
    const row = rows.find((candidate) => candidate.modelId === modelId);
    if (!row || !row.enabled || !upstreamOutputs(row.modalities).includes(kind)) {
      throw new ConsoleDomainError(
        "generation_model_not_found",
        404,
        `Model ${providerId}/${modelId} does not generate ${kind}`,
      );
    }
    return target;
  }

  private async resolveAccountSecret(tenantId: string, providerId: string): Promise<string> {
    const rows = await this.db
      .select({
        id: providerAccounts.id,
        cooldownUntil: providerAccounts.cooldownUntil,
        lastErrorAt: providerAccounts.lastErrorAt,
        consecutiveFailures: providerAccounts.consecutiveFailures,
        lastSuccessAt: providerAccounts.lastSuccessAt,
      })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          eq(providerAccounts.status, "active"),
          or(isNull(providerAccounts.tenantId), eq(providerAccounts.tenantId, tenantId)),
        ),
      )
      .limit(50);
    const now = Date.now();
    const usable = rows
      .filter((row) => row.cooldownUntil === null || row.cooldownUntil.getTime() <= now)
      .sort((left, right) => {
        const leftErrorAt = left.lastErrorAt?.getTime() ?? 0;
        const rightErrorAt = right.lastErrorAt?.getTime() ?? 0;
        if (leftErrorAt !== rightErrorAt) return leftErrorAt - rightErrorAt;
        if (left.consecutiveFailures !== right.consecutiveFailures) {
          return left.consecutiveFailures - right.consecutiveFailures;
        }
        const leftSuccessAt = left.lastSuccessAt?.getTime() ?? 0;
        const rightSuccessAt = right.lastSuccessAt?.getTime() ?? 0;
        return rightSuccessAt - leftSuccessAt;
      })
      .slice(0, GENERATION_ACCOUNT_ATTEMPTS);
    if (usable.length === 0) {
      throw new ConsoleDomainError(
        "generation_account_unavailable",
        409,
        `No active account for ${providerId} can serve a generation right now`,
      );
    }
    let lastError: unknown;
    for (const account of usable) {
      try {
        const credential = this.deps.resolveCredential
          ? await this.deps.resolveCredential(providerId, account.id)
          : await resolveCredentialForAccount(this.db, providerId, account.id, this.deps.oauth);
        return readCredentialSecret(credential, `${providerId} credential is missing`);
      } catch (error) {
        lastError = error;
      }
    }
    throw new ConsoleDomainError(
      "generation_account_unavailable",
      409,
      `No usable ${providerId} credential: ${lastError instanceof Error ? lastError.message : "unknown error"}`,
    );
  }

  private async upstreamJson(
    tenantId: string,
    target: ProviderTarget,
    url: string,
    body: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    const secret = await this.resolveAccountSecret(tenantId, target.providerId);
    const binding = toBinding(await this.deps.outboundFetchFor(tenantId, target.providerId));
    let response: Response;
    try {
      response = await binding.fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "user-agent": GATEWAY_USER_AGENT,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(GENERATION_REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        throw this.upstreamError(target.providerId, response.status, text);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ConsoleDomainError(
          "generation_upstream_invalid",
          502,
          "Generation upstream returned a non-JSON body",
          { providerId: target.providerId },
        );
      }
      if (!isRecord(parsed)) {
        throw new ConsoleDomainError(
          "generation_upstream_invalid",
          502,
          "Generation upstream returned an unexpected JSON shape",
          { providerId: target.providerId },
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof ConsoleDomainError) throw error;
      const timedOut =
        error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ConsoleDomainError(
        timedOut ? "generation_upstream_timeout" : "generation_upstream_unreachable",
        timedOut ? 504 : 502,
        timedOut
          ? "Generation upstream did not answer in time"
          : `Generation upstream is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        { providerId: target.providerId },
      );
    } finally {
      binding.release?.();
    }
  }

  private upstreamError(providerId: string, status: number, text: string): ConsoleDomainError {
    let message = text.slice(0, 500);
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        const extracted =
          errorText(parsed["error"]) ??
          errorText(parsed["message"]) ??
          errorText(parsed);
        if (extracted !== undefined) message = extracted;
      }
    } catch {
      // Non-JSON error bodies keep their bounded text.
    }
    return new ConsoleDomainError(
      "generation_upstream_error",
      status >= 400 && status < 500 ? status : 502,
      `Generation upstream returned HTTP ${status}${message ? `: ${message}` : ""}`,
      { providerId, providerStatus: status },
    );
  }

  private imageItems(target: ProviderTarget, source: unknown): readonly GenerationImageItem[] {
    if (!isRecord(source)) return [];
    const data = source["data"];
    if (!Array.isArray(data)) return [];
    const origin = parseBaseUrl(target.baseUrl).origin;
    const items: GenerationImageItem[] = [];
    for (const entry of data) {
      if (!isRecord(entry)) continue;
      const rawUrl = entry["url"];
      const b64 = entry["b64_json"];
      const revised = entry["revised_prompt"];
      const url =
        typeof rawUrl === "string" ? consoleMediaUrl(target.providerId, origin, rawUrl) : undefined;
      const item: GenerationImageItem = {
        ...(url ? { url } : {}),
        ...(typeof b64 === "string" ? { b64Json: b64 } : {}),
        ...(typeof revised === "string" ? { revisedPrompt: revised } : {}),
      };
      if (item.url !== undefined || item.b64Json !== undefined) items.push(item);
    }
    return items;
  }

  private normalizeImageTask(
    target: ProviderTarget,
    payload: Record<string, unknown>,
  ): GenerationImageTask {
    const id = typeof payload["id"] === "string" ? payload["id"] : undefined;
    const createdAt =
      finiteNumber(payload["created_at"]) ??
        finiteNumber(payload["created"]) ??
        Math.floor(Date.now() / 1000);
    const model = typeof payload["model"] === "string" ? payload["model"] : undefined;
    const error = errorText(payload["error"]);
    if (id === undefined) {
      // A provider that ignored `async` answers with the finished payload.
      const images = this.imageItems(target, payload);
      return {
        id: "sync",
        status: images.length > 0 ? "succeeded" : "failed",
        progress: images.length > 0 ? 100 : 0,
        createdAt,
        ...(model ? { model } : {}),
        images,
        ...(images.length === 0 && error ? { error } : {}),
      };
    }
    const progress = finiteNumber(payload["progress"]);
    return {
      id,
      status: normalizeStatus(payload["status"]),
      progress: progress === undefined ? 0 : Math.max(0, Math.min(100, progress)),
      createdAt,
      ...(model ? { model } : {}),
      images: this.imageItems(target, payload["result"]),
      ...(error ? { error } : {}),
    };
  }

  private normalizeVideoTask(
    target: ProviderTarget,
    payload: Record<string, unknown>,
  ): GenerationVideoTask {
    const id = typeof payload["id"] === "string" ? payload["id"] : undefined;
    const createdAt = finiteNumber(payload["created_at"]) ?? Math.floor(Date.now() / 1000);
    const model = typeof payload["model"] === "string" ? payload["model"] : undefined;
    const error = errorText(payload["error"]);
    const result = payload["result"];
    const origin = parseBaseUrl(target.baseUrl).origin;
    let video: GenerationVideoAsset | undefined;
    if (isRecord(result) && typeof result["url"] === "string") {
      const width = finiteNumber(result["width"]);
      const height = finiteNumber(result["height"]);
      video = {
        url: consoleMediaUrl(target.providerId, origin, result["url"]),
        ...(typeof result["mime"] === "string" ? { mime: result["mime"] } : {}),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      };
    }
    const progress = finiteNumber(payload["progress"]);
    if (id === undefined) {
      return {
        id: "sync",
        status: video === undefined ? "failed" : "succeeded",
        progress: video === undefined ? 0 : 100,
        createdAt,
        ...(model ? { model } : {}),
        ...(video ? { video } : {}),
        ...(video === undefined && error ? { error } : {}),
      };
    }
    return {
      id,
      status: normalizeStatus(payload["status"]),
      progress: progress === undefined ? 0 : Math.max(0, Math.min(100, progress)),
      createdAt,
      ...(model ? { model } : {}),
      ...(video ? { video } : {}),
      ...(error ? { error } : {}),
    };
  }
}
