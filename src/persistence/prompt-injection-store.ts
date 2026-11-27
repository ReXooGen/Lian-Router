import { and, eq, ne } from "drizzle-orm";
import type { LianRouterDatabase } from "./postgres";
import {
  promptInjections,
  type PromptInjection,
  type PromptInjectionMode,
  type PromptInjectionPosition,
  type PromptInjectionPreset,
  type PromptInjectionScope,
  type PromptInjectionTurn,
} from "./schema";

/**
 * Prompt Injection persistence and request resolution.
 *
 * The dispatch hot path reads through `resolve()`, which serves a three-second
 * per-tenant snapshot: a chat request must not pay a full table scan, and an
 * injection edit may lag one request by at most the TTL. Console writes go
 * through this same module, so they invalidate immediately instead of waiting
 * for the TTL — the latency only exists for a second process, which this
 * deployment does not run.
 *
 * Every read is fail-open: an injection is a preference, and a storage fault
 * must never turn a working chat request into a 500.
 */

export interface PromptInjectionInput {
  /** Operator-facing label shown in the saved-injections list. */
  readonly name: string;
  /** Whether this entry is the one applied for its target. */
  readonly active: boolean;
  readonly mode: PromptInjectionMode;
  readonly preset: PromptInjectionPreset;
  readonly content: string;
  readonly turns: readonly PromptInjectionTurn[];
  readonly position: PromptInjectionPosition;
  readonly enabled: boolean;
  /** Client IPs this injection never applies to (normalized, compared as sets). */
  readonly excludedClientIps?: readonly string[];
  /** API key ids this injection never applies to; a template id skips its children. */
  readonly excludedApiKeyIds?: readonly string[];
  /** Provider ids this injection never applies to (bare id, e.g. `autoclaw`). */
  readonly excludedProviders?: readonly string[];
  /** Model names this injection never applies to, in any spelling the request may carry. */
  readonly excludedModels?: readonly string[];
}

export interface PromptInjectionResolutionContext {
  /** The API key that authenticated the request, for the `key` scope. */
  readonly apiKeyId?: string | undefined;
  /** Template key that issued the caller's child, when the caller enrolled through a share link. */
  readonly parentApiKeyId?: string | undefined;
  /** The caller's address, compared against `excludedClientIps` in normalized form. */
  readonly clientIp?: string | undefined;
  /**
   * Names the client may call this model by, most specific first: the
   * requested name, `provider/model`, and the bare model id. The first enabled
   * `model` entry among them wins.
   */
  readonly modelNames: readonly string[];
  /**
   * Provider ids the request could be served by: every eligible route
   * candidate, most likely first. A provider on this list is skipped by an
   * entry that excludes it — the exclusion has to hold for the request, not
   * only for the candidate that happened to be picked, because failover moves
   * between candidates after the stack is already applied.
   */
  readonly providerIds?: readonly string[];
}

const CACHE_TTL_MS = 3_000;
const cache = new Map<string, { readonly at: number; readonly entries: readonly PromptInjection[] }>();

/** Drops the cached snapshot for one tenant, or for every tenant when omitted. */
export function invalidatePromptInjectionCache(tenantId?: string): void {
  if (tenantId === undefined) cache.clear();
  else cache.delete(tenantId);
}

/**
 * Selects the injections one request receives, ordered global → key → model.
 *
 * At most three entries, and the model scope contributes at most one: a
 * request that happens to match by both alias and provider/model must not
 * receive the same persona twice.
 */
/** Mirrors the dashboard's exclusion-address canonical form. */
export function normalizeExcludedClientIp(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

export function selectPromptInjections(
  entries: readonly PromptInjection[],
  context: PromptInjectionResolutionContext,
): readonly PromptInjection[] {
  const selected: PromptInjection[] = [];
  const excluded = (entry: PromptInjection): boolean => {
    if (
      context.apiKeyId !== undefined &&
      entry.excludedApiKeyIds.includes(context.apiKeyId)
    ) {
      return true;
    }
    if (
      context.parentApiKeyId !== undefined &&
      entry.excludedApiKeyIds.includes(context.parentApiKeyId)
    ) {
      return true;
    }
    // Provider and model exclusions are checked against every name the request
    // could be billed under, not just the first. A `provider/model` exclusion
    // has to catch a request that asked for the bare model id too, and a
    // provider exclusion has to hold across failover candidates — otherwise
    // the persona would apply or vanish depending on routing, which is exactly
    // the inconsistency this list exists to prevent.
    if (
      entry.excludedProviders.length > 0 &&
      (context.providerIds ?? []).some((id) => entry.excludedProviders.includes(id))
    ) {
      return true;
    }
    if (entry.excludedModels.length > 0) {
      const bare = (name: string): string =>
        name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
      // A bare model id in the exclusion means "this model, whichever provider
      // serves it", so it is compared against the bare form of every name the
      // request carries. A qualified `provider/model` entry is a deliberate pin
      // and only matches that exact spelling — otherwise excluding
      // `zcode/glm-5.3` would silently also skip `zai/glm-5.3`.
      const hit = entry.excludedModels.some((excluded) =>
        excluded.includes("/")
          ? context.modelNames.includes(excluded)
          : context.modelNames.some((name) => bare(name) === excluded),
      );
      if (hit) return true;
    }
    if (context.clientIp === undefined || context.clientIp.trim().length === 0) return false;
    return entry.excludedClientIps.includes(normalizeExcludedClientIp(context.clientIp));
  };

  const global = entries.find(
    (entry) => entry.scope === "global" && entry.enabled && entry.active && !excluded(entry),
  );
  if (global !== undefined) selected.push(global);

  if (context.apiKeyId !== undefined) {
    const keyed = entries.find(
      (entry) =>
        entry.scope === "key" &&
        entry.enabled &&
        entry.active &&
        entry.target === context.apiKeyId &&
        !excluded(entry),
    );
    if (keyed !== undefined) selected.push(keyed);
  }

  for (const name of context.modelNames) {
    const model = entries.find(
      (entry) =>
        entry.scope === "model" &&
        entry.enabled &&
        entry.active &&
        entry.target === name &&
        !excluded(entry),
    );
    if (model !== undefined) {
      selected.push(model);
      break;
    }
  }

  return selected;
}

export class DrizzlePromptInjectionStore {
  constructor(private readonly db: LianRouterDatabase) {}

  async list(tenantId: string): Promise<readonly PromptInjection[]> {
    const cached = cache.get(tenantId);
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries;
    const entries = await this.db
      .select()
      .from(promptInjections)
      .where(eq(promptInjections.tenantId, tenantId));
    cache.set(tenantId, { at: Date.now(), entries });
    return entries;
  }

  async upsert(
    tenantId: string,
    scope: PromptInjectionScope,
    target: string,
    input: PromptInjectionInput,
  ): Promise<PromptInjection> {
    const now = new Date();
    // Saving the selected persona deactivates its siblings first: the partial
    // unique index allows only one active entry per target, and a sibling left
    // active would reject the write.
    if (input.active) {
      await this.db
        .update(promptInjections)
        .set({ active: false, updatedAt: now })
        .where(
          and(
            eq(promptInjections.tenantId, tenantId),
            eq(promptInjections.scope, scope),
            eq(promptInjections.target, target),
            ne(promptInjections.name, input.name),
          ),
        );
    }
    const rows = await this.db
      .insert(promptInjections)
      .values({
        tenantId,
        scope,
        target,
        name: input.name,
        active: input.active,
        mode: input.mode,
        preset: input.preset,
        content: input.content,
        turns: input.turns,
        position: input.position,
        enabled: input.enabled,
        excludedClientIps: input.excludedClientIps ?? [],
        excludedApiKeyIds: input.excludedApiKeyIds ?? [],
        excludedProviders: input.excludedProviders ?? [],
        excludedModels: input.excludedModels ?? [],
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          promptInjections.tenantId,
          promptInjections.scope,
          promptInjections.target,
          promptInjections.name,
        ],
        set: {
          active: input.active,
          mode: input.mode,
          preset: input.preset,
          content: input.content,
          turns: input.turns,
          position: input.position,
          enabled: input.enabled,
          excludedClientIps: input.excludedClientIps ?? [],
          excludedApiKeyIds: input.excludedApiKeyIds ?? [],
          excludedProviders: input.excludedProviders ?? [],
          excludedModels: input.excludedModels ?? [],
          updatedAt: now,
        },
      })
      .returning();
    invalidatePromptInjectionCache(tenantId);
    const saved = rows[0];
    if (saved === undefined) {
      throw new Error("prompt injection upsert returned no row");
    }
    return saved;
  }

  async remove(
    tenantId: string,
    scope: PromptInjectionScope,
    target: string,
    name: string,
  ): Promise<boolean> {
    const rows = await this.db
      .delete(promptInjections)
      .where(
        and(
          eq(promptInjections.tenantId, tenantId),
          eq(promptInjections.scope, scope),
          eq(promptInjections.target, target),
          eq(promptInjections.name, name),
        ),
      )
      .returning({ id: promptInjections.id });
    invalidatePromptInjectionCache(tenantId);
    return rows.length > 0;
  }

  /** Makes one saved entry the applied persona for its target. */
  async activate(
    tenantId: string,
    scope: PromptInjectionScope,
    target: string,
    name: string,
  ): Promise<boolean> {
    const now = new Date();
    await this.db
      .update(promptInjections)
      .set({ active: false, updatedAt: now })
      .where(
        and(
          eq(promptInjections.tenantId, tenantId),
          eq(promptInjections.scope, scope),
          eq(promptInjections.target, target),
        ),
      );
    const rows = await this.db
      .update(promptInjections)
      .set({ active: true, updatedAt: now })
      .where(
        and(
          eq(promptInjections.tenantId, tenantId),
          eq(promptInjections.scope, scope),
          eq(promptInjections.target, target),
          eq(promptInjections.name, name),
        ),
      )
      .returning({ id: promptInjections.id });
    invalidatePromptInjectionCache(tenantId);
    return rows.length > 0;
  }

  /** Reads the snapshot and selects this request's stack; never throws. */
  async resolve(
    tenantId: string,
    context: PromptInjectionResolutionContext,
  ): Promise<readonly PromptInjection[]> {
    try {
      return selectPromptInjections(await this.list(tenantId), context);
    } catch {
      return [];
    }
  }
}
