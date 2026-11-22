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

export interface InjectionTemplate {
  readonly id: string;
  readonly name: string;
  readonly mode: "prompt" | "script";
  readonly position: "prepend" | "append";
  readonly content: string;
  readonly turns: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly createdAt: string;
}

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
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(asTemplate)
      .filter((t): t is InjectionTemplate => t !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    return [];
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
  const next = [template, ...templates.filter((t) => t.id !== template.id)].slice(0, MAX_TEMPLATES);
  persist(next);
  return template;
}

export function deleteInjectionTemplate(id: string): void {
  persist(listInjectionTemplates().filter((t) => t.id !== id));
}
