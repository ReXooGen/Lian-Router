// Upstream appeal sender: one POST per account, sequential with a fixed gap.
//
// Endpoint and headers are the proven-against-live-upstream shape: the billing
// web facade (`www.codebuddy.ai` for intl cb, `copilot.tencent.com` for cbcn,
// `www.workbuddy.ai` for workbuddy), `Authorization: Bearer <oauth jwt>`,
// `x-user-id` from the JWT `sub`, `x-domain` the product domain, browser UA —
// and a multipart form whose single `content` field carries the message.
// Response `{"code":0,…,"data":{"feedback_id":N}}` is the acknowledgement.
//
// This mirrors `checkinHeaders` on purpose and does not reuse it: that builder
// is async (version resolution) and shapes CLI/IDE identity headers, while the
// feedback endpoint answers the *web* identity. Divergence here is intentional;
// a shared builder would couple two risk-gated surfaces.

import { providerBaseUrl } from "../../../providers/provider-metadata";
import { buddyAccountUid } from "../../../providers/integrations/buddy/buddy-oauth-shared";
import { decodeJwtPayload } from "../../../providers/authentication/oauth-flow-store";
import type { AppealSendResult } from "./contracts";
import { APPEAL_DEFAULT_MESSAGE } from "./sender-config";

/** Fixed per-request budget; a hanging appeal must not stall a batch. */
export function appealTimeoutMs(): number {
  return 15_000;
}

/** Decoded JWT claims, exposed for tests asserting uid extraction. */
export function appealJwtClaims(credential: string): Record<string, unknown> | undefined {
  return decodeJwtPayload(credential);
}

/** Product domain each buddy provider's feedback endpoint expects in `x-domain`. */
const APPEAL_DOMAIN: Readonly<Record<string, string>> = {
  cb: "www.codebuddy.ai",
  cbcn: "copilot.tencent.com",
  workbuddy: "www.workbuddy.ai",
};

/** Gap between two upstream posts inside one batch pass. */
export const APPEAL_SEQUENTIAL_GAP_MS = 250;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

export function defaultAppealMessage(label: string): string {
  return APPEAL_DEFAULT_MESSAGE.replace("{label}", label);
}

/** Reads the account uid from a buddy OAuth JWT; `undefined` for opaque keys. */
export function appealAccountUid(credential: string): string | undefined {
  return buddyAccountUid(credential);
}

function envelopeCode(payload: unknown): number | null {
  if (payload === null || typeof payload !== "object" || !("code" in payload)) return null;
  const code = payload.code;
  return typeof code === "number" ? code : null;
}

function feedbackIdOf(payload: unknown): number | null {
  if (payload === null || typeof payload !== "object" || !("data" in payload)) return null;
  const data = payload.data;
  if (data === null || typeof data !== "object" || !("feedback_id" in data)) return null;
  const id = data.feedback_id;
  if (typeof id === "number" && Number.isFinite(id)) return Math.trunc(id);
  // Coerce numeric strings: the upstream has answered both shapes historically.
  if (typeof id === "string" && id.trim() !== "" && Number.isFinite(Number(id))) {
    return Math.trunc(Number(id));
  }
  return null;
}

function messageOf(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const message =
    "message" in payload ? payload.message : "msg" in payload ? payload.msg : undefined;
  return typeof message === "string" ? message.slice(0, 300) : "";
}

/**
 * Sends one appeal under the account's own credential and returns the outcome.
 * Never throws: every failure path is a recorded `error` result, because one
 * dead account must not abort a batch behind it.
 */
export async function sendAppealForAccount(args: {
  readonly providerId: string;
  readonly accountId: string;
  readonly label: string;
  readonly credential: string;
  readonly message: string;
  readonly fetcher: typeof fetch;
}): Promise<AppealSendResult> {
  const base = { accountId: args.accountId, label: args.label, feedbackId: null };
  const uid = appealAccountUid(args.credential);
  if (!uid) {
    return {
      ...base,
      state: "error",
      error: "Appeal needs an OAuth account (no uid in this credential).",
    };
  }
  const domain = APPEAL_DOMAIN[args.providerId];
  if (!domain) {
    return { ...base, state: "error", error: `Unsupported provider "${args.providerId}".` };
  }
  const url = `${providerBaseUrl(args.providerId).replace(/\/v2\/?$/, "")}/v2/feedback`;
  const headers = {
    accept: "application/json, text/plain, */*",
    "x-client-platform": "web",
    origin: new URL(url).origin,
    referer: `${new URL(url).origin}/app`,
    authorization: `Bearer ${args.credential}`,
    "x-user-id": uid,
    "x-domain": domain,
    "user-agent": BROWSER_UA,
  };
  let payload: unknown;
  try {
    const response = await args.fetcher(url, {
      method: "POST",
      headers,
      // The endpoint reads a multipart `content` field (proven shape), not JSON.
      body: (() => {
        const form = new FormData();
        form.append("content", args.message);
        return form;
      })(),
      signal: AbortSignal.timeout(appealTimeoutMs()),
    });
    if (response.status === 401) {
      return { ...base, state: "error", error: "Credential invalid or expired." };
    }
    const text = await response.text().catch(() => "");
    if (response.status === 403) {
      // The feedback endpoint itself can answer the ban verdict; surface the code.
      try {
        const parsed = text ? JSON.parse(text) : null;
        const code = envelopeCode(parsed);
        return {
          ...base,
          state: "error",
          error: code !== null ? `Upstream rejected the appeal (code ${code}).` : "Upstream refused (403).",
        };
      } catch {
        return { ...base, state: "error", error: "Upstream refused (403)." };
      }
    }
    if (!response.ok) {
      return { ...base, state: "error", error: `Appeal API error (${response.status}).` };
    }
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ...base, state: "error", error: "Appeal response returned invalid JSON." };
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return { ...base, state: "error", error: "Appeal request timed out." };
    }
    return {
      ...base,
      state: "error",
      error: error instanceof Error ? error.message : "Appeal request failed.",
    };
  }
  const code = envelopeCode(payload);
  if (code !== null && code !== 0) {
    return {
      ...base,
      state: "error",
      error: `Appeal error (code ${code})${messageOf(payload) ? `: ${messageOf(payload)}` : "."}`,
    };
  }
  const feedbackId = feedbackIdOf(payload);
  if (feedbackId === null) {
    // A 200 with no feedback_id did not demonstrably open a ticket; treat as error.
    return { ...base, state: "error", error: "Appeal response carried no feedback_id." };
  }
  return { ...base, state: "appealed", feedbackId, error: null };
}

