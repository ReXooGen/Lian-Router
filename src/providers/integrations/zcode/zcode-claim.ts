/**
 * ZCode plan-claim campaigns.
 *
 * A start-plan account can hold time-boxed campaigns ("weekend build", trial
 * grants) that are claimed rather than bought. Two surfaces advertise them and
 * neither is authoritative on its own:
 *
 *  - `billing/preview` answers the campaigns the account is eligible for.
 *  - `marketing/touch` carries banner/popup deliveries whose buttons name a
 *    `claim_zcode_plan` action with a `plan_id`; the campaign's metadata rides
 *    in the same delivery as a `zcode_plan` object.
 *
 * Claiming posts one `plan_id` to `billing/claim`. That endpoint is
 * captcha-gated for the campaigns that matter: a request without a solved
 * challenge answers `400 {"code":3007,"msg":"captcha verify failed"}` — verified
 * live. The gate is reported as its own outcome rather than folded into a
 * generic failure, because the operator's next step is different: finish the
 * claim in the desktop app, not retry here.
 */
import type { FetchLike } from "../../quota/quota-contracts";
import { getJsonWithRateLimitRetry, number, record, text } from "../../quota/quota-contracts";
import { zcodeDeviceId } from "./spec";
import { zcodePlanToken } from "./zcode-oauth";
import { ZCODE_ANTHROPIC_VERSION, ZCODE_CAMPAIGN_APP_VERSION } from "./identity";

const ZCODE_ORIGIN = "https://zcode.z.ai";
const PREVIEW_PATH = "/api/v1/zcode-plan/billing/preview";
const TOUCH_PATH = "/api/v1/marketing/touch?seq=0";
const CLAIM_PATH = "/api/v1/zcode-plan/billing/claim";

/** Campaign code meaning "the operator must solve a captcha elsewhere". */
const CAPTCHA_REJECTED_CODE = 3007;

const CONFIGS_PATH = "/api/v1/client/configs";

/**
 * The Aliyun captcha the claim endpoint demands, as the client app reads it.
 *
 * The desktop app does not solve this challenge itself: it loads the Aliyun SDK
 * with these values, a human completes the puzzle, and the resulting token goes
 * back as a header on the claim. Serving the same config lets the dashboard run
 * the same widget, which is the difference between a campaign the operator can
 * claim and a dead end that says "use the desktop app".
 */
export interface ZcodeClaimVerificationConfig {
  readonly enabled: boolean;
  readonly region: string;
  readonly prefix: string;
  readonly sceneId: string;
  readonly skipModelRequest: boolean;
}

/** How a solved challenge travels back to the claim endpoint. */
export interface ZcodeClaimVerification {
  readonly param: string;
  readonly region: string;
}

/** One claimable campaign. */
export interface ZcodeClaimPlan {
  readonly planId: string;
  readonly name: string;
  /** Higher wins when several campaigns are live at once. */
  readonly priority: number | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** Which surface advertised it: `preview` (billing) or `banner` (marketing). */
  readonly source: "preview" | "banner";
}

/** Why a claim did not grant a plan. */
export type ZcodeClaimOutcome =
  | { readonly kind: "claimed"; readonly planId: string; readonly startsAt: string | null; readonly endsAt: string | null }
  | { readonly kind: "captcha_required"; readonly planId: string; readonly message: string }
  /** The vendor throttled the claim; the campaign may still be claimable shortly. */
  | { readonly kind: "rate_limited"; readonly planId: string; readonly message: string }
  | { readonly kind: "rejected"; readonly planId: string; readonly code: number | null; readonly message: string };

/** The campaign surfaces for one account. */
export interface ZcodeClaimListing {
  readonly plans: readonly ZcodeClaimPlan[];
  /** Non-fatal read failures, newest surface first. */
  readonly errors: readonly string[];
}

function controlHeaders(jwt: string, json: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${jwt}`,
    accept: "application/json",
    ...(json ? { "content-type": "application/json" } : {}),
    "http-referer": "https://zcode.z.ai",
    "user-agent": `ZCode/${ZCODE_CAMPAIGN_APP_VERSION}`,
    "x-title": "Z Code@electron",
    "x-release-channel": "production",
    "x-zcode-app-version": ZCODE_CAMPAIGN_APP_VERSION,
    "x-platform": `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
    "x-os-category":
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    "anthropic-version": ZCODE_ANTHROPIC_VERSION,
    "x-device-mid": zcodeDeviceId(jwt),
  };
}

/** Seconds-or-milliseconds epoch to ISO, or `null` when absent. */
function epochIso(value: unknown): string | null {
  const seconds = number(value);
  if (seconds === null || seconds <= 0) return null;
  return new Date(seconds > 1_000_000_000_000 ? seconds : seconds * 1000).toISOString();
}

/** Reads one campaign out of a plan-shaped object. */
function parsePlan(value: unknown, source: ZcodeClaimPlan["source"]): ZcodeClaimPlan | null {
  const plan = record(value);
  if (plan === null) return null;
  const planId = text(plan["plan_id"]);
  if (planId === null) return null;
  return {
    planId,
    name: text(plan["name"]) ?? planId,
    priority: number(plan["priority"]),
    startsAt: epochIso(plan["starts_at"]),
    endsAt: epochIso(plan["ends_at"]),
    source,
  };
}

/**
 * Walks a delivery tree collecting every `zcode_plan` object and every
 * `claim_zcode_plan` button.
 *
 * The tree is untrusted and arbitrarily nested, so the walk is depth-bounded
 * and defensive: a delivery that nests five levels deep is still read, and one
 * that nests fifty is not walked forever.
 */
function collectFromDelivery(delivery: unknown): readonly ZcodeClaimPlan[] {
  const plansById = new Map<string, ZcodeClaimPlan>();
  const buttonIds: string[] = [];

  const collectPlans = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) collectPlans(item, depth + 1);
      return;
    }
    const recordNode = node as Record<string, unknown>;
    const plan = record(recordNode["zcode_plan"]);
    if (plan !== null) {
      const parsed = parsePlan(plan, "banner");
      if (parsed !== null && !plansById.has(parsed.planId)) plansById.set(parsed.planId, parsed);
    }
    for (const child of Object.values(recordNode)) collectPlans(child, depth + 1);
  };

  const collectButtons = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) collectButtons(item, depth + 1);
      return;
    }
    const recordNode = node as Record<string, unknown>;
    const action = record(recordNode["action"]);
    if (action !== null && text(action["type"]) === "claim_zcode_plan") {
      const args = record(action["args"]);
      const planId = args === null ? null : text(args["plan_id"]);
      if (planId !== null) buttonIds.push(planId);
    }
    for (const child of Object.values(recordNode)) collectButtons(child, depth + 1);
  };

  collectPlans(delivery, 0);
  collectButtons(delivery, 0);

  // A button naming a campaign with no metadata still names a real campaign.
  for (const planId of buttonIds) {
    if (!plansById.has(planId)) {
      plansById.set(planId, {
        planId,
        name: planId,
        priority: null,
        startsAt: null,
        endsAt: null,
        source: "banner",
      });
    }
  }
  return [...plansById.values()];
}

/**
 * Lists the campaigns this account can claim.
 *
 * Both surfaces are read independently: a preview that answers nothing does not
 * hide a banner campaign, and a marketing read that fails does not discard the
 * preview list. Read failures ride along as `errors` so the operator sees why a
 * list is short instead of assuming there is nothing to claim.
 */
export async function listZcodeClaims(
  credential: string,
  fetcher: FetchLike,
): Promise<ZcodeClaimListing> {
  if (credential.trim().length === 0) throw new Error("ZCode credential is empty.");
  const jwt = zcodePlanToken(credential);
  if (jwt.length === 0) throw new Error("ZCode credential carries no plan token.");
  const errors: string[] = [];
  const byId = new Map<string, ZcodeClaimPlan>();

  try {
    const preview = record(
      await getJsonWithRateLimitRetry(
        `${ZCODE_ORIGIN}${PREVIEW_PATH}?app_version=${encodeURIComponent(ZCODE_CAMPAIGN_APP_VERSION)}&platform=${encodeURIComponent(`${process.platform}-${process.arch}`)}`,
        controlHeaders(jwt, false),
        fetcher,
      ),
    );
    const data = record(preview?.["data"]);
    const plans = data?.["plans"];
    if (Array.isArray(plans)) {
      for (const entry of plans) {
        const parsed = parsePlan(entry, "preview");
        if (parsed !== null && !byId.has(parsed.planId)) byId.set(parsed.planId, parsed);
      }
    }
  } catch (error) {
    errors.push(`preview: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const touch = record(await getJsonWithRateLimitRetry(`${ZCODE_ORIGIN}${TOUCH_PATH}`, controlHeaders(jwt, false), fetcher));
    const deliveries = record(touch?.["data"])?.["deliveries"];
    if (Array.isArray(deliveries)) {
      for (const delivery of deliveries) {
        for (const plan of collectFromDelivery(delivery)) {
          if (!byId.has(plan.planId)) byId.set(plan.planId, plan);
        }
      }
    }
  } catch (error) {
    errors.push(`marketing: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Highest priority first; campaigns without a priority sort after the ones
  // that declare one, because a declared priority is the vendor ranking them.
  const plans = [...byId.values()].sort((left, right) => (right.priority ?? -1) - (left.priority ?? -1));
  return { plans, errors };
}

/**
 * Reads the Aliyun captcha the claim endpoint expects for this account.
 *
 * The values come from the client config surface, the same object the desktop
 * app reads: without them the dashboard cannot render the challenge, and the
 * only path left is telling the operator to finish in another application.
 * `enabled: false` is a real answer — the vendor switches the gate off for some
 * campaigns — so it is returned rather than raised.
 */
export async function fetchZcodeClaimVerificationConfig(
  credential: string,
  fetcher: FetchLike,
): Promise<ZcodeClaimVerificationConfig> {
  if (credential.trim().length === 0) throw new Error("ZCode credential is empty.");
  const jwt = zcodePlanToken(credential);
  if (jwt.length === 0) throw new Error("ZCode credential carries no plan token.");
  const headers = controlHeaders(jwt, false);
  // The config surface is language-gated: without this it answers the generic
  // bundle and the captcha object comes back absent.
  headers["x-client-language"] = "zh-CN";
  headers["user-agent"] = `zcode/${ZCODE_CAMPAIGN_APP_VERSION}`;
  const url =
    `${ZCODE_ORIGIN}${CONFIGS_PATH}?app_version=${encodeURIComponent(ZCODE_CAMPAIGN_APP_VERSION)}` +
    `&platform=${encodeURIComponent(`${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`)}`;
  const body = record(await getJsonWithRateLimitRetry(url, headers, fetcher));
  const code = number(body?.["code"]);
  if (code !== null && code !== 0) {
    throw new Error(`captcha config: ${text(body?.["msg"]) ?? `code ${code}`}`);
  }
  const captcha = record(record(record(body?.["data"])?.["configs"])?.["captcha"]) ?? {};
  return {
    // An absent object is not an enabled gate; reading it as one would render a
    // widget for a challenge the vendor is not asking for.
    enabled: captcha["enabled"] === true,
    region: text(captcha["region"]) ?? "",
    prefix: text(captcha["prefix"]) ?? "",
    sceneId: text(captcha["sceneId"]) ?? text(captcha["scene_id"]) ?? "",
    skipModelRequest: captcha["skip_model_request"] === true,
  };
}

/**
 * Claims one campaign.
 *
 * A captcha rejection is its own outcome: the campaign is real, the credential
 * is valid, and the caller needs a solved challenge rather than a retry.
 */
export async function claimZcodePlan(
  credential: string,
  planId: string,
  fetcher: FetchLike,
  verification?: ZcodeClaimVerification,
): Promise<ZcodeClaimOutcome> {
  if (credential.trim().length === 0) throw new Error("ZCode credential is empty.");
  const jwt = zcodePlanToken(credential);
  if (jwt.length === 0) throw new Error("ZCode credential carries no plan token.");
  const trimmed = planId.trim();
  if (trimmed.length === 0) throw new Error("A plan id is required to claim.");
  const headers = controlHeaders(jwt, true);
  // A solved challenge travels back as its own header pair. The gateway rejects
  // an empty value outright, which would turn a solved challenge into a generic
  // 400, so the pair is only attached when there is a token to send.
  const verifyParam = verification?.param.trim() ?? "";
  if (verifyParam.length > 0) {
    headers["x-aliyun-captcha-verify-param"] = verifyParam;
    const verifyRegion = verification?.region.trim() ?? "";
    if (verifyRegion.length > 0) headers["x-aliyun-captcha-verify-region"] = verifyRegion;
  }
  const response = await fetcher(`${ZCODE_ORIGIN}${CLAIM_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ plan_id: trimmed }),
    signal: AbortSignal.timeout(20_000),
  });
  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw.length > 0 ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  const envelope = record(payload);
  const code = number(envelope?.["code"]);
  const message = text(envelope?.["msg"]) ?? (raw.length > 0 ? raw.slice(0, 200) : `HTTP ${response.status}`);
  if (code === CAPTCHA_REJECTED_CODE) return { kind: "captcha_required", planId: trimmed, message };
  // A throttle is its own answer: the campaign is live and the request was
  // well-formed, so "rejected" would tell the operator the plan is unavailable
  // when the only problem is timing. It is checked before the generic failure
  // branch because the vendor answers a bare `HTTP 429` body as often as a code.
  if (response.status === 429) return { kind: "rate_limited", planId: trimmed, message };
  if (!response.ok || (code !== null && code !== 0)) {
    return { kind: "rejected", planId: trimmed, code, message };
  }
  const plan = record(record(envelope?.["data"])?.["plan"]);
  return {
    kind: "claimed",
    planId: trimmed,
    startsAt: epochIso(plan?.["starts_at"]),
    endsAt: epochIso(plan?.["ends_at"]),
  };
}
