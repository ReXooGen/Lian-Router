import type {
  OAuthAuthorizeRequest,
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
  OAuthLoginClient,
} from "../../authentication/oauth-flow-store";
import { decodeJwtPayload } from "../../authentication/oauth-flow-store";
import { autoClawAppHeaders } from "./spec";
import {
  AutoClawOAuthError,
  AUTOCLAW_OAUTH_CLIENT_ID,
  AUTOCLAW_OAUTH_REDIRECT_URI,
  exchangeAutoClawCode,
  fetchAutoClawCaptchaConfig,
  requestAutoClawAuthorizeUrl,
  type AutoClawCaptchaConfig,
  type AutoClawOAuthRequestSigner,
} from "./oauth";

export interface AutoClawOAuthClientOptions {
  readonly signer: AutoClawOAuthRequestSigner;
  /** Device id the gateway associates with the flow. */
  readonly deviceId: string;
  /** Solved Aliyun challenge, required when the deployment has the gate on. */
  readonly captchaVerifyParam?: string;
  /**
   * Where the vendor sends the browser back.
   *
   * Defaults to the shipped client's `http://localhost:18432/auth/callback-zai`,
   * which is only reachable when the AutoClaw desktop app happens to be running
   * on the same machine — and that server answers every path except `/get_token`
   * with `{"ok":false,"error":"Not found"}`, so a browser login started from a
   * remote console lands on a dead tab. A deployment that can serve the callback
   * itself passes its own URL here, and the exchange must name the same value
   * because the vendor binds `state` to it.
   */
  readonly navigateUri?: string;
  readonly fetchFn?: typeof fetch;
}

/** What a started authorization hands back to the dashboard. */
export interface AutoClawAuthorizeStart {
  readonly url: string;
  readonly state: string;
  readonly captcha: AutoClawCaptchaConfig;
}

export async function readAutoClawCaptchaConfig(
  options: AutoClawOAuthClientOptions,
): Promise<AutoClawCaptchaConfig> {
  return fetchAutoClawCaptchaConfig(options.signer, options.fetchFn ?? fetch);
}

/**
 * Asks the gateway for a captcha challenge and, when one is already solved, for
 * an authorization URL.
 *
 * Split from the client class because the challenge is a property of the
 * deployment while the URL is a property of one login attempt; the dashboard
 * needs the first before it can render a widget and the second only after.
 */
export async function beginAutoClawAuthorize(
  options: AutoClawOAuthClientOptions,
): Promise<AutoClawAuthorizeStart> {
  const fetcher = options.fetchFn ?? fetch;
  const captcha = await fetchAutoClawCaptchaConfig(options.signer, fetcher);
  const started = await requestAutoClawAuthorizeUrl(
    options.signer,
    {
      deviceId: options.deviceId,
      ...(options.captchaVerifyParam !== undefined
        ? { captchaVerifyParam: options.captchaVerifyParam }
        : {}),
      ...(options.navigateUri !== undefined ? { navigateUri: options.navigateUri } : {}),
    },
    fetcher,
  );
  return { url: started.url, state: started.state, captcha };
}

/**
 * Expiry stamped on a freshly minted AutoClaw credential.
 *
 * The vendor's access JWT carries a real 24h `exp` (measured on every live
 * account), and this value is what `provider_oauth_states.expires_at` records —
 * the only input the proactive refresh sweep and the reactive 401 retry use to
 * decide an account is due. Stamping a far-future date here made every account
 * permanently "fresh": the sweep never selected it, `resolveCredentialForAccount`
 * never redeemed the refresh half, and one day after login every billing read
 * answered `410000 Please log in to continue` while the row still said `active`.
 *
 * So: read the token's own `exp` when it has one, and fall back to a 23h window
 * (an hour inside the stated lifetime) only when it does not.
 */
function credentialExpiry(accessToken: string): Date {
  const claims = decodeJwtPayload(accessToken.replace(/^Bearer\s+/i, "").trim());
  const exp = claims?.["exp"];
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
    return new Date(exp * 1000);
  }
  return new Date(Date.now() + 23 * 60 * 60 * 1000);
}

/**
 * The `OAuthLoginClient` adapter.
 *
 * `buildAuthorizeUrl` throws: a URL cannot be built from a state this process
 * invents, and silently returning one would produce a link the exchange rejects.
 * The loopback and browser-code routes call it, so the honest answer is the
 * error — the dashboard drives `beginAutoClawAuthorize()` instead.
 */
export class AutoClawOAuthClient implements OAuthLoginClient {
  readonly supportsDeviceCode = false;
  readonly supportsBrowserCode = true;

  readonly #options: AutoClawOAuthClientOptions;

  constructor(options: AutoClawOAuthClientOptions) {
    this.#options = options;
  }

  get clientId(): string {
    return AUTOCLAW_OAUTH_CLIENT_ID;
  }

  get redirectUri(): string {
    return this.#options.navigateUri ?? AUTOCLAW_OAUTH_REDIRECT_URI;
  }

  buildAuthorizeUrl(_request: OAuthAuthorizeRequest): string {
    throw new AutoClawOAuthError(
      0,
      "AutoClaw mints its own OAuth state; call beginAutoClawAuthorize() to get a URL",
    );
  }

  /**
   * Redeems the callback's code.
   *
   * `state` here must be the value the gateway minted for this login. The
   * generic route passes the state it generated locally, which the gateway will
   * refuse — so this method is only reachable through the AutoClaw-specific
   * complete step.
   */
  async exchangeCode(
    _code: string,
    _codeVerifier: string,
    _redirectUri: string,
  ): Promise<OAuthExchangeResult> {
    throw new AutoClawOAuthError(
      0,
      "AutoClaw exchanges through its own gateway; use exchangeAutoClawLogin()",
    );
  }

  startDeviceAuth(_context?: OAuthDeviceFlowContext): Promise<OAuthDeviceStartResult> {
    throw new AutoClawOAuthError(0, "AutoClaw has no device-code flow");
  }

  pollDeviceAuth(
    _deviceAuthId: string,
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    throw new AutoClawOAuthError(0, "AutoClaw has no device-code flow");
  }

  /** One real login step: trade the callback's code for the account's tokens. */
  async exchangeLogin(input: {
    readonly code: string;
    readonly state: string;
  }): Promise<OAuthExchangeResult> {
    const result = await exchangeAutoClawCode(
      this.#options.signer,
      {
        code: input.code,
        state: input.state,
        deviceId: this.#options.deviceId,
        ...(this.#options.navigateUri !== undefined
          ? { navigateUri: this.#options.navigateUri }
          : {}),
      },
      this.#options.fetchFn ?? fetch,
    );
    return {
      access: result.accessToken,
      refresh: result.refreshToken,
      // The access JWT states its own 24h `exp`; recording it is what keeps the
      // account on the renewal lane instead of pinning it to "never expires".
      expiresAt: credentialExpiry(result.accessToken),
      // AutoClaw reports a numeric `user_id` and, when present, a display name;
      // the name is the only human-readable field the payload carries.
      ...(result.displayName !== null ? { accountLabel: result.displayName } : {}),
    };
  }
}

/**
 * The registry's login client.
 *
 * Built once at module scope, like every other provider's, so the registry
 * loader has a stable object to hand back. The signer is the shipped client's
 * own app identity — a public constant of the AutoClaw desktop build, not a
 * deployment secret — and the device id is derived per login by the console
 * flow that calls `beginAutoClawAuthorize()`.
 */
export const autoclawOAuthClient = new AutoClawOAuthClient({
  signer: {
    appId: "100003",
    appKey: "38d2391985e2369a5fb8227d8e6cd5e5",
  },
  deviceId: "lianrouter",
});

/** The verdict on a pasted token, as the console needs it. */
export interface AutoClawTokenCheck {
  readonly valid: boolean;
  readonly accountLabel?: string;
  readonly reason?: string;
}

/**
 * Confirms a pasted token is a live AutoClaw credential before it is stored.
 *
 * The probe is a single chat completion with a one-token cap. Any other
 * endpoint would answer 200 for a token that cannot actually complete a model
 * call, and the account would then fail on its first real request instead of
 * being rejected here. The gateway's own `401 {"error":"Invalid token"}` is the
 * signal a token is stale, foreign, or from another provider — a ZCode plan JWT
 * answers exactly that, which is why the check exists rather than trusting the
 * shape.
 */
export async function verifyAutoClawToken(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<AutoClawTokenCheck> {
  const trimmed = token.trim();
  if (trimmed.length === 0) return { valid: false, reason: "The token is empty" };
  const bearer = /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
  const response = await fetcher(
    "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/chat/completions",
    {
      method: "POST",
      headers: {
        ...autoClawAppHeaders(),
        "x-authorization": bearer,
        "x-request-model": "zai_auto",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "zai_auto",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 401) {
    return { valid: false, reason: "The gateway rejected this token (401 Invalid token)" };
  }
  if (response.status >= 500) {
    return { valid: false, reason: `The gateway is unavailable (HTTP ${response.status})` };
  }
  return { valid: true };
}
