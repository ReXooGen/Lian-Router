export interface QuotaBarTone {
  bar: string;
  text: string;
}

export function formatResetDistance(value: string | null, recurring = true): string {
  if (!value) return "";
  const remaining = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return recurring ? "Resetting soon" : "Expired";
  const prefix = recurring ? "Resets in" : "Expires in";
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `${prefix} ${totalMinutes}mins`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${prefix} ${totalHours}h${minutes > 0 ? ` ${minutes}mins` : ""}`;
  const totalDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const suffix = `${hours > 0 ? ` ${hours}h` : ""}${minutes > 0 ? ` ${minutes}mins` : ""}`;
  if (totalDays >= 365) {
    const years = Math.floor(totalDays / 365);
    const days = totalDays % 365;
    return `${prefix} ${years}y${days > 0 ? ` ${days}d` : ""}${suffix}`;
  }
  if (totalDays >= 30) {
    const months = Math.floor(totalDays / 30);
    const days = totalDays % 30;
    return `${prefix} ${months}mo${days > 0 ? ` ${days}d` : ""}${suffix}`;
  }
  return `${prefix} ${totalDays}d${suffix}`;
}

export function formatQuotaWindowLabel(label: string): string {
  const match = /^(\d+)\s*hour$/i.exec(label.trim());
  if (!match) return label;
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) return label;
  if (hours === 24) return "Daily";
  if (hours === 168) return "Weekly";
  if (hours === 720) return "Monthly";
  if (hours === 8760) return "Yearly";
  if (hours >= 8760)
    return `${Math.floor(hours / 8760)}y${hours % 8760 > 0 ? ` ${Math.floor((hours % 8760) / 24)}d` : ""}`;
  if (hours >= 720)
    return `${Math.floor(hours / 720)}mo${hours % 720 > 0 ? ` ${Math.floor((hours % 720) / 24)}d` : ""}`;
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24 > 0 ? ` ${hours % 24}h` : ""}`;
  return `${hours}h`;
}

export function formatQuotaRefresh(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `Last refreshed: ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
    : "";
}

export function friendlyQuotaError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower.includes("invalidated") ||
    lower.includes("reauthorization") ||
    lower.includes("refresh token revoked")
  )
    return "OAuth account invalidated — re-login required";
  // An account the vendor answered for, with no plan attached yet, is a state
  // and not a fault: it is what a fresh login looks like before a campaign is
  // claimed. Red provider-error copy made it read like a broken credential.
  if (lower.includes("has no plan grants"))
    return "No plan on this account yet — claim a campaign or wait for one";
  // Collectorless providers never refresh, so this backend string should no
  // longer surface — but a stale cached error may still carry it. Keep the
  // mapping as a safety net, not a state the UI can reach fresh.
  if (lower.includes("endpoint is not available") || lower === "not available")
    return "Quota tracking is not supported for this provider";
  // A rate limit is a wait, not an exhausted account, and every rejection the
  // collector raises contains the word "quota" ("Quota endpoint rejected
  // request: HTTP 429"), so this has to be decided before the generic quota
  // branch or the operator is told to wait for a reset that is not the issue.
  if (
    lower.includes("http 429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limited")
  )
    return "Vendor rate limit — retry shortly, the account is fine";
  if (lower.includes("overloaded") || lower.includes("capacity") || lower.includes("temporarily unavailable"))
    return "Provider capacity unavailable — retry after the indicated time";
  if (lower.includes("usage limit") || lower.includes("quota"))
    return "Quota exhausted — wait for the reset window";
  if (lower.includes("http 500") || lower.includes("internal server error"))
    return "Provider temporarily unavailable — retry in a moment";
  if (lower.includes("http 401") || lower.includes("unauthorized") || lower.includes("invalid"))
    return "Credential expired — re-login or refresh token";
  if (lower.includes("http 403") || lower.includes("forbidden"))
    return "Access denied — check account permissions";
  if (lower.includes("http 402") || lower.includes("payment"))
    return "Payment required — top up account balance";
  if (lower.includes("connect") || lower.includes("network") || lower.includes("timeout"))
    return "Network error — check connection and retry";
  return "Provider error — inspect account health details";
}

/**
 * Describes a grant that is granted but not yet spendable.
 *
 * A campaign is often issued hours before its units unlock: the plan is
 * `active` and its size is known, but the vendor refuses every request until a
 * scheduled instant. Rendering that window as a normal balance says "300M
 * available" while nothing works; rendering it as empty says the grant is
 * missing. Both lie, so the card reports the schedule instead.
 *
 * Returns `null` for a window with nothing scheduled, which is the ordinary
 * case and must keep rendering as it always did.
 */
export function pendingGrantLabel(
  availableAt: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (availableAt === null || availableAt === undefined) return null;
  const at = new Date(availableAt).getTime();
  if (!Number.isFinite(at)) return null;
  if (at <= now) return null;
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = new Date(at).toLocaleDateString([], { weekday: "short" });
  const distance = formatResetDistance(availableAt, false).replace(/^Expires in /, "");
  return `Pending ${day} ${time}${distance.length > 0 ? ` · in ${distance}` : ""}`;
}

export function quotaBarTone(remaining: number | null): QuotaBarTone {
  if (remaining === null) return { bar: "var(--text-tertiary)", text: "var(--text-tertiary)" };
  if (remaining < 20) return { bar: "var(--red)", text: "var(--red)" };
  if (remaining < 50) return { bar: "var(--orange)", text: "var(--orange)" };
  return { bar: "var(--green)", text: "var(--green)" };
}

export interface AccountIdentity {
  readonly primary: string;
  readonly secondary: string | null;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isTokenHint(value: string): boolean {
  return value.startsWith("eyJ") || value.startsWith("sk-") || value.startsWith("…");
}

export function displayAccountHint(hint: string, name: string): string {
  if (hint.startsWith("eyJ") || hint === "—") return name;
  return hint;
}

/** Credential-kind labels are categories, not identities — never displayed. */
const NON_IDENTITY_HINTS: ReadonlySet<string> = new Set(["oauth", "api_key", "none"]);

export function accountIdentity(hint: string, name: string): AccountIdentity {
  const fallbackName = name.trim() || "Unnamed account";
  const normalizedHint = displayAccountHint(hint, fallbackName).trim();
  const usableHint =
    normalizedHint && normalizedHint !== "—" && !NON_IDENTITY_HINTS.has(normalizedHint.toLowerCase())
      ? normalizedHint
      : null;
  const email =
    [usableHint, fallbackName].find((value): value is string => value !== null && isEmail(value)) ??
    null;
  if (email !== null) {
    const secondary =
      [fallbackName, usableHint].find(
        (value): value is string => value !== null && value !== email && !isTokenHint(value),
      ) ?? null;
    return { primary: email, secondary };
  }
  const secondary =
    usableHint !== null && usableHint !== fallbackName && !isTokenHint(usableHint)
      ? usableHint
      : null;
  return { primary: fallbackName, secondary };
}
