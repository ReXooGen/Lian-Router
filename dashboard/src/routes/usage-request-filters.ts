/** Access scope of the Usage requests table. */
export type UsageRequestScope = "all" | "shared";

/** The Requests card's cascade selection; empty ids mean "not narrowed". */
export interface UsageRequestFilter {
  readonly accessScope: UsageRequestScope;
  readonly parentKeyId: string;
  readonly childKeyId: string;
}

export type UsageRequestFilterChange =
  | { readonly kind: "scope"; readonly scope: UsageRequestScope }
  | { readonly kind: "template"; readonly parentKeyId: string }
  | { readonly kind: "childKey"; readonly childKeyId: string };

/**
 * Applies one dropdown change. Returning to "all requests" drops the
 * shared-only template/key filters, and a new template drops the key that
 * belonged to the previous one; either selector could otherwise send a filter
 * that contradicts the visible scope.
 */
export function nextUsageRequestFilter(
  current: UsageRequestFilter,
  change: UsageRequestFilterChange,
): UsageRequestFilter {
  switch (change.kind) {
    case "scope":
      return change.scope === "all"
        ? { accessScope: "all", parentKeyId: "", childKeyId: "" }
        : { ...current, accessScope: "shared" };
    case "template":
      return { ...current, parentKeyId: change.parentKeyId, childKeyId: "" };
    case "childKey":
      return { ...current, childKeyId: change.childKeyId };
  }
}
