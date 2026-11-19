/**
 * AutoClaw account OAuth.
 *
 * AutoClaw does not run an OAuth server of its own: it relays to Z.ai's
 * authorization endpoint and then exchanges the returned code on the operator's
 * behalf. The exchange is the part that makes this flow different from ZCode's
 * device flow — ZCode polls a public `cli/poll` endpoint, while AutoClaw asks
 * its own gateway (`/userapi/overseasv1/zai-oauth-login`) to redeem the code.
 *
 * Two facts had to be discovered rather than read, because the vendor does not
 * document them:
 *
 *  - **The client id is AutoClaw's, not ZCode's.** An authorize URL built with
 *    ZCode's client id is accepted by `chat.z.ai` and renders normally, so the
 *    page is not the discriminator; only AutoClaw's own client id produces a
 *    `state` the exchange endpoint accepts.
 *  - **The `state` is minted by the gateway, not by the caller.** It is a
 *    three-part `aosi.<claims>.<sig>` value carrying `src: "autoclaw"`,
 *    `p: "zai"` and a 600-second window. A caller cannot fabricate one, so the
 *    flow must ask `zai-oauth-url` for it and keep whatever it returns.
 *
 * The authorization step itself is captcha-gated: `zai-oauth-url` answers
 * `630014` unless a solved Aliyun challenge is supplied, and the challenge is
 * configured per deployment through `oauth-captcha-config`. The exchange step
 * is not captcha-gated — it accepts a code and reports the vendor's own verdict.
 */

export interface AutoClawOAuthRequestSigner {
  readonly appId: string;
  readonly appKey: string;
}

/** The shipped desktop client's OAuth client id. */
export const AUTOCLAW_OAUTH_CLIENT_ID = "client_EnD0QI8bLRFT8cciLp389Q";

/** Where an AutoClaw login sends its browser callback. */
export const AUTOCLAW_OAUTH_REDIRECT_URI = "http://localhost:18432/auth/callback-zai";

/** Challenge configuration the dashboard needs to render the captcha. */
export interface AutoClawCaptchaConfig {
  readonly enabled: boolean;
  readonly region: string;
  readonly prefix: string;
  readonly sceneId: string;
  readonly supplier: string;
}

/** A started authorization: the URL to open and the state it was minted with. */
export interface AutoClawAuthorizeStart {
  readonly url: string;
  readonly state: string;
}

/** The account material a completed exchange returns. */
export interface AutoClawOAuthResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
  readonly displayName: string | null;
}

/** Error carrying the gateway's own code so callers can branch on it. */
export class AutoClawOAuthError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "AutoClawOAuthError";
    this.code = code;
  }
}

const AUTOCLAW_IDENTITY_ORIGIN = "https://autoglm-api.autoglm.ai";
const CAPTCHA_CONFIG_PATH = "/userapi/overseasv1/oauth-captcha-config";
const AUTHORIZE_URL_PATH = "/userapi/overseasv1/zai-oauth-url";
const LOGIN_PATH = "/userapi/overseasv1/zai-oauth-login";

/**
 * Messages for the codes the gateway documents in its own error table. A code
 * outside this map is surfaced with its number so an unlisted refusal is never
 * mistaken for a wrong password.
 */
const ERROR_MESSAGES: Readonly<Record<number, string>> = {
  // Both of these mean the request carried no solved challenge; which one comes
  // back depends on the caller's `x-tm` value (Windows and macOS report a
  // version refusal, Linux and Android a payload error). Neither may be read as
  // a version or request-shape problem.
  400001: "The captcha challenge was not answered",
  400002: "The captcha verification was refused",
  400003: "The OAuth session expired; start the login again",
  630014: "The captcha token is invalid or expired",
  631001: "Z.ai did not accept the authorization code",
  631002: "The captcha challenge was not answered",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function md5Hex(value: string): string {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(value);
  return hasher.digest("hex");
}

/**
 * Signed app headers. Every AutoClaw user-facing endpoint authenticates the
 * caller as the client before it looks at the payload, so these travel on all
 * three calls below.
 */
export function autoClawSignedHeaders(
  signer: AutoClawOAuthRequestSigner,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const timestamp = String(nowSeconds);
  return {
    accept: "*/*",
    "accept-language": "en",
    "content-type": "application/json",
    "user-agent": "AutoClaw/1.17.9",
    "x-auth-appid": signer.appId,
    "x-auth-timestamp": timestamp,
    "x-auth-sign": md5Hex(`${signer.appId}&${timestamp}&${signer.appKey}`),
    "x-version": "1.17.9",
    "x-tm": process.platform === "win32" ? "win" : "linux",
    "x-product": "autoclaw",
    "x-channel": "official",
    "x-lang": "en",
    "x-client-type": "pc",
  };
}

async function postSigned(
  signer: AutoClawOAuthRequestSigner,
  path: string,
  payload: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`${AUTOCLAW_IDENTITY_ORIGIN}${path}`, {
    method: "POST",
    headers: autoClawSignedHeaders(signer),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = asRecord(await response.json().catch(() => null));
  if (body === null || typeof body["code"] !== "number") {
    throw new AutoClawOAuthError(0, `AutoClaw answered an unreadable response (HTTP ${response.status})`);
  }
  const code = body["code"] as number;
  if (code !== 0) {
    const detail = asText(body["msg"]);
    const known = ERROR_MESSAGES[code];
    throw new AutoClawOAuthError(
      code,
      known ?? `AutoClaw refused the request (code ${code}${detail ? `: ${detail}` : ""})`,
    );
  }
  return body;
}

/** Reads the captcha challenge this deployment is configured with. */
export async function fetchAutoClawCaptchaConfig(
  signer: AutoClawOAuthRequestSigner,
  fetcher: typeof fetch = fetch,
): Promise<AutoClawCaptchaConfig> {
  const body = await postSigned(signer, CAPTCHA_CONFIG_PATH, {}, fetcher);
  const data = asRecord(body["data"]) ?? {};
  return {
    enabled: data["enabled"] === true,
    region: asText(data["region"]) ?? "ga",
    prefix: asText(data["prefix"]) ?? "",
    sceneId: asText(data["scene_id"]) ?? "",
    supplier: asText(data["captcha_supplier"]) ?? "aliyun",
  };
}

/**
 * Asks the gateway to mint an authorization URL and its matching `state`.
 *
 * The captcha parameter is optional in shape but required in practice whenever
 * the challenge is enabled; the gateway answers `630014` without a solved one
 * and `400002` when the token does not verify.
 */
export async function requestAutoClawAuthorizeUrl(
  signer: AutoClawOAuthRequestSigner,
  options: {
    readonly deviceId: string;
    readonly captchaVerifyParam?: string;
    readonly navigateUri?: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<AutoClawAuthorizeStart> {
  const navigateUri = options.navigateUri ?? AUTOCLAW_OAUTH_REDIRECT_URI;
  const payload: Record<string, unknown> = {
    source_id: "autoclaw",
    navigate_uri: navigateUri,
    device_id: options.deviceId,
  };
  if (options.captchaVerifyParam !== undefined && options.captchaVerifyParam.length > 0) {
    payload["ali_captcha_verify_param"] = options.captchaVerifyParam;
  }
  const body = await postSigned(signer, AUTHORIZE_URL_PATH, payload, fetcher);
  const data = asRecord(body["data"]) ?? {};
  const url = asText(data["oauth_url"]) ?? asText(data["url"]);
  const state = asText(data["state"]);
  if (url === null || state === null) {
    throw new AutoClawOAuthError(0, "AutoClaw returned no authorization URL");
  }
  return { url, state };
}

/**
 * Redeems the authorization code the browser callback carries.
 *
 * `state` must be the value minted with the URL — the gateway verifies it, so a
 * caller cannot substitute its own. The response is the account's own token
 * pair: `access_token`/`refresh_token` are the Z.ai OAuth pair, and `user_id`
 * identifies the account for dedupe.
 */
export async function exchangeAutoClawCode(
  signer: AutoClawOAuthRequestSigner,
  options: {
    readonly code: string;
    readonly state: string;
    readonly deviceId: string;
    readonly navigateUri?: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<AutoClawOAuthResult> {
  if (options.code.trim().length === 0) {
    throw new AutoClawOAuthError(400001, "The callback carried no authorization code");
  }
  const body = await postSigned(
    signer,
    LOGIN_PATH,
    {
      code: options.code,
      state: options.state,
      navigate_uri: options.navigateUri ?? AUTOCLAW_OAUTH_REDIRECT_URI,
      device_id: options.deviceId,
      source_id: "autoclaw",
    },
    fetcher,
  );
  const data = asRecord(body["data"]) ?? {};
  const accessToken = asText(data["access_token"]);
  const refreshToken = asText(data["refresh_token"]);
  const userId = data["user_id"];
  if (accessToken === null || refreshToken === null || userId === null || userId === undefined) {
    throw new AutoClawOAuthError(0, "AutoClaw returned an incomplete token set");
  }
  return {
    accessToken,
    refreshToken,
    userId: String(userId),
    displayName: asText(data["user_name"]) ?? asText(data["email"]) ?? asText(data["user_email"]),
  };
}

/**
 * The credential an AutoClaw account is stored with.
 *
 * The access token is what the dispatch path sends in `X-Authorization`, so the
 * stored secret is the token pair as JSON; `autoClawToken()` in `spec.ts` reads
 * `accessToken` out of exactly this envelope.
 */
export function autoClawStoredCredential(result: AutoClawOAuthResult): string {
  return JSON.stringify({ accessToken: result.accessToken, refreshToken: result.refreshToken });
}
