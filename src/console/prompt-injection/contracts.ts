// Prompt Injection control-plane contracts.
//
// One entry per target: global, per API key, per model. The shape mirrors the
// dispatch resolver (`selectPromptInjections`) so the page's preview and the
// request-time stack cannot disagree.

import type { ConsoleAccessResolver } from "../auth/access";
import { ConsoleDomainError } from "../shared/errors";
import type { AuditSink } from "../domains/audit/contracts";
import type {
  PromptInjection,
  PromptInjectionMode,
  PromptInjectionPosition,
  PromptInjectionPreset,
  PromptInjectionScope,
  PromptInjectionTurn,
} from "../../persistence/schema";
import type { PromptInjectionInput } from "../../persistence/prompt-injection-store";
import { selectPromptInjections } from "../../persistence/prompt-injection-store";

/** The editor payload the routes accept; owned by the persistence boundary. */
export type { PromptInjectionInput };

export const PROMPT_INJECTION_MODES = ["prompt", "script"] as const;
export const PROMPT_INJECTION_PRESETS = ["custom", "assistant", "uncensored"] as const;
export const PROMPT_INJECTION_POSITIONS = ["prepend", "append"] as const;

/** A prompt large enough to be a persona, small enough to stay out of a DoS. */
const MAX_CONTENT_CHARS = 200_000;
const MAX_TURN_CHARS = 100_000;
const MAX_TURNS = 50;
const MAX_TARGET_CHARS = 512;

export interface PromptInjectionEntryResponse {
  readonly name: string;
  /** True for the one entry applied per target. */
  readonly active: boolean;
  readonly mode: PromptInjectionMode;
  readonly preset: PromptInjectionPreset;
  readonly content: string;
  readonly turns: readonly PromptInjectionTurn[];
  readonly position: PromptInjectionPosition;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export interface PromptInjectionCatalogEntry extends PromptInjectionEntryResponse {
  readonly scope: PromptInjectionScope;
  readonly target: string;
}

export interface PromptInjectionCatalogResponse {
  /** Every saved entry with its target, newest first. */
  readonly entries: readonly PromptInjectionCatalogEntry[];
  /** The entry the editor loads by default per scope (the active one). */
  readonly global: PromptInjectionEntryResponse | null;
  readonly userPrompts: Readonly<Record<string, PromptInjectionEntryResponse>>;
  readonly prompts: Readonly<Record<string, PromptInjectionEntryResponse>>;
}

export interface PromptInjectionPreviewEntry {
  readonly scope: PromptInjectionScope;
  readonly target: string;
  readonly mode: PromptInjectionMode;
  readonly preset: PromptInjectionPreset;
  readonly position: PromptInjectionPosition;
  readonly text?: string;
  readonly turns?: readonly PromptInjectionTurn[];
}

/** Persistence boundary the routes need; `DrizzlePromptInjectionStore` implements it. */
export interface PromptInjectionStorePort {
  list(tenantId: string): Promise<readonly PromptInjection[]>;
  upsert(
    tenantId: string,
    scope: PromptInjectionScope,
    target: string,
    input: PromptInjectionInput,
  ): Promise<PromptInjection>;
  remove(
    tenantId: string,
    scope: PromptInjectionScope,
    target: string,
    name: string,
  ): Promise<boolean>;
  activate(
    tenantId: string,
    scope: PromptInjectionScope,
    target: string,
    name: string,
  ): Promise<boolean>;
}

export interface PromptInjectionRoutesConfig {
  readonly store: PromptInjectionStorePort;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
}

const MAX_NAME_CHARS = 120;

function invalid(message: string): never {
  throw new ConsoleDomainError("invalid_request", 400, message);
}

/**
 * Normalizes one editor payload.
 *
 * `null` means "remove this target": an empty prompt or a script with no
 * non-empty turns has nothing to inject, and keeping an empty row would make
 * the catalog disagree with the page about whether a target is configured.
 */
export function normalizePromptInjectionInput(raw: unknown): PromptInjectionInput | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    invalid("injection must be an object");
  }
  const record = raw as Record<string, unknown>;

  const rawName = record["name"];
  if (rawName !== undefined && typeof rawName !== "string") invalid("name must be a string");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length > MAX_NAME_CHARS) invalid(`name exceeds ${MAX_NAME_CHARS} characters`);

  const mode = record["mode"] ?? "prompt";
  if (mode !== "prompt" && mode !== "script") {
    invalid("mode must be prompt or script");
  }
  const preset = record["preset"] ?? "custom";
  if (!PROMPT_INJECTION_PRESETS.includes(preset as PromptInjectionPreset)) {
    invalid("preset must be custom, assistant, or uncensored");
  }
  const position = record["position"] ?? "append";
  if (!PROMPT_INJECTION_POSITIONS.includes(position as PromptInjectionPosition)) {
    invalid("position must be prepend or append");
  }
  const enabled = record["enabled"] ?? true;
  if (typeof enabled !== "boolean") invalid("enabled must be a boolean");
  // A save makes its entry the applied one unless the caller explicitly
  // creates an inactive draft.
  const active = record["active"] ?? true;
  if (typeof active !== "boolean") invalid("active must be a boolean");

  if (mode === "prompt") {
    const content = record["content"];
    if (content !== undefined && typeof content !== "string") invalid("content must be a string");
    const text = typeof content === "string" ? content : "";
    if (text.length > MAX_CONTENT_CHARS) invalid(`content exceeds ${MAX_CONTENT_CHARS} characters`);
    if (text.trim().length === 0) return null;
    return {
      name,
      active,
      mode,
      preset: preset as PromptInjectionPreset,
      content: text,
      turns: [],
      position: position as PromptInjectionPosition,
      enabled,
    };
  }

  const rawTurns = record["turns"];
  if (rawTurns !== undefined && !Array.isArray(rawTurns)) invalid("turns must be an array");
  const turns: PromptInjectionTurn[] = [];
  for (const rawTurn of Array.isArray(rawTurns) ? rawTurns : []) {
    if (rawTurn === null || typeof rawTurn !== "object" || Array.isArray(rawTurn)) {
      invalid("each turn must be an object");
    }
    const turn = rawTurn as Record<string, unknown>;
    const role = turn["role"];
    if (role !== "user" && role !== "assistant") invalid("turn role must be user or assistant");
    const content = turn["content"];
    if (typeof content !== "string") invalid("turn content must be a string");
    if (content.length > MAX_TURN_CHARS) invalid(`turn content exceeds ${MAX_TURN_CHARS} characters`);
    if (content.trim().length === 0) continue;
    turns.push({ role, content });
    if (turns.length >= MAX_TURNS) break;
  }
  if (turns.length === 0) return null;
  return {
    name,
    active,
    mode,
    preset: preset as PromptInjectionPreset,
    content: "",
    turns,
    position: position as PromptInjectionPosition,
    enabled,
  };
}

export function normalizeInjectionTarget(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) invalid("target is required");
  const target = raw.trim();
  if (target.length > MAX_TARGET_CHARS) invalid(`target exceeds ${MAX_TARGET_CHARS} characters`);
  return target;
}

export function toPromptInjectionEntry(row: PromptInjection): PromptInjectionEntryResponse {
  return {
    name: row.name,
    active: row.active,
    mode: row.mode,
    preset: row.preset,
    content: row.content,
    turns: row.turns,
    position: row.position,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPromptInjectionCatalog(
  rows: readonly PromptInjection[],
): PromptInjectionCatalogResponse {
  const entries: PromptInjectionCatalogEntry[] = rows
    .map((row) => ({ ...toPromptInjectionEntry(row), scope: row.scope, target: row.target }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let global: PromptInjectionEntryResponse | null = null;
  const userPrompts: Record<string, PromptInjectionEntryResponse> = {};
  const prompts: Record<string, PromptInjectionEntryResponse> = {};
  // The convenience maps keep the active entry per target, so an editor that
  // loads by target opens the persona that actually applies.
  for (const row of rows) {
    const entry = toPromptInjectionEntry(row);
    if (row.scope === "global") {
      if (global === null || row.active) global = entry;
    } else if (row.scope === "key") {
      if (userPrompts[row.target] === undefined || row.active) userPrompts[row.target] = entry;
    } else if (prompts[row.target] === undefined || row.active) prompts[row.target] = entry;
  }
  return { entries, global, userPrompts, prompts };
}

/** The exact stack one request would receive, for the page's preview pane. */
export function toPromptInjectionPreview(
  rows: readonly PromptInjection[],
  context: { readonly apiKeyId?: string | undefined; readonly model?: string | undefined },
): readonly PromptInjectionPreviewEntry[] {
  const modelNames = [
    context.model,
    context.model?.includes("/")
      ? context.model.slice(context.model.lastIndexOf("/") + 1)
      : undefined,
  ].filter((name): name is string => typeof name === "string" && name.length > 0);
  return selectPromptInjections(rows, {
    ...(context.apiKeyId === undefined ? {} : { apiKeyId: context.apiKeyId }),
    modelNames: [...new Set(modelNames)],
  }).map((entry) => ({
    scope: entry.scope,
    target: entry.target,
    mode: entry.mode,
    preset: entry.preset,
    position: entry.position,
    ...(entry.mode === "script" ? { turns: entry.turns } : { text: entry.content }),
  }));
}
