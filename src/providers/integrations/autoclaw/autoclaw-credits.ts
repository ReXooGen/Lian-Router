/**
 * AutoClaw wallet and daily check-in.
 *
 * The desktop client keeps its points on a billing facade separate from the
 * completion gateway: reads go to the asset manager (which answers a plainly
 * shaped envelope and needs no app signature), while claims go through the
 * proxy that fronts the task service and does require the signed headers.
 *
 * Two facts were measured, not read:
 *
 *  - **The wallet read needs no app authentication.** `GET
 *    /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw` answers the daily and
 *    total balances for a bearer alone. Sending the signature headers anyway is
 *    harmless, but a deployment whose client version has aged out of the
 *    gateway's accepted range would then lose the read for no reason, so the
 *    wallet call deliberately does not sign.
 *  - **The claim is a task completion, not a check-in endpoint.** The proxy
 *    exposes `/autoclaw-proxy/proxy/autoclaw-task-complete` and takes a
 *    `task_id`; `daily_signin` is the one that grants the login credit. A
 *    duplicate answers `already_completed: true` with no reward rather than an
 *    error, so "already done" is a normal state, never a failure.
 *
 * The remaining tasks are one-shot onboarding grants. They are claimed in the
 * same pass because they cost nothing when already done, and an account that
 * has never opened the desktop app would otherwise leave them on the table.
 */

import { autoClawAppHeaders } from "./spec";

/** The billing facade that holds the points. */
const ASSET_ORIGIN = "https://autoglm-api.autoglm.ai";
const WALLETS_PATH = "/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw";
/**
 * The activity report the desktop client posts when a task is sent.
 *
 * This is the trigger behind the "Limited-time Bonus" campaign grants
 * (`event_type: autoclaw_user_active`, `wallet_scope: campaign`): measured
 * 2026-11-12 by comparing two accounts — the one that had opened the desktop app
 * carried the 10.000-point grant, the one created and used only through this
 * gateway did not, and posting this event for the latter produced the grant.
 *
 * It is a report, not a claim: the server decides whether a period's campaign
 * pays out, so sending it is idempotent and harmless when nothing is running.
 * The standard `authorization` header is the one this route reads; the
 * `x-authorization` variant is answered `410000 Invalid access token`.
 */
const WEB_EVENT_PATH = "/userapi/v1/user/web-event/report";

/** The task proxy that fronts the claim. */
const TASK_PATH = "/autoclaw-proxy/proxy/autoclaw-task-complete";
/** The points ledger: grants and model charges, newest first. */
const LEDGER_PATH = "/agent-assetmgr/api/v1/ledgers_std";
/** Account profile: the only route that returns the login email for a token. */
const PROFILE_PATH = "/userapi/v1/user-profile";

/** Abort budget for one billing call. */
const TIMEOUT_MS = 15_000;

/**
 * Daily and one-shot grants, in the order the desktop client claims them.
 *
 * `daily_signin` is the only recurring one; the rest are onboarding credits that
 * answer `already_completed` forever after the first success.
 */
export const AUTOCLAW_CHECKIN_TASKS: readonly { readonly id: string; readonly label: string }[] = [
  { id: "daily_signin", label: "Daily sign-in" },
  { id: "daily_inspiration_center", label: "Inspiration Center" },
  { id: "newbie_cloud_lobster", label: "Cloud Lobster" },
  { id: "newbie_local_lobster", label: "Local Lobster" },
];

export type AutoClawCheckinState =
  | "claimed"
  | "already_claimed"
  | "unavailable"
  | "error";

export interface AutoClawWallet {
  /** Points across every wallet, as the facade reports it. Matches the
   * dashboard's `wallet.totalBalance` field. */
  readonly totalBalance: number | null;
  /** Points in the daily wallet; `null` when the facade lists no daily wallet. */
  readonly dailyPoints: number | null;
  /** Login email from the profile route; `null` when the account hides it. */
  readonly email: string | null;
  readonly updatedAt: string;
}

export interface AutoClawCheckinResult {
  readonly state: AutoClawCheckinState;
  /** Points granted by this pass; `0` when everything was already claimed. */
  readonly credit: number | null;
  /** Tasks claimed this pass, by label. */
  readonly claims: readonly { readonly task: string; readonly points: number }[];
  /** Tasks the facade answered as already done. */
  readonly already: readonly string[];
  readonly error: string | null;
}

/** Reads the account's points. A missing balance is an error, not a zero. */
export async function fetchAutoClawWallet(
  credential: string,
  fetcher: typeof fetch = fetch,
): Promise<AutoClawWallet> {
  const token = normalizeToken(credential);
  if (token.length === 0) throw new Error("Account has no stored credential.");
  const response = await fetcher(`${ASSET_ORIGIN}${WALLETS_PATH}`, {
    method: "GET",
    headers: { accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Credential invalid or expired.");
  }
  if (!response.ok) throw new Error(`Wallet read failed (HTTP ${response.status}).`);
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) throw new Error("Wallet read returned an unreadable body.");
  const data = asRecord(body["data"]);
  const total = asNumber(data?.["total_balance"]);
  if (total === null) throw new Error("Wallet read carried no total balance.");
  const wallets = Array.isArray(data?.["wallets"]) ? (data!["wallets"] as unknown[]) : [];
  const daily = asNumber(
    asRecord(wallets.find((entry) => asRecord(entry)?.["public_wallet_type"] === "daily"))?.[
      "balance"
    ],
  );
  // The email rides the same refresh pass: one extra signed call, and the
  // operator needs it to tell same-named accounts apart on the credits card.
  let email: string | null = null;
  try {
    const profile = await fetcher(`${ASSET_ORIGIN}${PROFILE_PATH}`, {
      method: "POST",
      headers: {
        // The profile route is served behind the same middleware as the task
        // proxy: a bearer alone answers "Middleware sign error" from a datacenter
        // IP, so the app signature travels with it.
        ...autoClawAppHeaders(),
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const pbody = (await profile.json().catch(() => null)) as Record<string, unknown> | null;
    email = asText(asRecord(pbody?.["data"])?.["email"]);
  } catch {
    // A profile failure must not hide the wallet numbers; email is decoration.
  }
  return { totalBalance: total, dailyPoints: daily, email, updatedAt: new Date().toISOString() };
}

/**
 * Claims every grant that is still outstanding.
 *
 * Each task is independent: one refused claim does not stop the next, and the
 * summary reports both the credited total and the tasks that were already done.
 * A credential failure short-circuits, because every remaining task would fail
 * the same way and the operator needs one clear reason rather than four.
 */
export async function claimAutoClawCheckin(
  credential: string,
  fetcher: typeof fetch = fetch,
): Promise<AutoClawCheckinResult> {
  const token = normalizeToken(credential);
  const claims: { task: string; points: number }[] = [];
  const already: string[] = [];
  const errors: string[] = [];
  if (token.length === 0) {
    return { credit: 0, claims, already, state: "error", error: "Account has no stored credential." };
  }

  for (const task of AUTOCLAW_CHECKIN_TASKS) {
    let body: Record<string, unknown> | null;
    try {
      const response = await fetcher(`${ASSET_ORIGIN}${TASK_PATH}`, {
        method: "POST",
        headers: {
          // `authorization`, not `x-authorization`. The task proxy reads the
          // standard header here even though the completion gateway reads the
          // x- variant; sending the wrong one answers 401 for a live token.
          ...autoClawAppHeaders(),
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ task_id: task.id }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        return {
          credit: 0,
          claims,
          already,
          state: "error",
          error: "Credential invalid or expired.",
        };
      }
      body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    } catch (error) {
      errors.push(`${task.label}: ${error instanceof Error ? error.message : "request failed"}`);
      continue;
    }
    const code = asNumber(body?.["code"]);
    if (code !== null && code !== 0) {
      errors.push(`${task.label}: ${asText(body?.["msg"]) ?? `code ${code}`}`);
      continue;
    }
    const data = asRecord(body?.["data"]);
    if (data === null) {
      errors.push(`${task.label}: no task result`);
      continue;
    }
    if (data["already_completed"] === true) {
      already.push(task.label);
      continue;
    }
    if (data["success"] !== true) {
      errors.push(`${task.label}: ${asText(body?.["msg"]) ?? "claim refused"}`);
      continue;
    }
    claims.push({ task: task.label, points: asNumber(data["reward_points"]) ?? 0 });
  }

  const credit = claims.reduce((sum, entry) => sum + entry.points, 0);
  if (errors.length > 0 && claims.length === 0 && already.length === 0) {
    return { credit: 0, claims, already, state: "error", error: errors.join("; ") };
  }
  if (claims.length > 0) {
    return {
      credit,
      claims,
      already,
      state: "claimed",
      error: errors.length > 0 ? errors.join("; ") : null,
    };
  }
  if (already.length > 0) {
    return {
      credit: 0,
      claims,
      already,
      state: "already_claimed",
      error: errors.length > 0 ? errors.join("; ") : null,
    };
  }
  return { credit: 0, claims, already, state: "unavailable", error: errors.join("; ") || null };
}

/**
 * One movement in the account's points ledger.
 *
 * The desktop client shows this list under the wallet and reads it from
 * `ledgers_std`, which is a plain paginated read behind a bearer — no app
 * signature, same as the wallet itself. `amount` carries the sign, so a grant
 * is positive and a model charge is negative; `flow_direction` filters on the
 * same fact upstream and is offered so the UI can show one side at a time.
 */
export interface AutoClawLedgerEntry {
  readonly id: string;
  /** Signed points: positive for a grant, negative for a charge. */
  readonly amount: number;
  readonly description: string;
  readonly occurredAt: string;
  /** Wallet the movement landed in (`daily`, `monthly`, `annual`, `reward`…). */
  readonly walletScope: string | null;
  readonly direction: "credit" | "debit";
  /**
   * When the wallet this movement landed in expires, as epoch seconds — the
   * vendor expires wallet scopes on their own clocks (a daily check-in grant
   * measured 2026-11-23 carried `+6 days`), so two grants of the same size can
   * lapse on different days. `null` when the envelope omitted it.
   */
  readonly walletExpiresAt: number | null;
}

export interface AutoClawLedgerPage {
  readonly entries: readonly AutoClawLedgerEntry[];
  /** Opaque token for the next page; `null` when this is the last one. */
  readonly nextCursor: string | null;
}

export type AutoClawLedgerDirection = "all" | "income" | "expense";

/** The ledger read, paged. A page that cannot be read is an error, not an empty list. */
export async function fetchAutoClawLedger(
  credential: string,
  options: { readonly direction?: AutoClawLedgerDirection; readonly cursor?: string; readonly pageSize?: number } = {},
  fetcher: typeof fetch = fetch,
): Promise<AutoClawLedgerPage> {
  const token = normalizeToken(credential);
  if (token.length === 0) throw new Error("Account has no stored credential.");
  const query = new URLSearchParams({
    asset_type: "point",
    wallet_type: "all",
    page_size: String(options.pageSize ?? 20),
    flow_direction: options.direction ?? "all",
  });
  if (options.cursor !== undefined && options.cursor.length > 0) query.set("cursor", options.cursor);
  const response = await fetcher(`${ASSET_ORIGIN}${LEDGER_PATH}?${query.toString()}`, {
    method: "GET",
    headers: { accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Credential invalid or expired.");
  }
  if (!response.ok) throw new Error(`Ledger read failed (HTTP ${response.status}).`);
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const data = asRecord(body?.["data"]);
  const raw = Array.isArray(data?.["entries"]) ? (data!["entries"] as unknown[]) : [];
  const entries: AutoClawLedgerEntry[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (row === null) continue;
    const id = asText(row["id"]) ?? (asNumber(row["id"]) === null ? null : String(row["id"]));
    const amount = asNumber(row["amount"]);
    if (id === null || amount === null) continue;
    entries.push({
      id,
      amount,
      description: asText(row["description"]) ?? asText(row["reason"]) ?? "",
      occurredAt: asText(row["occurred_at"]) ?? asText(row["created_at"]) ?? "",
      walletScope: asText(row["wallet_scope"]),
      direction: amount < 0 || row["mutation_type"] === "debit" ? "debit" : "credit",
      walletExpiresAt: asNumber(row["wallet_expires_at"]),
    });
  }
  return { entries, nextCursor: asText(data?.["next_page_token"]) };
}

/**
 * Reports that this account is active, which is what the campaign engine reads.
 *
 * Best-effort by design: a refused report must never turn a working account into
 * a failing one, so every outcome is swallowed and the caller learns nothing
 * from it. `send_task` is the only event the shipped client posts.
 */
export async function reportAutoClawActivity(
  credential: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const token = normalizeToken(credential);
  if (token.length === 0) return false;
  try {
    const response = await fetcher(`${ASSET_ORIGIN}${WEB_EVENT_PATH}`, {
      method: "POST",
      headers: {
        ...autoClawAppHeaders(),
        "content-type": "application/json",
        accept: "*/*",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ event_type: "send_task" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return asNumber(body?.["code"]) === 0;
  } catch {
    return false;
  }
}

/** Strips a `Bearer ` prefix and unwraps the stored `{accessToken}` envelope. */
function normalizeToken(credential: string): string {
  const raw = credential.trim();
  let token = raw;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed["accessToken"] ?? parsed["token"];
      if (typeof value === "string") token = value.trim();
    } catch {
      // Malformed envelopes fall through to the raw string.
    }
  }
  return token.replace(/^Bearer\s+/i, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** One bucket of the expiry summary: entries sharing an expiry day. */
export interface AutoClawExpiringBucket {
  /** The wallet-scope expiry date, `YYYY-MM-DD` in UTC. */
  readonly expiresOn: string;
  /** Epoch seconds of the (max) expiry in this bucket. */
  readonly expiresAt: number;
  /** Sum of the credit grants still attributable to this expiry. */
  readonly points: number;
  /** The grants themselves, newest first. */
  readonly entries: readonly AutoClawLedgerEntry[];
}

/** The expiry summary for one account: lapsed points and the soon-to-lapse ones. */
export interface AutoClawExpirySummary {
  /** Grants whose expiry already passed, newest first. */
  readonly expired: readonly AutoClawExpiringBucket[];
  /** Live grants expiring within `withinDays`, soonest first. */
  readonly expiringSoon: readonly AutoClawExpiringBucket[];
  /** Total credit points that already lapsed (sum over `expired`). */
  readonly expiredPoints: number;
  /** Total credit points lapsing within the window (sum over `expiringSoon`). */
  readonly expiringSoonPoints: number;
}

/**
 * Walks the ledger far enough back to cover every grant that could still be
 * described as "expired this month" or "expiring soon", and buckets the credit
 * grants by their wallet expiry.
 *
 * The ledger is newest-first and debits carry the same `wallet_expires_at` as
 * the wallet they spent from, so the balance attributable to one expiry day is
 * `sum(credits) - sum(debits)` across the entries sharing it — a debit can push
 * a bucket to zero, never negative, because a wallet cannot pay out more than
 * it was granted.
 *
 * Pages until the oldest entry is older than `lookbackDays` (default 45: past
 * the longest realistic daily-grant TTL) or the pages run out.
 */
export async function fetchAutoClawExpirySummary(
  credential: string,
  fetcher: typeof fetch = fetch,
  options: { readonly withinDays?: number; readonly lookbackDays?: number; readonly pageSize?: number } = {},
): Promise<AutoClawExpirySummary> {
  // The envelope's `wallet_expires_at` is epoch SECONDS; Date.now() is
  // milliseconds. Mixing them makes every future expiry read as already
  // lapsed (seconds are always below the millisecond clock), so `now` is
  // seconds for the rest of this function.
  const now = Math.floor(Date.now() / 1000);
  const lookbackCutoffMs = now - (options.lookbackDays ?? 45) * 86_400;
  const soonCutoffMs = now + (options.withinDays ?? 7) * 86_400;

  /** Per expiry-day: net points and the entries behind them. */
  const buckets = new Map<string, { expiresAt: number; points: number; entries: AutoClawLedgerEntry[] }>();
  let cursor: string | undefined;
  let oldestSeenMs = Number.POSITIVE_INFINITY;
  for (let page = 0; page < 12; page += 1) {
    const ledgerPage = await fetchAutoClawLedger(
      credential,
      { pageSize: options.pageSize ?? 100, ...(cursor !== undefined ? { cursor } : {}) },
      fetcher,
    );
    if (ledgerPage.entries.length === 0) break;
    for (const entry of ledgerPage.entries) {
      const occurred = Math.floor(Date.parse(entry.occurredAt) / 1000);
      if (Number.isFinite(occurred)) oldestSeenMs = Math.min(oldestSeenMs, occurred);
      if (entry.walletExpiresAt === null) continue;
      // A grant that was fully spent before lapsing is not "expired points":
      // net the debits into the same bucket, floored at zero at read time.
      const expiresOn = new Date(entry.walletExpiresAt * 1000).toISOString().slice(0, 10);
      let bucket = buckets.get(expiresOn);
      if (bucket === undefined || bucket.expiresAt < entry.walletExpiresAt) {
        const prior = bucket;
        bucket = { expiresAt: entry.walletExpiresAt, points: 0, entries: [] };
        buckets.set(expiresOn, bucket);
        if (prior !== undefined) {
          bucket.points = prior.points;
          bucket.entries = prior.entries;
        }
      }
      bucket.points += entry.amount;
      if (entry.direction === "credit") bucket.entries.push(entry);
    }
    if (ledgerPage.nextCursor === null || ledgerPage.nextCursor.length === 0) break;
    if (oldestSeenMs < lookbackCutoffMs) break;
    cursor = ledgerPage.nextCursor;
  }

  const expired: AutoClawExpiringBucket[] = [];
  const expiringSoon: AutoClawExpiringBucket[] = [];
  for (const bucket of buckets.values()) {
    // Net the debits: a wallet can lapse with points unspent, or drained to zero.
    if (bucket.points <= 0) continue;
    const netted: AutoClawExpiringBucket = {
      expiresOn: new Date(bucket.expiresAt * 1000).toISOString().slice(0, 10),
      expiresAt: bucket.expiresAt,
      points: bucket.points,
      entries: [...bucket.entries].sort((left, right) =>
        right.occurredAt.localeCompare(left.occurredAt),
      ),
    };
    if (bucket.expiresAt <= now) expired.push(netted);
    else if (bucket.expiresAt <= soonCutoffMs) expiringSoon.push(netted);
  }
  expired.sort((left, right) => right.expiresAt - left.expiresAt);
  expiringSoon.sort((left, right) => left.expiresAt - right.expiresAt);
  return {
    expired,
    expiringSoon,
    expiredPoints: expired.reduce((sum, b) => sum + b.points, 0),
    expiringSoonPoints: expiringSoon.reduce((sum, b) => sum + b.points, 0),
  };
}
