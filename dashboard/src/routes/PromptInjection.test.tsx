import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  PromptInjectionCatalog,
  PromptInjectionCatalogEntry,
  PromptInjectionInput,
  PromptInjectionPreviewEntry,
} from "../lib/contracts";
import {
  ALL_PREVIEW_SCOPES,
  SaveInjectionFields,
  TEST_NEEDS_KEY_NOTICE,
  TEST_UNSAVED_NOTICE,
  activeEntryForTarget,
  buildCustomSaveRequest,
  draftDiffersFromEntry,
  groupByTarget,
  loadedEntryNotice,
  previewKeyOptions,
  previewOptionsFor,
  previewScopeFilterNotice,
  previewScopeShownSummary,
  previewSelectionLabel,
  saveDialogDescription,
  savedOptionsForScope,
  savedPickerCopy,
  shareChildOptionLabel,
  shouldReseedDraft,
  stackScopeCounts,
  stackScopeSummary,
  targetGroupActiveLabel,
  targetLabel,
  visibleStack,
} from "./PromptInjection";

const draft: PromptInjectionInput = {
  name: "Old name",
  active: false,
  mode: "prompt",
  preset: "custom",
  content: "You are…",
  turns: [],
  position: "append",
  enabled: true,
};

const noop = (): void => undefined;

function renderFields(scope: "global" | "key" | "model", model = "chosen/model"): string {
  return renderToStaticMarkup(
    createElement(SaveInjectionFields, {
      scope,
      name: "Persona",
      onNameChange: noop,
      model,
      onModelChange: noop,
      modelOptions: [],
      modelLoading: false,
    }),
  );
}

describe("save dialog model visibility", () => {
  test("global shows the name only", () => {
    const markup = renderFields("global");
    expect(markup).toContain(">Name</span>");
    expect(markup.includes('aria-label="Model"')).toBe(false);
    expect(markup).not.toContain("Saved as a per-model entry");
  });

  test("per API key shows the name only", () => {
    const markup = renderFields("key");
    expect(markup).toContain(">Name</span>");
    expect(markup.includes('aria-label="Model"')).toBe(false);
  });

  test("per model shows the model control", () => {
    const markup = renderFields("model");
    expect(markup.includes('aria-label="Model"')).toBe(true);
    expect(markup).toContain("Saved as a per-model entry");
  });

  test("descriptions never promise a model to global or key", () => {
    expect(saveDialogDescription("global")).toBe(
      "Name the injection; it applies to every model.",
    );
    expect(saveDialogDescription("key")).toBe(
      "Name the injection; it applies to the selected API key.",
    );
    expect(saveDialogDescription("model")).toBe(
      "Name the injection and choose the model it applies to.",
    );
  });
});

describe("custom save payload", () => {
  test("global sends the global branch and ignores a model chosen in the dialog", () => {
    const payload = buildCustomSaveRequest("global", "key-1", "leaked/model", draft, "Persona");
    expect(payload).toEqual({ global: { ...draft, name: "Persona", active: true } });
    expect(payload !== null && "model" in payload).toBe(false);
    expect(payload !== null && "keyId" in payload).toBe(false);
  });

  test("per API key targets the selected key and ignores a model chosen in the dialog", () => {
    const payload = buildCustomSaveRequest("key", "key-1", "leaked/model", draft, "Persona");
    expect(payload).toEqual({ keyId: "key-1", ...draft, name: "Persona", active: true });
    expect(payload !== null && "model" in payload).toBe(false);
  });

  test("per model is the only scope that carries a model", () => {
    const payload = buildCustomSaveRequest("model", "key-1", "chosen/model", draft, "Persona");
    expect(payload).toEqual({ model: "chosen/model", ...draft, name: "Persona", active: true });
  });

  test("a missing target refuses instead of saving under an empty one", () => {
    expect(buildCustomSaveRequest("key", "", "chosen/model", draft, "Persona")).toBeNull();
    expect(buildCustomSaveRequest("model", "key-1", "  ", draft, "Persona")).toBeNull();
  });
});

const entry = (
  scope: PromptInjectionCatalogEntry["scope"],
  target: string,
  name: string,
): PromptInjectionCatalogEntry => ({
  ...draft,
  name,
  scope,
  target,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const catalogEntries: readonly PromptInjectionCatalogEntry[] = [
  entry("global", "", "Global persona"),
  entry("key", "key-alpha", "Alpha persona"),
  entry("key", "key-beta", "Beta persona"),
  entry("model", "chosen/model", "Model persona"),
  entry("model", "other/model", "Other persona"),
];

const keyLabels = new Map([
  ["key-alpha", "Alpha key"],
  ["key-beta", "Beta key"],
]);

describe("saved picker scope", () => {
  test("global scope offers only global entries", () => {
    const options = savedOptionsForScope(catalogEntries, "global", "key-alpha", "chosen/model", keyLabels);
    expect(options.map((option) => option.value)).toEqual(["global::Global persona"]);
  });

  test("key scope offers only the selected key's entries", () => {
    const options = savedOptionsForScope(catalogEntries, "key", "key-alpha", "", keyLabels);
    expect(options.map((option) => option.value)).toEqual(["key:key-alpha:Alpha persona"]);
    expect(options[0]?.label).toBe("Alpha persona — Alpha key");
  });

  test("model scope offers only the selected model's entries", () => {
    const options = savedOptionsForScope(catalogEntries, "model", "", "  chosen/model  ", keyLabels);
    expect(options.map((option) => option.value)).toEqual(["model:chosen/model:Model persona"]);
  });

  test("an empty key target lists the whole scope, each labelled with its own key", () => {
    const options = savedOptionsForScope(catalogEntries, "key", "", "chosen/model", keyLabels);
    expect(options.map((option) => option.value)).toEqual([
      "key:key-alpha:Alpha persona",
      "key:key-beta:Beta persona",
    ]);
    expect(options.map((option) => option.label)).toEqual([
      "Alpha persona — Alpha key",
      "Beta persona — Beta key",
    ]);
    expect(savedOptionsForScope(catalogEntries, "key", "   ", "", keyLabels)).toEqual(options);
  });

  test("an empty model target lists the whole scope, each labelled with its own model", () => {
    const options = savedOptionsForScope(catalogEntries, "model", "key-alpha", "", keyLabels);
    expect(options.map((option) => option.value)).toEqual([
      "model:chosen/model:Model persona",
      "model:other/model:Other persona",
    ]);
    expect(options.map((option) => option.label)).toEqual([
      "Model persona — chosen/model",
      "Other persona — other/model",
    ]);
    expect(savedOptionsForScope(catalogEntries, "model", "", "   ", keyLabels)).toEqual(options);
  });

  test("a selected target never borrows another target's entries", () => {
    expect(
      savedOptionsForScope(catalogEntries, "key", "key-beta", "", keyLabels).map((o) => o.value),
    ).toEqual(["key:key-beta:Beta persona"]);
    expect(
      savedOptionsForScope(catalogEntries, "model", "", "other/model", keyLabels).map((o) => o.value),
    ).toEqual(["model:other/model:Other persona"]);
  });

  test("a child key id is a target like any other", () => {
    const withChild = [
      ...catalogEntries,
      entry("key", "child-ip-1", "Per-IP persona"),
    ];
    expect(
      savedOptionsForScope(withChild, "key", "child-ip-1", "", keyLabels).map((o) => o.value),
    ).toEqual(["key:child-ip-1:Per-IP persona"]);
  });
});

describe("saved picker copy", () => {
  test("a populated scope never claims nothing is saved", () => {
    for (const scope of ["global", "key", "model"] as const) {
      for (const targetSelected of [true, false]) {
        const copy = savedPickerCopy(scope, targetSelected, 2);
        expect(copy.placeholder).toBe("Load a saved injection…");
        expect(copy.emptyMessage.toLowerCase()).not.toContain("no saved");
        expect(copy.emptyMessage.toLowerCase()).not.toContain("yet");
      }
    }
  });

  test("an empty target in an empty scope says the scope holds nothing yet", () => {
    expect(savedPickerCopy("key", false, 0)).toEqual({
      placeholder: "No saved API key injections yet",
      emptyMessage: "No saved API key injections yet",
    });
    expect(savedPickerCopy("model", false, 0)).toEqual({
      placeholder: "No saved model injections yet",
      emptyMessage: "No saved model injections yet",
    });
    expect(savedPickerCopy("global", false, 0)).toEqual({
      placeholder: "No saved global injections yet",
      emptyMessage: "No saved global injections",
    });
  });

  test("a selected target keeps the prompt to save one for it", () => {
    expect(savedPickerCopy("key", true, 0)).toEqual({
      placeholder: "Save an injection for this API key first",
      emptyMessage: "No injections saved for this API key",
    });
    expect(savedPickerCopy("model", true, 0)).toEqual({
      placeholder: "Save an injection for this model first",
      emptyMessage: "No injections saved for this model",
    });
  });
});

describe("share child labels", () => {
  test("an enrolled IP leads the label with the key prefix after it", () => {
    expect(
      shareChildOptionLabel({ id: "child-1", keyPrefix: "rk_abc123", issuedClientIp: "203.0.113.44" }),
    ).toBe("203.0.113.44 — rk_abc123…");
  });

  test("a child with no recorded address still names itself", () => {
    expect(shareChildOptionLabel({ id: "child-2", keyPrefix: "rk_def456", issuedClientIp: null })).toBe(
      "unknown IP — rk_def456…",
    );
  });

  test("no prefix falls back to a short id fragment", () => {
    expect(
      shareChildOptionLabel({ id: "deadbeefdeadbeef", keyPrefix: null, issuedClientIp: "203.0.113.44" }),
    ).toBe("203.0.113.44 — deadbeef…");
    expect(
      shareChildOptionLabel({ id: "deadbeefdeadbeef", keyPrefix: "   ", issuedClientIp: null }),
    ).toBe("unknown IP — deadbeef…");
  });
});

describe("target labels", () => {
  test("global stays the all-models copy", () => {
    expect(targetLabel("global", keyLabels, "")).toBe("Global");
  });

  test("a per-key target uses the key's label", () => {
    expect(targetLabel("key", keyLabels, "key-alpha")).toBe("Alpha key");
  });

  test("a per-key target without a label falls back to an id prefix", () => {
    const label = targetLabel("key", keyLabels, "deadbeefdeadbeef");
    expect(label).toBe("key deadbeef…");
    expect(label).not.toBe("All models");
  });

  test("a per-key target never prints All models, even when the label says so", () => {
    const misleading = new Map([["key-alpha", "All models"]]);
    expect(targetLabel("key", misleading, "key-alpha")).toBe("key key-alph…");
    expect(targetLabel("key", new Map([["key-alpha", "   "]]), "key-alpha")).toBe("key key-alph…");
  });

  test("a per-model target is the model itself", () => {
    expect(targetLabel("model", keyLabels, "chosen/model")).toBe("chosen/model");
  });
});

describe("draft seeding", () => {
  test("the first seed always happens", () => {
    expect(shouldReseedDraft(null, { scope: "global", target: "" })).toBe(true);
    expect(shouldReseedDraft(null, { scope: "key", target: "key-alpha" })).toBe(true);
  });

  test("a catalog refetch for the same target does not re-seed", () => {
    const seeded = { scope: "key", target: "key-alpha" } as const;
    expect(shouldReseedDraft(seeded, { scope: "key", target: "key-alpha" })).toBe(false);
    expect(shouldReseedDraft(seeded, { scope: "key", target: "key-alpha" })).toBe(false);
  });

  test("changing scope re-seeds even when the target string is the same", () => {
    expect(
      shouldReseedDraft({ scope: "key", target: "chosen/model" }, { scope: "model", target: "chosen/model" }),
    ).toBe(true);
  });

  test("changing the target within a scope re-seeds", () => {
    expect(
      shouldReseedDraft({ scope: "key", target: "key-alpha" }, { scope: "key", target: "key-beta" }),
    ).toBe(true);
    expect(
      shouldReseedDraft({ scope: "model", target: "a/model" }, { scope: "model", target: "b/model" }),
    ).toBe(true);
  });
});

describe("active entry per target", () => {
  const catalog: PromptInjectionCatalog = {
    entries: catalogEntries,
    global: { ...draft, name: "Global persona", active: true, updatedAt: "2026-01-01T00:00:00.000Z" },
    userPrompts: {
      "key-alpha": { ...draft, name: "Alpha persona", active: true, updatedAt: "2026-01-01T00:00:00.000Z" },
    },
    prompts: {
      "chosen/model": { ...draft, name: "Model persona", active: true, updatedAt: "2026-01-01T00:00:00.000Z" },
    },
  };

  test("global reads the global slot", () => {
    expect(activeEntryForTarget(catalog, { scope: "global", target: "" })?.name).toBe("Global persona");
  });

  test("key and model read their own maps", () => {
    expect(activeEntryForTarget(catalog, { scope: "key", target: "key-alpha" })?.name).toBe("Alpha persona");
    expect(activeEntryForTarget(catalog, { scope: "model", target: "chosen/model" })?.name).toBe("Model persona");
  });

  test("an unselected or unknown target has no active entry", () => {
    expect(activeEntryForTarget(catalog, { scope: "key", target: "" })).toBeNull();
    expect(activeEntryForTarget(catalog, { scope: "model", target: "" })).toBeNull();
    expect(activeEntryForTarget(catalog, { scope: "key", target: "key-beta" })).toBeNull();
  });
});

describe("loaded versus active notice", () => {
  test("nothing loaded means no notice", () => {
    expect(loadedEntryNotice("", "Active persona")).toBeNull();
    expect(loadedEntryNotice("   ", null)).toBeNull();
  });

  test("the loaded entry that is also active says nothing", () => {
    expect(loadedEntryNotice("Alpha persona", "Alpha persona")).toBeNull();
    expect(loadedEntryNotice("  Alpha persona  ", "Alpha persona")).toBeNull();
  });

  test("a loaded entry that is not active names both entries", () => {
    expect(loadedEntryNotice("Draft persona", "Active persona")).toBe(
      "Loaded: Draft persona · not active (the router applies Active persona)",
    );
  });

  test("a target with no active entry says so instead of naming a phantom", () => {
    expect(loadedEntryNotice("Draft persona", null)).toBe(
      "Loaded: Draft persona · not active (the router applies no injection for this target)",
    );
  });
});

describe("preview inspection", () => {
  test("the preview picker offers every saved entry with its own target", () => {
    const options = previewOptionsFor(catalogEntries, keyLabels);
    expect(options.map((option) => option.value)).toEqual([
      "global::Global persona",
      "key:key-alpha:Alpha persona",
      "key:key-beta:Beta persona",
      "model:chosen/model:Model persona",
      "model:other/model:Other persona",
    ]);
    expect(options[1]?.label).toBe("Alpha persona — Alpha key");
  });

  test("the inspection label never claims the preview applied the entry", () => {
    expect(previewSelectionLabel(entry("key", "key-alpha", "Alpha persona"), keyLabels)).toBe(
      "Inspecting Alpha persona — Alpha key · not applied by this preview",
    );
    expect(previewSelectionLabel(entry("global", "", "Global persona"), keyLabels)).toBe(
      "Inspecting Global persona — all models · not applied by this preview",
    );
  });

  test("an unnamed entry still reads as a sentence", () => {
    expect(previewSelectionLabel(entry("model", "chosen/model", ""), keyLabels)).toBe(
      "Inspecting Untitled — chosen/model · not applied by this preview",
    );
  });
});

describe("unsaved editor detection", () => {
  const saved = {
    ...draft,
    name: "Alpha persona",
    content: "Saved text",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  test("an untouched draft matches its saved entry", () => {
    expect(draftDiffersFromEntry(saved, saved)).toBe(false);
  });

  test("a target with nothing saved reports any content as unsaved", () => {
    expect(draftDiffersFromEntry({ ...saved, content: "   " }, null)).toBe(false);
    expect(draftDiffersFromEntry(saved, null)).toBe(true);
  });

  test("editing any saved field counts", () => {
    expect(draftDiffersFromEntry({ ...saved, content: "Edited" }, saved)).toBe(true);
    expect(draftDiffersFromEntry({ ...saved, position: "prepend" }, saved)).toBe(true);
    expect(draftDiffersFromEntry({ ...saved, enabled: false }, saved)).toBe(true);
    expect(draftDiffersFromEntry({ ...saved, active: true }, saved)).toBe(true);
  });

  test("turn content and role are compared, not just the count", () => {
    const base = {
      ...saved,
      mode: "script" as const,
      content: "",
      turns: [{ role: "user" as const, content: "hi" }],
    };
    expect(draftDiffersFromEntry(base, base)).toBe(false);
    expect(
      draftDiffersFromEntry({ ...base, turns: [{ role: "assistant", content: "hi" }] }, base),
    ).toBe(true);
    expect(
      draftDiffersFromEntry({ ...base, turns: [{ role: "user", content: "bye" }] }, base),
    ).toBe(true);
  });

  test("the notice says the test runs the saved stack", () => {
    expect(TEST_UNSAVED_NOTICE).toContain("saved stack");
    expect(TEST_UNSAVED_NOTICE).toContain("not applied");
  });
});

const previewEntry = (
  scope: PromptInjectionPreviewEntry["scope"],
  target = "",
): PromptInjectionPreviewEntry => ({
  scope,
  target,
  mode: "prompt",
  preset: "custom",
  position: "append",
  text: `${scope} text`,
});

const fullStack: readonly PromptInjectionPreviewEntry[] = [
  previewEntry("global"),
  previewEntry("key", "key-alpha"),
  previewEntry("model", "chosen/model"),
];

describe("preview key options", () => {
  test("the clearable No key option leads and sends an empty value", () => {
    const options = previewKeyOptions([
      { id: "key-alpha", label: "Alpha key" },
      { id: "key-beta", label: "Beta key" },
    ]);
    expect(options[0]).toEqual({ value: "", label: "No key — per-key injections excluded" });
    expect(options.map((option) => option.value)).toEqual(["", "key-alpha", "key-beta"]);
    expect(options[1]?.label).toBe("Alpha key");
  });

  test("no testable keys still offers the No key mode", () => {
    expect(previewKeyOptions([])).toEqual([
      { value: "", label: "No key — per-key injections excluded" },
    ]);
  });
});

describe("visible stack", () => {
  test("every scope on renders the whole stack in resolution order", () => {
    expect(visibleStack(fullStack, ALL_PREVIEW_SCOPES)).toEqual(fullStack);
  });

  test("hiding the key scope drops only per-key cards", () => {
    const shown = visibleStack(fullStack, { global: true, key: false, model: true });
    expect(shown.map((entry) => entry.scope)).toEqual(["global", "model"]);
  });

  test("hiding every scope renders nothing", () => {
    expect(visibleStack(fullStack, { global: false, key: false, model: false })).toEqual([]);
  });

  test("an empty stack stays empty", () => {
    expect(visibleStack([], ALL_PREVIEW_SCOPES)).toEqual([]);
  });
});

describe("stack scope counts", () => {
  test("counts each resolved scope", () => {
    expect(stackScopeCounts(fullStack)).toEqual({ global: 1, key: 1, model: 1 });
  });

  test("a scope with no entry counts zero", () => {
    expect(stackScopeCounts([previewEntry("global")])).toEqual({ global: 1, key: 0, model: 0 });
    expect(stackScopeCounts([])).toEqual({ global: 0, key: 0, model: 0 });
  });
});

describe("test request scope summary", () => {
  test("names every scope the resolved stack carries, in router order", () => {
    expect(stackScopeSummary(fullStack)).toBe("This request carries: global, per-key, per-model.");
  });

  test("a no-key preview says what the preview resolved", () => {
    expect(stackScopeSummary([previewEntry("global"), previewEntry("model", "chosen/model")])).toBe(
      "This request carries: global, per-model.",
    );
  });

  test("an empty stack says nothing is carried instead of listing nothing", () => {
    expect(stackScopeSummary([])).toBe("This request carries no injections.");
  });
});

describe("preview scope filter copy", () => {
  test("the shown line lists the visible scopes and names the hidden ones", () => {
    expect(previewScopeShownSummary(ALL_PREVIEW_SCOPES)).toBe("Showing global + per-key + per-model");
    expect(previewScopeShownSummary({ global: true, key: false, model: true })).toBe(
      "Showing global + per-model · per-key hidden",
    );
    expect(previewScopeShownSummary({ global: false, key: false, model: true })).toBe(
      "Showing per-model · global + per-key hidden",
    );
    expect(previewScopeShownSummary({ global: false, key: false, model: false })).toBe(
      "Showing no scopes · global + per-key + per-model hidden",
    );
  });

  test("the honest notice appears only once a scope is hidden", () => {
    expect(previewScopeFilterNotice(ALL_PREVIEW_SCOPES)).toBeNull();
    const notice = previewScopeFilterNotice({ global: true, key: false, model: true });
    expect(notice).toContain("Display filter only");
    expect(notice).toContain("router still applies");
  });

  test("the disabled test explains why a key is still required", () => {
    expect(TEST_NEEDS_KEY_NOTICE).toContain("Pick an API key");
    expect(TEST_NEEDS_KEY_NOTICE).toContain("skipped only in the preview");
  });
});

const savedRow = (
  scope: PromptInjectionCatalogEntry["scope"],
  target: string,
  name: string,
  active: boolean,
): PromptInjectionCatalogEntry => ({ ...entry(scope, target, name), active });

describe("saved list grouping by target", () => {
  test("two keys each with one active entry are two groups, one active each", () => {
    const groups = groupByTarget(
      [
        savedRow("key", "4bba799f-1111", "Newest", true),
        savedRow("key", "9c31e0a2-2222", "Newest 2", true),
      ],
      new Map([
        ["4bba799f-1111", "all"],
        ["9c31e0a2-2222", "all"],
      ]),
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.activeCount)).toEqual([1, 1]);
    expect(groups.map((group) => group.total)).toEqual([1, 1]);
  });

  test("a target with no active entry reports zero instead of hiding", () => {
    const groups = groupByTarget(
      [
        savedRow("key", "key-alpha", "Alpha persona", true),
        savedRow("key", "key-alpha", "Alpha spare", false),
        savedRow("key", "key-beta", "Beta persona", false),
      ],
      keyLabels,
    );
    expect(groups.map((group) => group.target)).toEqual(["key-alpha", "key-beta"]);
    expect(groups.map((group) => group.activeCount)).toEqual([1, 0]);
    expect(groups.map((group) => group.total)).toEqual([2, 1]);
  });

  test("colliding labels both carry an id fragment and stay distinguishable", () => {
    const groups = groupByTarget(
      [
        savedRow("key", "4bba799f-1111", "Newest", true),
        savedRow("key", "9c31e0a2-2222", "Newest 2", true),
      ],
      new Map([
        ["4bba799f-1111", "all"],
        ["9c31e0a2-2222", "all"],
      ]),
    );
    expect(groups.map((group) => group.heading)).toEqual([
      "all · key 4bba799f…",
      "all · key 9c31e0a2…",
    ]);
    expect(new Set(groups.map((group) => group.heading)).size).toBe(2);
  });

  test("unique labels keep the heading clean", () => {
    const groups = groupByTarget(
      [
        savedRow("key", "key-alpha", "Alpha persona", true),
        savedRow("key", "key-beta", "Beta persona", false),
      ],
      keyLabels,
    );
    expect(groups.map((group) => group.heading)).toEqual(["Alpha key", "Beta key"]);
  });

  test("groups are ordered by label, then by target id", () => {
    const groups = groupByTarget(
      [
        savedRow("key", "zzz", "Zed", false),
        savedRow("key", "aaa", "Alpha", false),
        savedRow("key", "mmm", "Alpha", false),
      ],
      new Map([
        ["zzz", "Zed"],
        ["aaa", "Alpha"],
        ["mmm", "Alpha"],
      ]),
    );
    expect(groups.map((group) => group.target)).toEqual(["aaa", "mmm", "zzz"]);
    // Same label twice, so both are disambiguated — order still comes from id.
    expect(groups.map((group) => group.heading)).toEqual([
      "Alpha · key aaa…",
      "Alpha · key mmm…",
      "Zed",
    ]);
  });

  test("an unlabelled key falls back to an id fragment", () => {
    const groups = groupByTarget([savedRow("key", "orphan-key-1", "Orphan", true)], new Map());
    expect(groups[0]?.heading).toBe("key orphan-k…");
    expect(groups[0]?.activeCount).toBe(1);
  });

  test("empty input yields no groups", () => {
    expect(groupByTarget([], keyLabels)).toEqual([]);
  });

  test("the active label says so in words when a target has none", () => {
    expect(targetGroupActiveLabel(2)).toBe("2 active");
    expect(targetGroupActiveLabel(0)).toBe("no active entry");
  });
});
