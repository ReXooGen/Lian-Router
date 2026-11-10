import { decodeJwtPayload } from "../authentication/oauth-flow-store";

export interface ProviderQuotaWindow {
  readonly kind: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly used?: number | null;
  readonly limit?: number | null;
  /** False means the timestamp is a hard expiry rather than a recurring reset. */
  readonly recurring?: boolean;
  /**
   * When this grant first becomes spendable, for a grant that is not yet live.
   *
   * A campaign can be granted while its units are still pending: the plan is
   * `active` and its size is known, but the vendor refuses to spend it until a
   * scheduled instant. Reporting that window as a normal balance says "you have
   * 300M" while every request is refused, and reporting it as empty says the
   * grant is missing. The instant is the only honest answer, so it travels with
   * the window; `null` means the grant has no schedule and is spendable now.
   */
  readonly availableAt?: string | null;
  /**
   * The plan that granted this window, when one account holds several plans.
   *
   * An account can carry a referral grant beside a paid plan, and each is a
   * separate entitlement with its own limits. Without this field the dashboard
   * could only show the grants as one undifferentiated list, so a two-plan
   * account looked like a single plan with several pools.
   */
  readonly group?: string | null;
}

export interface ProviderQuotaResult {
  readonly source: string;
  readonly plan: string | null;
  readonly windows: readonly ProviderQuotaWindow[];
  readonly error: string | null;
}

/**
 * True when every grant this result describes is spent.
 *
 * Callers use this to stop offering things that can no longer be used: a plan
 * whose grants are all at zero is still a plan, but nothing can be drawn from
 * it, so a claim card or a quota row built on it would advertise an account
 * that refuses every request.
 *
 * Three conditions, all required, and each excludes a real state:
 * - no read error — a refused read says nothing about the balance;
 * - at least one window — an account with no grants is "empty", not "spent",
 *   and the two read differently to an operator;
 * - every window at or below zero, with no unknown (`null`) window, because an
 *   unknown balance must never be treated as exhausted.
 */
export function isQuotaExhausted(quota: ProviderQuotaResult): boolean {
  if (quota.error !== null) return false;
  if (quota.windows.length === 0) return false;
  return quota.windows.every(
    (window) => window.remainingPercent !== null && window.remainingPercent <= 0,
  );
}

export type FetchLike = typeof fetch;

const TIMEOUT_MS = 15_000;

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

export function isoDate(value: unknown): string | null {
  const numeric = number(value);
  if (numeric !== null)
    return new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000).toISOString();
  const stringValue = text(value);
  return stringValue !== null && Number.isFinite(Date.parse(stringValue))
    ? new Date(stringValue).toISOString()
    : null;
}

export function cleanError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : "Quota request failed — provider did not return a valid response";
  return message
    .replace(/Bearer\s+[^\n"']*/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

export function quotaRecord(value: unknown): Record<string, unknown> {
  const root = record(value) ?? {};
  return record(root.data) ?? record(root.result) ?? record(root.usage) ?? root;
}

export function percentWindow(
  kind: string,
  label: string,
  used: number | null,
  resetsAt: string | null,
  usedValue?: number | null,
  limit?: number | null,
): ProviderQuotaWindow {
  const usedPercent = used === null ? null : Math.min(100, Math.max(0, used));
  return {
    kind,
    label,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt,
    used: usedValue ?? null,
    limit: limit ?? null,
  };
}

export function authCredential(credential: string): Record<string, unknown> {
  const parsed = record(
    credential.startsWith("{")
      ? (() => {
          try {
            return JSON.parse(credential);
          } catch {
            return null;
          }
        })()
      : null,
  );
  return parsed ?? { accessToken: credential };
}

/**
 * The ChatGPT account id carried by a Codex access token, or `null`.
 *
 * Reads the claims through the shared `decodeJwtPayload` rather than a local
 * `atob(…replace(/-/g,"+")…)`. The two decoders agreed on every ASCII payload,
 * but `atob` decodes base64 to a Latin-1 string, so a claim containing
 * multi-byte UTF-8 came back mojibake — `Buffer.from(segment, "base64url")`
 * is byte-correct. The three fields read here are ASCII either way, so this is
 * a correctness fix for the decoder, not a behaviour change for Codex.
 */
export function codexJwtAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;
  const auth = record(payload["https://api.openai.com/auth"]);
  return (
    text(auth?.chatgpt_account_id) ??
    text(payload["chatgpt_account_id"]) ??
    text(payload["account_id"])
  );
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  fetcher: FetchLike,
  body?: unknown,
): Promise<unknown> {
  const response = await fetcher(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      accept: "application/json",
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const textBody = await response.text();
  let parsed: unknown = null;
  try {
    parsed = textBody.length > 0 ? JSON.parse(textBody) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const envelope = record(parsed);
    // A 429 usually answers with an empty body, so the status has to supply the
    // reason: "HTTP 429" alone reads as a generic rejection, while the operator
    // needs to know that waiting is the fix and that the account is healthy.
    const detail =
      text(envelope?.error) ??
      text(envelope?.message) ??
      (response.status === 429 ? "rate limited (HTTP 429)" : `HTTP ${response.status}`);
    throw new Error(`Quota endpoint rejected request: ${detail}`);
  }
  const envelope = record(parsed);
  if (envelope?.success === false)
    throw new Error(text(envelope.error) ?? "Quota endpoint rejected the request.");
  return envelope?.success === true && "data" in envelope ? envelope.data : parsed;
}

/**
 * How long one rate-limited quota read waits before its single retry.
 *
 * The vendor answers `429` with `retry-after: 1` and no body; a burst of
 * account reads trips it even though each read is a separate account. One
 * retry after a short delay turns a transient refusal into an answer, while a
 * longer window still returns promptly instead of blocking the page.
 */
const RATE_LIMIT_RETRY_MS = 1_500;

/**
 * Reads one quota surface, retrying once when the vendor rate-limits it.
 *
 * A `429` is the vendor asking for a pause, not an answer about the account.
 * Without this the collector reported the refusal as its result, so an account
 * holding a live plan displayed as one with no plan whenever the read landed
 * inside the window.
 */
export async function getJsonWithRateLimitRetry(
  url: string,
  headers: Record<string, string>,
  fetcher: FetchLike,
  body?: unknown,
): Promise<unknown> {
  try {
    return await getJson(url, headers, fetcher, body);
  } catch (error) {
    if (!(error instanceof Error) || !/HTTP 429|rate limited/i.test(error.message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_MS));
    return await getJson(url, headers, fetcher, body);
  }
}

export function unsupportedQuota(providerId: string): {
  source: string;
  plan: null;
  windows: [];
  error: string;
} {
  return {
    source: providerId,
    plan: null,
    windows: [],
    error: "Quota endpoint is not available for this provider.",
  };
}
