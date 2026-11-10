/**
 * ZCode start-plan grant readout.
 *
 * The plan lane meters per entitlement ("grant units"), not per token, so the
 * quota page is not a percentage of one budget: an account can hold several
 * entitlements at once (a weekend campaign and a start plan both granting the
 * flash model, for example) and each reports its own total/used/remaining
 * window.
 *
 * Two endpoints answer, and they are not interchangeable:
 *
 *  - `billing/balance` is the panel readout — plan definitions *and* usage with
 *    the daily window. It requires a UUID `X-Device-Mid` header or answers
 *    `3001 parameter error`.
 *  - `billing/current` carries plan definitions only, and must be sent with
 *    bare auth: the control headers that `balance` needs empty its payload.
 *
 * The device id is derived from the credential by the adapter, so both reads
 * present the same device the inference calls do.
 */
import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import {
  cleanError,
  getJsonWithRateLimitRetry,
  isoDate,
  number,
  record,
  text,
} from "../../quota/quota-contracts";
import { zcodeDeviceId } from "./spec";
import { zcodePlanToken } from "./zcode-oauth";
import { ZCODE_ANTHROPIC_VERSION, ZCODE_CAMPAIGN_APP_VERSION } from "./identity";

const ZCODE_ORIGIN = "https://zcode.z.ai";
const BALANCE_PATH = "/api/v1/zcode-plan/billing/balance";
const CURRENT_PATH = "/api/v1/zcode-plan/billing/current";
const SOURCE = "zcode";

/** Non-zero envelope codes are failures even on HTTP 200. */
function envelopeCode(value: unknown): number | null {
  const code = number(value);
  return code === null || code === 0 ? null : code;
}

/**
 * Names the envelope code alongside its message.
 *
 * The code is what an operator acts on (3012 is a prompt-shape rejection, 3001
 * a missing device id, 1113 a spent grant), and the message alone does not
 * identify it: the gateway reuses generic prose across codes.
 */
function envelopeMessage(body: Record<string, unknown> | null, code: number): string {
  const message = text(body?.["msg"]);
  return message === null ? `code ${code}` : `code ${code} (${message})`;
}

/**
 * The client identity face for control calls: the inference face plus
 * `x-device-mid`. Header values are gated to printable ASCII because the
 * gateway rejects anything else outright.
 */
function controlHeaders(jwt: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${jwt}`,
    accept: "application/json",
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
  return headers;
}

/** One entitlement row after the two endpoints are merged. */
interface GrantRow {
  readonly entitlementId: string;
  readonly label: string;
  readonly models: readonly string[];
  readonly planName: string | null;
  readonly totalUnits: number | null;
  readonly usedUnits: number | null;
  readonly remainingUnits: number | null;
  readonly periodEnd: string | null;
  readonly unitType: string | null;
  /**
   * Instant the grant becomes spendable. Non-null and in the future means the
   * campaign is granted but pending; `null` means nothing is scheduled.
   */
  readonly availableAt: string | null;
}

/** `capabilities` carries `model:<id>` entries; the grant applies to those. */
function capabilityModels(row: Record<string, unknown>): readonly string[] {
  const capabilities = row["capabilities"];
  if (!Array.isArray(capabilities)) return [];
  const models: string[] = [];
  for (const entry of capabilities) {
    const value = text(entry);
    if (value !== null && value.startsWith("model:")) models.push(value.slice("model:".length));
  }
  return models;
}

/**
 * Merges plan definitions with the usage rows.
 *
 * An entitlement that appears in the plan list but not in the usage list still
 * shows its grant: the plan exists and the caller should see it, even on a day
 * it has not been touched.
 */
function mergeGrants(plans: readonly unknown[], balances: readonly unknown[]): readonly GrantRow[] {
  interface EntitlementMeta {
    readonly planName: string | null;
    readonly entitlement: Record<string, unknown>;
  }
  const metaById = new Map<string, EntitlementMeta>();
  for (const planEntry of plans) {
    const plan = record(planEntry);
    if (plan === null) continue;
    const entitlements = plan["entitlements"];
    if (!Array.isArray(entitlements)) continue;
    for (const entitlementEntry of entitlements) {
      const entitlement = record(entitlementEntry);
      if (entitlement === null) continue;
      const id = text(entitlement["entitlement_id"]);
      if (id === null) continue;
      metaById.set(id, { planName: text(plan["name"]), entitlement });
    }
  }

  const rows: GrantRow[] = [];
  const seen = new Set<string>();
  for (const balanceEntry of balances) {
    const balance = record(balanceEntry);
    if (balance === null) continue;
    const id = text(balance["entitlement_id"]) ?? "";
    seen.add(id);
    const meta = metaById.get(id);
    rows.push({
      entitlementId: id,
      label:
        text(balance["show_name"]) ??
        (meta === undefined ? null : text(meta.entitlement["show_name"])) ??
        id,
      models:
        capabilityModels(balance).length > 0
          ? capabilityModels(balance)
          : meta === undefined
            ? []
            : capabilityModels(meta.entitlement),
      planName: meta?.planName ?? null,
      totalUnits: number(balance["total_units"]) ?? (meta ? number(meta.entitlement["grant_units"]) : null),
      usedUnits: number(balance["used_units"]),
      remainingUnits: number(balance["remaining_units"]),
      periodEnd: isoDate(balance["period_end"]),
      unitType: text(balance["unit_type"]) ?? (meta ? text(meta.entitlement["unit_type"]) : null),
      // The balance row can carry its own start; the definition is the fallback
      // because a pending grant often has no balance row at all.
      availableAt:
        isoDate(balance["effective_at"]) ?? (meta ? isoDate(meta.entitlement["effective_at"]) : null),
    });
  }
  for (const [id, meta] of metaById) {
    if (seen.has(id)) continue;
    rows.push({
      entitlementId: id,
      label: text(meta.entitlement["show_name"]) ?? id,
      models: capabilityModels(meta.entitlement),
      planName: meta.planName,
      totalUnits: number(meta.entitlement["grant_units"]),
      usedUnits: null,
      remainingUnits: null,
      periodEnd: null,
      unitType: text(meta.entitlement["unit_type"]),
      availableAt: isoDate(meta.entitlement["effective_at"]),
    });
  }
  return rows;
}

/**
 * The one plan name that best summarises the account: the plan holding the
 * most grant rows, with ties going to the first declared plan.
 *
 * An account's label is a summary, so it has to name exactly one plan. Picking
 * the plan with the most grants keeps the label on the account's primary
 * entitlement; the other plans are still fully visible on their own, because
 * every window carries its owning plan in `group`.
 */
function dominantPlanName(rows: readonly GrantRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.planName === null) continue;
    counts.set(row.planName, (counts.get(row.planName) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Turns grant rows into quota windows.
 *
 * The percentage is derived from used/total when both are present. A row that
 * reports only a remaining figure still renders: the window keeps a null
 * percentage and carries the absolute numbers, which is what the page shows for
 * a grant whose unit is not a token count.
 */
function grantWindows(rows: readonly GrantRow[]): readonly ProviderQuotaWindow[] {
  return rows.map((row) => {
    const usedPercent =
      row.totalUnits !== null && row.totalUnits > 0 && row.usedUnits !== null
        ? Math.min(100, Math.max(0, (row.usedUnits / row.totalUnits) * 100))
        : null;
    const models = row.models.length > 0 ? ` · ${row.models.join(", ")}` : "";
    return {
      kind: "grant",
      label: `${row.label}${models}`,
      usedPercent,
      remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      resetsAt: row.periodEnd,
      used: row.usedUnits,
      limit: row.totalUnits,
      group: row.planName,
      availableAt: row.availableAt,
    };
  });
}

/**
 * Reads the plan grants for one account.
 *
 * `balance` answers the panel readout; `current` is the definition-only
 * fallback and is sent with bare auth because the control face empties it. A
 * failure of both throws so the account page shows a real error instead of an
 * empty quota.
 */
export async function fetchZcodeQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  if (credential.trim().length === 0) throw new Error("ZCode credential is empty.");
  // The stored credential is either a bare plan JWT or the OAuth JSON envelope.
  const jwt = zcodePlanToken(credential);
  if (jwt.length === 0) throw new Error("ZCode credential carries no plan token.");
  const deviceId = zcodeDeviceId(jwt);
  const errors: string[] = [];
  let plans: readonly unknown[] = [];
  let balances: readonly unknown[] = [];

  try {
    const body = record(
      await getJsonWithRateLimitRetry(
        `${ZCODE_ORIGIN}${BALANCE_PATH}?app_version=${encodeURIComponent(ZCODE_CAMPAIGN_APP_VERSION)}&platform=${encodeURIComponent(`${process.platform}-${process.arch}`)}`,
        controlHeaders(jwt),
        fetcher,
      ),
    );
    const code = envelopeCode(body?.["code"]);
    if (code !== null) {
      errors.push(`balance: ${envelopeMessage(body, code)}`);
    } else {
      const data = record(body?.["data"]) ?? {};
      if (Array.isArray(data["plans"])) plans = data["plans"];
      if (Array.isArray(data["balances"])) balances = data["balances"];
    }
  } catch (error) {
    errors.push(`balance: ${cleanError(error)}`);
  }

  if (plans.length === 0) {
    try {
      // Bare auth: the control headers empty this endpoint's payload.
      const body = record(
        await getJsonWithRateLimitRetry(
          `${ZCODE_ORIGIN}${CURRENT_PATH}`,
          { authorization: `Bearer ${jwt}`, accept: "application/json" },
          fetcher,
        ),
      );
      const code = envelopeCode(body?.["code"]);
      if (code !== null) {
        errors.push(`current: ${envelopeMessage(body, code)}`);
      } else {
        const data = record(body?.["data"]) ?? {};
        if (Array.isArray(data["plans"])) plans = data["plans"];
      }
    } catch (error) {
      errors.push(`current: ${cleanError(error)}`);
    }
  }

  const rows = mergeGrants(plans, balances);
  if (rows.length === 0) {
    // "No grants" is only an answer when an endpoint actually answered. A
    // read that failed — a 429 from the vendor's rate limiter, a timeout, a
    // non-zero envelope — says nothing about the account's plans, and
    // reporting it as an empty plan set told the operator an account with a
    // live plan had none.
    return {
      source: SOURCE,
      plan: null,
      windows: [],
      error:
        errors.length > 0
          ? errors.join("; ").slice(0, 240)
          : "This account has no plan grants (device mid " + deviceId.slice(0, 8) + "…).",
    };
  }
  // An account can hold several plans at once (a referral grant alongside a
  // start plan), and each one carries its own entitlement rows. The result
  // keeps one name here — the plan with the most grants — because this field
  // is the account's summary label, not the list. Joining every name into
  // "A + B" read as one plan called "A + B" and hid the fact that the account
  // holds two entitlements; the per-plan split lives in each window's `group`,
  // which is what the quota page and the claim card render as separate plans.
  const planName = dominantPlanName(rows) ?? "ZCode";
  return {
    source: SOURCE,
    plan: planName,
    windows: grantWindows(rows),
    // A partially-read account still reports its grants; the read errors ride
    // along so the page can show that one endpoint failed without hiding the
    // numbers that did arrive.
    error: errors.length > 0 ? errors.join("; ").slice(0, 240) : null,
  };
}
