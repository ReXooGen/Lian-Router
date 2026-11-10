import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../quota/quota-contracts";
import { getJson, isoDate, number, percentWindow, record, text } from "../quota/quota-contracts";
import { resolveQoderVersion } from "../operations/client-versions";

/**
 * Qoder credit balance.
 *
 * The CLI's PAT is not what the account endpoints accept: `openapi.qoder.sh`
 * wants a short-lived job token minted from the PAT, and the plan/quota pair
 * only answers with one. The exchange is cached for the process because the
 * token lives 24 hours and a quota refresh never needs a fresh one.
 */
const QODER_OPENAPI = "https://openapi.qoder.sh";
const QODER_JOB_TOKEN_URL = `${QODER_OPENAPI}/api/v1/jobToken/exchange`;
const QODER_PLAN_URL = `${QODER_OPENAPI}/api/v2/user/plan`;
const QODER_QUOTA_URL = `${QODER_OPENAPI}/api/v2/quota/usage`;
const QODER_USERINFO_URL = `${QODER_OPENAPI}/api/v1/userinfo`;
const SOURCE = "qoder";

/** Cached job tokens keyed by PAT. */
const jobTokens = new Map<string, { token: string; expiresAt: number }>();

/**
 * Credit totals that name a plan.
 *
 * The plan endpoint reports paid tiers under one indistinguishable
 * `personal_professional` label; the only discriminator it exposes is the
 * quota size, so the display name is derived from that instead of pretending
 * the tier string is meaningful. A trial keeps the name the API gave it.
 */
const PLAN_NAME_BY_QUOTA: readonly (readonly [number, string])[] = [
  [20_000, "Ultra Plan"],
  [6_000, "Pro+ Plan"],
  [2_000, "Pro Plan"],
];

function qoderBaseHeaders(version: string): Record<string, string> {
  return {
    "user-agent": `qoder/${version}`,
    accept: "application/json",
    "x-request-id": crypto.randomUUID().toUpperCase(),
    "cosy-version": version,
    "cosy-clienttype": "5",
    "cosy-machineos": "x86_64_linux",
  };
}

async function qoderJobToken(pat: string, fetcher: FetchLike): Promise<string | null> {
  const cached = jobTokens.get(pat);
  if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const version = await resolveQoderVersion(fetcher as unknown as typeof fetch, AbortSignal.timeout(15_000));
  const body = await getJson(QODER_JOB_TOKEN_URL, qoderBaseHeaders(version), fetcher, { personal_token: pat });
  const rec = record(body);
  const token = text(rec?.["token"]) ?? text(rec?.["access_token"]) ?? text(rec?.["device_token"]);
  if (token === null) return null;
  // `expires_in` is reported in milliseconds by this endpoint; reading it as
  // seconds would pin a stale token for years.
  const expiresIn = number(rec?.["expires_in"]);
  const ttlMs = expiresIn === null ? 23 * 60 * 60 * 1000 : expiresIn > 7 * 24 * 3600 ? expiresIn : expiresIn * 1000;
  jobTokens.set(pat, { token, expiresAt: Date.now() + ttlMs });
  return token;
}

function qoderPlanName(tier: string, name: string, total: number | null): string | null {
  if (tier.toLowerCase().includes("trial")) return name.length > 0 ? name : null;
  if (total !== null && total > 0) {
    for (const [threshold, label] of PLAN_NAME_BY_QUOTA) {
      if (total >= threshold) return label;
    }
  }
  return name.length > 0 ? name : null;
}

/**
 * Parses the quota payload into one credit window.
 *
 * `userQuota` is the account's own balance; the endpoint also reports an
 * account-wide `totalUsagePercentage` that is not a per-plan figure, so the
 * window is built from the balance and the percentage is used only when the
 * balance is absent.
 */
function parseQoderQuota(quota: unknown, plan: unknown): ProviderQuotaResult {
  const quotaRoot = record(quota) ?? {};
  const userQuota = record(quotaRoot["userQuota"]) ?? {};
  const planRoot = record(plan) ?? {};
  const total = number(userQuota["total"]);
  const used = number(userQuota["used"]);
  // The endpoint reports both a balance and a percentage; the window is built
  // from whichever it actually answered, so a missing `used` still renders.
  const percent = number(userQuota["percentage"]) ?? number(quotaRoot["totalUsagePercentage"]);
  const usedPercent =
    percent ?? (total !== null && total > 0 && used !== null ? (used / total) * 100 : null);
  const unit = text(userQuota["unit"]) ?? text(quotaRoot["usageType"]) ?? "credits";
  const tier = text(planRoot["user_type"]) ?? text(quotaRoot["userType"]) ?? "";
  const planName = qoderPlanName(
    tier,
    text(planRoot["plan_tier_name"]) ?? text(planRoot["plan_tier"]) ?? "",
    total,
  );
  const windows: ProviderQuotaWindow[] =
    usedPercent === null
      ? []
      : [
          percentWindow(
            "credits",
            `${unit.charAt(0).toUpperCase()}${unit.slice(1)}`,
            usedPercent,
            isoDate(quotaRoot["expiresAt"] ?? planRoot["end_date"]),
            used,
            total,
          ),
        ];
  return {
    source: SOURCE,
    plan: planName,
    windows,
    // An exhausted plan is a successful read, not a failed one: the window
    // carries the verdict and the account page must show it as data.
    error: null,
  };
}

/**
 * Fetches the account's plan and credit balance.
 *
 * Both endpoints are read because neither alone answers the page: `/plan`
 * names the tier and its end date, `/quota` carries the balance. A plan read
 * that fails while the quota read succeeds still yields a usable result, so
 * the calls are independent and only a total failure throws.
 */
export async function fetchQoderQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const pat = credential.trim();
  if (pat.length === 0) throw new Error("Qoder credential is empty.");
  const token = await qoderJobToken(pat, fetcher);
  if (token === null) throw new Error("Qoder job token exchange failed.");
  const headers = { ...qoderBaseHeaders(await resolveQoderVersion(fetcher as unknown as typeof fetch, AbortSignal.timeout(15_000))), authorization: `Bearer ${token}` };
  const quota = await getJson(QODER_QUOTA_URL, headers, fetcher);
  let plan: unknown = null;
  try {
    plan = await getJson(QODER_PLAN_URL, headers, fetcher);
  } catch {
    // The tier name is decoration; the balance is the answer.
  }
  return parseQoderQuota(quota, plan);
}

/**
 * The Qoder profile name behind a PAT, used as an account label.
 *
 * The CLI shows this instead of the email, and it is the only identity field
 * `userinfo` guarantees for an SSO account.
 */
export async function fetchQoderAccountName(
  credential: string,
  fetcher: FetchLike,
): Promise<string | null> {
  const pat = credential.trim();
  if (pat.length === 0) return null;
  const token = await qoderJobToken(pat, fetcher);
  if (token === null) return null;
  const headers = { ...qoderBaseHeaders(await resolveQoderVersion(fetcher as unknown as typeof fetch, AbortSignal.timeout(15_000))), authorization: `Bearer ${token}` };
  const info = record(await getJson(QODER_USERINFO_URL, headers, fetcher));
  return text(info?.["name"]) ?? text(info?.["username"]) ?? text(info?.["email"]);
}
