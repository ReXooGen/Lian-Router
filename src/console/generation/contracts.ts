// Generation console contract: image and video output over an
// OpenAI-style provider surface. The console is the only caller; requests are
// tenant-scoped and dispatched through the same account credentials and
// network-pool egress as provider probes.
import { isRecord } from "../../protocol/primitives";
import { ConsoleDomainError } from "../shared/errors";
import type { AuditSink } from "../domains/audit/contracts";
import type { ConsoleAccessResolver } from "../auth/access";

export type GenerationKind = "image" | "video";

/** Normalized task state; `unknown` keeps an upstream's new status visible. */
export type GenerationTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface GenerationModel {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly modelId: string;
  readonly kind: GenerationKind;
}

export interface GenerationCatalog {
  readonly models: readonly GenerationModel[];
}

export interface GenerationImageInput {
  readonly providerId: string;
  readonly model: string;
  readonly prompt: string;
  readonly n: number;
  readonly size?: string;
}

export interface GenerationVideoInput {
  readonly providerId: string;
  readonly model: string;
  readonly prompt: string;
  readonly size?: string;
  readonly duration?: number;
}

export interface GenerationImageItem {
  /** Console-relative media URL for provider-hosted files, absolute otherwise. */
  readonly url?: string;
  readonly b64Json?: string;
  readonly revisedPrompt?: string;
}

export interface GenerationImageTask {
  readonly id: string;
  readonly status: GenerationTaskStatus;
  readonly progress: number;
  readonly createdAt: number;
  readonly model?: string;
  readonly images: readonly GenerationImageItem[];
  readonly error?: string;
}

export interface GenerationVideoAsset {
  readonly url: string;
  readonly mime?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface GenerationVideoTask {
  readonly id: string;
  readonly status: GenerationTaskStatus;
  readonly progress: number;
  readonly createdAt: number;
  readonly model?: string;
  readonly video?: GenerationVideoAsset;
  readonly error?: string;
}

/** One proxied media response; the caller streams `response` and releases on end. */
export interface GenerationMedia {
  readonly response: Response;
}

export interface GenerationStore {
  catalog(tenantId: string): Promise<GenerationCatalog>;
  generateImage(tenantId: string, input: GenerationImageInput): Promise<GenerationImageTask>;
  generateVideo(tenantId: string, input: GenerationVideoInput): Promise<GenerationVideoTask>;
  getImageTask(tenantId: string, providerId: string, taskId: string): Promise<GenerationImageTask>;
  getVideoTask(tenantId: string, providerId: string, taskId: string): Promise<GenerationVideoTask>;
  fetchMedia(tenantId: string, providerId: string, name: string): Promise<GenerationMedia>;
}

export interface GenerationRoutesConfig {
  readonly store: GenerationStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink: AuditSink;
}

const PROMPT_LIMIT = 32_000;
const IDENTIFIER_LIMIT = 200;
const SIZE_PATTERN = /^\d{2,5}x\d{2,5}$/;

function boundedIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ConsoleDomainError("invalid_request", 400, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > IDENTIFIER_LIMIT) {
    throw new ConsoleDomainError(
      "invalid_request",
      400,
      `${field} must be 1–${IDENTIFIER_LIMIT} characters`,
    );
  }
  return trimmed;
}

function boundedPrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new ConsoleDomainError("invalid_request", 400, "prompt must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > PROMPT_LIMIT) {
    throw new ConsoleDomainError(
      "invalid_request",
      400,
      `prompt must be 1–${PROMPT_LIMIT} characters`,
    );
  }
  return trimmed;
}

function optionalSize(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !SIZE_PATTERN.test(value.trim())) {
    throw new ConsoleDomainError("invalid_request", 400, "size must look like 1024x1024");
  }
  return value.trim();
}

/** Validates the console image-generation body. */
export function parseGenerationImageInput(raw: unknown): GenerationImageInput {
  const input = isRecord(raw) ? raw : {};
  const providerId = boundedIdentifier(input["providerId"], "providerId");
  const model = boundedIdentifier(input["model"], "model");
  const prompt = boundedPrompt(input["prompt"]);
  const nRaw = input["n"];
  const n = nRaw === undefined || nRaw === null ? 1 : Number(nRaw);
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw new ConsoleDomainError("invalid_request", 400, "n must be an integer between 1 and 4");
  }
  const size = optionalSize(input["size"]);
  return { providerId, model, prompt, n, ...(size ? { size } : {}) };
}

/** Validates the console video-generation body. */
export function parseGenerationVideoInput(raw: unknown): GenerationVideoInput {
  const input = isRecord(raw) ? raw : {};
  const providerId = boundedIdentifier(input["providerId"], "providerId");
  const model = boundedIdentifier(input["model"], "model");
  const prompt = boundedPrompt(input["prompt"]);
  const size = optionalSize(input["size"]);
  const durationRaw = input["duration"];
  let duration: number | undefined;
  if (durationRaw !== undefined && durationRaw !== null && durationRaw !== "") {
    duration = Number(durationRaw);
    if (!Number.isInteger(duration) || duration < 1 || duration > 60) {
      throw new ConsoleDomainError("invalid_request", 400, "duration must be an integer between 1 and 60");
    }
  }
  return { providerId, model, prompt, ...(size ? { size } : {}), ...(duration ? { duration } : {}) };
}

/** Query parameter for the task/media routes. */
export function requireProviderQuery(value: unknown): string {
  return boundedIdentifier(value, "providerId");
}

/** Task ids are upstream-generated; keep them bounded and path-safe. */
export function requireTaskId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new ConsoleDomainError("invalid_request", 400, "invalid task id");
  }
  return value;
}

/** Media names are served from the provider's own /v1/media namespace. */
export function requireMediaName(value: unknown): string {
  if (typeof value !== "string" || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/.test(value)) {
    throw new ConsoleDomainError("invalid_request", 400, "invalid media name");
  }
  return value;
}
