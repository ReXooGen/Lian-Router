import type {
  OAuthAuthorizeRequest,
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
  OAuthExchangeResult,
  OAuthLoginClient,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult, OAuthTokenRefresher } from "../../authentication/oauth-refresh-service";
import { refreshAutoClawToken } from "./autoclaw-refresh";
import {
  AutoClawOAuthClient,
  autoclawOAuthClient,
  type AutoClawOAuthClientOptions,
} from "./oauth-client";

/**
 * The refresher half of the AutoClaw pair.
 *
 * `AutoClawOAuthClient` deliberately throws on `refresh`: at the time it was
 * written the vendor's renewal lane was undiscovered, and the client predated
 * the desktop build's own `/userapi/v1/refresh` call. That lane is now mapped
 * (see `autoclaw-refresh.ts`), so this adapter stands next to the login client
 * and implements only `OAuthTokenRefresher`. The registry wires it through
 * `withRefresher`, which turns the proactive expiry sweep and the reactive 401
 * retry both into live token rotations instead of dead ends.
 *
 * The login client stays untouched: authorization still mints a vendor state,
 * and nothing about completing a login changed.
 */
class AutoClawTokenRefresher implements OAuthTokenRefresher {
  async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenRefreshResult> {
    return refreshAutoClawToken(refreshToken, signal);
  }
}

export const autoclawTokenRefresher = new AutoClawTokenRefresher();

/**
 * The login *instance* the registry resolves.
 *
 * `oauthCapability` hands `module[exportName]` straight to the catalog, which
 * probes it for `supportsBrowserCode` / `buildAuthorizeUrl` / `exchangeCode`.
 * Exporting the class here put a constructor in that slot: the capability probe
 * reads those members off the prototype (`typeof` is `"function"` for both
 * methods, so the shape looks plausible) while `supportsBrowserCode` is
 * `undefined` on the class itself — the default is `true`, so the button still
 * appeared — and every generic route that called a method on it got a
 * receiver-less throw. Exporting the module-scope instance is what the other
 * providers do and what `oauth-client.test.ts` already asserts against.
 */
export const AutoClawLoginClient = autoclawOAuthClient;

export { AutoClawOAuthClient };
export type { AutoClawOAuthClientOptions, OAuthAuthorizeRequest, OAuthDeviceFlowContext, OAuthDevicePollResult, OAuthDeviceStartResult, OAuthExchangeResult, OAuthLoginClient };
