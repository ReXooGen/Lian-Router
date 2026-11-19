/**
 * AutoClaw token refresh: the vendor's own session-renewal lane.
 *
 * Discovery (measured live 2026-11-14): the gateway answers
 * `POST /userapi/v1/refresh` with `{refresh_token, source_id: 'autoclaw',
 * device_id}` — the same call the shipped desktop client makes from its
 * dashboard server — and returns a fresh `access_token` (+ optional rotated
 * `refresh_token`). `400002` ('middleware sign error') without the MD5 app
 * signature family, `code 0` with it. A datacenter origin is fine once the
 * signature travels: the middleware gate is IP-shaped, the refresh route
 * itself is not. `source_id` on the refresh JWT reads 'autoclawrefresh_token'.
 *
 * The refresh JWT lives ~30 days (exp - iat = 30d, measured on all six live
 * accounts), the access JWT 24h. LianRouter previously stored the pair and
 * never redeemed the refresh half, so every account died a day after login.
 * This module closes that: the registry wires it as the provider's refresher
 * so the existing proactive sweep and the 401 reactive retry both redeem it.
 */
import { createHash, randomUUID } from "crypto";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { AUTOCLAW_APP_ID, AUTOCLAW_APP_KEY, AUTOCLAW_CLIENT_VERSION } from "./spec";

/** The desktop client's own identity origin — the refresh lane lives there. */
const AUTOCLAW_REFRESH_ORIGIN = "https://autoglm-api.autoglm.ai";
const REFRESH_PATH = "/userapi/v1/refresh";
const AGENT_REFRESH_PATH = "/userapi/v1/agent-refresh";

/** Unwraps the stored credential envelope down to the raw refresh JWT. */
function refreshJwt(refreshToken: string): string {
  const trimmed = refreshToken.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const value = parsed["refreshToken"] ?? parsed["refresh_token"];
      if (typeof value === "string") return value.replace(/^Bearer\s+/i, "").trim();
    } catch {
      // A malformed envelope falls through to the raw string.
    }
  }
  return trimmed.replace(/^Bearer\s+/i, "").trim();
}

/**
 * Signed app headers — the same MD5 family every gateway route demands.
 * Without them the middleware answers 400002 before reading the payload;
 * this is a public constant of the shipped client, not a secret.
 */
function signedHeaders(): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    accept: "*/*",
    "content-type": "application/json",
    "user-agent": `AutoClaw/${AUTOCLAW_CLIENT_VERSION}`,
    "x-auth-appid": AUTOCLAW_APP_ID,
    "x-auth-timestamp": timestamp,
    "x-auth-sign": createHash("md5")
      .update(`${AUTOCLAW_APP_ID}&${timestamp}&${AUTOCLAW_APP_KEY}`)
      .digest("hex"),
    "x-tm": process.platform === "win32" ? "win" : "linux",
    "x-product": "autoclaw",
    "x-channel": "official",
    "x-lang": "en",
    "x-client-type": "pc",
    "x-trace-id": randomUUID(),
  };
}

interface RefreshResponse {
  readonly code: number;
  readonly msg?: string;
  readonly data?: { readonly access_token?: unknown; readonly refresh_token?: unknown };
}

async function postRefresh(
  path: string,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<RefreshResponse> {
  const response = await fetch(`${AUTOCLAW_REFRESH_ORIGIN}${path}`, {
    method: "POST",
    headers: signedHeaders(),
    body: JSON.stringify({
      refresh_token: refreshToken,
      source_id: "autoclaw",
      device_id: `lianrouter-${process.platform}`,
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  const body = (await response.json().catch(() => null)) as RefreshResponse | null;
  if (body === null || typeof body.code !== "number") {
    throw new Error(
      `AutoClaw token refresh answered an unreadable response (HTTP ${response.status})`,
    );
  }
  return body;
}

/** Reads the stored refresh token and redeems it for a fresh access token. */
export async function refreshAutoClawToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<OAuthTokenRefreshResult> {
  const token = refreshJwt(refreshToken);
  if (token.length === 0) throw new Error("AutoClaw refresh token is empty");
  let body = await postRefresh(REFRESH_PATH, token, signal);
  // The desktop client treats 400002 on the primary lane as its signal to try
  // the agent variant; the lanes share the payload and differ in gate.
  if (body.code === 400002) body = await postRefresh(AGENT_REFRESH_PATH, token, signal);
  if (body.code !== 0) {
    throw new Error(
      `AutoClaw token refresh rejected (code ${body.code}${body.msg ? `: ${body.msg}` : ""})`,
    );
  }
  const access = typeof body.data?.access_token === "string" ? body.data.access_token.trim() : "";
  if (access.length === 0) throw new Error("AutoClaw token refresh omitted access_token");
  const nextRefresh =
    typeof body.data?.refresh_token === "string" && body.data.refresh_token.trim().length > 0
      ? body.data.refresh_token.trim()
      : token;
  return {
    // The stored access envelope is `Bearer <jwt>` (spec.ts autoClawToken strips
    // it); the refresh credential keeps the same envelope shape.
    access: `Bearer ${access}`,
    refresh: `Bearer ${nextRefresh}`,
    // The access JWT states a 24h exp; the sweep re-redeems it inside the skew
    // window long before that. Far-future spelling keeps the store happy.
    expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
  };
}
