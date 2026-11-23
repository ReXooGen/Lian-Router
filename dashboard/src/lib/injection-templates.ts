/**
 * Operator-owned injection templates, stored in this browser's localStorage.
 *
 * A template is a named snapshot of one injection draft: mode, position, text,
 * and any scripted turns. The server stays out of it on purpose — templates are
 * personal starting points, not entries, and a saved entry already covers the
 * "use this exact thing everywhere" case. Storage lives with the browser, so
 * nothing sensitive is pushed to the gateway, and an operator who shares the
 * dashboard URL does not share their template set.
 *
 * Shape matches `PromptInjectionInput` minus the identity/exclusion fields a
 * template has no opinion about: loading one fills the editor's substance
 * (mode/position/content/turns) and leaves scoping exactly where the operator
 * set it.
 */

import { LIAN_PERSONA_CONTENT } from "./personas/lian-persona";

export interface InjectionTemplate {
  readonly id: string;
  readonly name: string;
  readonly mode: "prompt" | "script";
  readonly position: "prepend" | "append";
  readonly content: string;
  readonly turns: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly createdAt: string;
}

/**
 * The template every install ships with, before the operator saves anything.
 *
 * Shipped verbatim from the operator's validated "Lian" persona so a fresh
 * install shows a working, loadable template in "My templates" instead of an
 * empty list. A user who deletes it stays deleted: the seeded entry is added
 * only when no template with this id exists yet.
 */
const BUILT_IN_TEMPLATES: readonly InjectionTemplate[] = [
  {
    id: "built-in-lian-persona",
    name: "Lian (built-in persona)",
    mode: "prompt",
    position: "prepend",
    content: LIAN_PERSONA_CONTENT,
    turns: [],
    createdAt: "2026-11-23T00:00:00.000Z",
  },
];

const STORAGE_KEY = "lianrouter.injection-templates.v1";
const MAX_TEMPLATES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asTemplate(value: unknown): InjectionTemplate | null {
  if (!isRecord(value)) return null;
  const id = typeof value["id"] === "string" ? value["id"] : null;
  const name = typeof value["name"] === "string" ? value["name"] : null;
  const mode = value["mode"] === "prompt" || value["mode"] === "script" ? value["mode"] : null;
  const position =
    value["position"] === "prepend" || value["position"] === "append" ? value["position"] : null;
  const content = typeof value["content"] === "string" ? value["content"] : null;
  if (id === null || name === null || mode === null || position === null || content === null) {
    return null;
  }
  const rawTurns = Array.isArray(value["turns"]) ? value["turns"] : [];
  const turns = rawTurns.flatMap((turn) => {
    if (!isRecord(turn)) return [];
    const role = turn["role"] === "user" || turn["role"] === "assistant" ? turn["role"] : null;
    const turnContent = typeof turn["content"] === "string" ? turn["content"] : null;
    if (role === null || turnContent === null) return [];
    return [{ role: role as "user" | "assistant", content: turnContent }];
  });
  const createdAt = typeof value["createdAt"] === "string" ? value["createdAt"] : "";
  return { id, name, mode, position, content, turns, createdAt };
}

export function listInjectionTemplates(): readonly InjectionTemplate[] {
  const builtIn = BUILT_IN_TEMPLATES.filter(
    (builtIn) => !deletedBuiltInIds().has(builtIn.id),
  );
  const builtInIds = new Set(builtIn.map((t) => t.id));
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return builtIn;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return builtIn;
    return [
      ...builtIn,
      ...parsed
        .map(asTemplate)
        .filter((t): t is InjectionTemplate => t !== null && !builtInIds.has(t.id)),
    ]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    return builtIn;
  }
}

/** Built-in template ids the operator has explicitly deleted, persisted per browser. */
const DELETED_BUILT_IN_KEY = "lianrouter.injection-templates.deleted-built-in.v1";

function deletedBuiltInIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DELETED_BUILT_IN_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function persist(templates: readonly InjectionTemplate[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

/** Saves the current draft as a template; returns the stored template. */
export function saveInjectionTemplate(
  draft: {
    readonly name: string;
    readonly mode: "prompt" | "script";
    readonly position: "prepend" | "append";
    readonly content: string;
    readonly turns: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  },
): InjectionTemplate {
  const templates = listInjectionTemplates();
  // Same name replaces: a template is a reusable shape, and two templates
  // differing only in the timestamp are indistinguishable in the picker.
  const existing = templates.find((t) => t.name === draft.name.trim());
  const template: InjectionTemplate = {
    id: existing?.id ?? crypto.randomUUID(),
    name: draft.name.trim() || `Template ${new Date().toISOString().slice(0, 10)}`,
    mode: draft.mode,
    position: draft.position,
    content: draft.content,
    turns: draft.turns,
    createdAt: new Date().toISOString(),
  };
  // A save whose name matches the built-in entry replaces it in storage with
  // the operator's own copy, so the edited text wins from then on. The
  // built-in constant is suppressed for this browser; the stored copy (same
  // id) is what the list shows.
  if (template.id === "built-in-lian-persona") {
    const deleted = deletedBuiltInIds();
    deleted.add(template.id);
    window.localStorage.setItem(DELETED_BUILT_IN_KEY, JSON.stringify([...deleted]));
  }
  const next = [
    template,
    ...templates.filter((t) => t.id !== template.id && t.id !== "built-in-lian-persona"),
  ].slice(0, MAX_TEMPLATES);
  persist(next);
  return template;
}

export function deleteInjectionTemplate(id: string): void {
  if (BUILT_IN_TEMPLATES.some((t) => t.id === id)) {
    const deleted = deletedBuiltInIds();
    deleted.add(id);
    window.localStorage.setItem(DELETED_BUILT_IN_KEY, JSON.stringify([...deleted]));
    return;
  }
  persist(listInjectionTemplates().filter((t) => t.id !== id));
}
