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
}

export interface PromptInjectionResolutionContext {
  /** The API key that authenticated the request, for the `key` scope. */
  readonly apiKeyId?: string | undefined;
  /**
   * Names the client may call this model by, most specific first: the
   * requested name, `provider/model`, and the bare model id. The first enabled
   * `model` entry among them wins.
   */
  readonly modelNames: readonly string[];
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
export function selectPromptInjections(
  entries: readonly PromptInjection[],
  context: PromptInjectionResolutionContext,
): readonly PromptInjection[] {
  const selected: PromptInjection[] = [];

  const global = entries.find(
    (entry) => entry.scope === "global" && entry.enabled && entry.active,
  );
  if (global !== undefined) selected.push(global);

  if (context.apiKeyId !== undefined) {
    const keyed = entries.find(
      (entry) =>
        entry.scope === "key" && entry.enabled && entry.active && entry.target === context.apiKeyId,
    );
    if (keyed !== undefined) selected.push(keyed);
  }

  for (const name of context.modelNames) {
    const model = entries.find(
      (entry) => entry.scope === "model" && entry.enabled && entry.active && entry.target === name,
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
