// Provider-aware grouping for the generation picker. The catalog is a flat
// list; the picker must never merge two providers that expose the same model
// id, so grouping happens once here and both the Generation page and Model
// Lab's Generate tool read it.
import type { GenerationKind, GenerationModel } from "./contracts";

export interface GenerationProviderGroup {
  readonly id: string;
  readonly label: string;
  readonly models: readonly GenerationModel[];
}

/** Groups models of one kind by provider, sorted by label then id. */
export function groupGenerationProviders(
  models: readonly GenerationModel[],
  kind: GenerationKind,
): readonly GenerationProviderGroup[] {
  const grouped = new Map<string, { id: string; label: string; models: GenerationModel[] }>();
  for (const model of models) {
    if (model.kind !== kind) continue;
    const existing = grouped.get(model.providerId);
    if (existing) existing.models.push(model);
    else
      grouped.set(model.providerId, {
        id: model.providerId,
        label: model.providerLabel,
        models: [model],
      });
  }
  return [...grouped.values()]
    .map((group) => ({
      id: group.id,
      label: group.label,
      models: [...group.models].sort((left, right) =>
        left.modelId.localeCompare(right.modelId),
      ),
    }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

/** Provider label for the picker: keeps the id visible when the label differs. */
export function providerOptionLabel(group: GenerationProviderGroup): string {
  return group.label === group.id ? group.id : `${group.label} · ${group.id}`;
}
