/**
 * ZCode plan-lane OAuth (device code).
 *
 * The plan lane has no API key: the only credential it accepts is the plan JWT
 * the desktop client's own device flow mints, so login is a device
 * authorization the operator approves in a browser at `chat.z.ai`.
 *
 * Two shapes differ from the RFC 8628 defaults this codebase's shared device
 * helpers assume, which is why the flow is hand-rolled here:
 *
 *  - The start and poll bodies are JSON, and the poll is a `GET` on a path that
 *    carries the flow id rather than a `device_code` form post. The poll token
 *    is the *bearer*, not a body field.
 *  - The result is not an access/refresh pair in the OAuth sense: the payload's
 *    `token` is the plan JWT, and `zai.access_token` / `zai.refresh_token` are
 *    the vendor OAuth pair that can be refreshed later.
 *
 * The plan JWT carries no `exp` claim (claims are `{user_id, token_version,
 * sub, iat}`), so it never expires on its own. `expiresAt` therefore reports the
 * flow's own lifetime, not a token lifetime: stamping a fabricated hour would
 * make the refresh sweep discard a credential that is still valid, which is the
 * exact defect this lane's reference implementation had to fix.
 */
import * as crypto from "node:crypto";
import { isRecord } from "../../../protocol/primitives";
import { nonEmptyTrimmedString, readJsonResponse } from "../../authentication/oauth-flow-store";
import type {
  OAuthDeviceFlowContext,
  OAuthDevicePollResult,
  OAuthDeviceStartResult,
} from "../../authentication/oauth-flow-store";
import type { OAuthTokenRefreshResult } from "../../authentication/oauth-refresh-service";
import { OAuthClient, type FetchLike } from "../../authentication/oauth-client";

const ZCODE_OAUTH_ORIGIN = "https://zcode.z.ai";
const ZCODE_DEVICE_INIT_URL = `${ZCODE_OAUTH_ORIGIN}/api/v1/oauth/cli/init`;
const ZCODE_DEVICE_POLL_BASE = `${ZCODE_OAUTH_ORIGIN}/api/v1/oauth/cli/poll`;
const ZCODE_TOKEN_URL = `${ZCODE_OAUTH_ORIGIN}/api/v1/oauth/token`;

/** The desktop client identifies the OAuth provider by this name. */
const ZCODE_OAUTH_PROVIDER = "zai";
/** Approving the flow is a browser step; five minutes is the server's own window. */
const ZCODE_FLOW_TTL_SECONDS = 300;
/** The server polls every 2s; a slower client poll keeps the same ordering. */
const ZCODE_POLL_INTERVAL_SECONDS = 2;

/**
 * Recorded expiry for a credential that carries no `exp` claim.
 *
 * `provider_oauth_states.expires_at` is NOT NULL, so "never" has to be spelled
 * as a far-future date. It must not be "now plus a little": the refresh sweep
 * reads it to decide whether to redeem the refresh token, and this lane has no
 * refresh token to redeem — a near expiry would make every dispatch demand a
 * refresh that can only fail, and would disable a perfectly valid account.
 */
const ZCODE_NON_EXPIRING = new Date("9999-12-31T23:59:59.000Z");

/** Persisted credential shape for a ZCode account. */
interface ZcodeCredential {
  /** The plan JWT — what every inference and billing call sends. */
  readonly planToken: string;
  /** Vendor OAuth access token, when the flow returned one. */
  readonly accessToken?: string;
  readonly user?: Record<string, unknown>;
}

interface ZcodeRefreshCredential {
  readonly refreshToken: string;
}

function encodeCredential(credential: ZcodeCredential): string {
  return JSON.stringify(credential);
}

/**
 * Reads a stored credential.
 *
 * A bare JWT is accepted so an operator can paste one straight from the device
 * flow (or from the desktop client's own store) without wrapping it in JSON.
 */
export function parseZcodeCredential(value: string): ZcodeCredential {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("ZCode credential is empty");
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A truncated paste is not an envelope: the raw path below keeps it, so
      // the lane's own 401 explains the credential instead of a parse error
      // hiding it.
      return { planToken: trimmed };
    }
    if (isRecord(parsed)) {
      const planToken =
        nonEmptyTrimmedString(parsed["planToken"]) ?? nonEmptyTrimmedString(parsed["token"]);
      // Valid JSON shaped like an envelope but carrying no plan token is a
      // wrong-shaped credential (another provider's export, an access token
      // alone). Dispatching it verbatim would send a JSON blob as the bearer.
      if (planToken === undefined) throw new Error("ZCode credential is empty");
      const accessToken = nonEmptyTrimmedString(parsed["accessToken"]);
      const user = isRecord(parsed["user"]) ? parsed["user"] : undefined;
      return {
        planToken,
        ...(accessToken === undefined ? {} : { accessToken }),
        ...(user === undefined ? {} : { user }),
      };
    }
  }
  return { planToken: trimmed };
}

/** Extracts the plan JWT from a stored credential of either shape. */
export function zcodePlanToken(credential: string): string {
  return parseZcodeCredential(credential).planToken;
}

function encodeRefreshCredential(refreshToken: string): string {
  return JSON.stringify({ refreshToken } satisfies ZcodeRefreshCredential);
}

function parseRefreshCredential(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("ZCode refresh credential is empty");
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        const refreshToken = nonEmptyTrimmedString(parsed["refreshToken"]);
        if (refreshToken !== undefined) return refreshToken;
      }
    } catch {
      // Fall through to the raw value.
    }
  }
  return trimmed;
}

/** Display label from the flow's `user` payload, when it names something. */
function accountLabelFromUser(user: Record<string, unknown> | undefined): string | undefined {
  if (user === undefined) return undefined;
  return (
    nonEmptyTrimmedString(user["email"]) ??
    nonEmptyTrimmedString(user["name"]) ??
    nonEmptyTrimmedString(user["user_id"])
  );
}

/** Both token shapes the poll can return. */
function tokensFromPayload(data: Record<string, unknown>): {
  readonly accessToken?: string;
  readonly refreshToken?: string;
} {
  for (const key of ["zai", "bigmodel"] as const) {
    const block = data[key];
    if (!isRecord(block)) continue;
    const accessToken = nonEmptyTrimmedString(block["access_token"]);
    const refreshToken = nonEmptyTrimmedString(block["refresh_token"]);
    if (accessToken !== undefined || refreshToken !== undefined) {
      return {
        ...(accessToken === undefined ? {} : { accessToken }),
        ...(refreshToken === undefined ? {} : { refreshToken }),
      };
    }
  }
  return {};
}

export class ZcodeOAuthClient extends OAuthClient {
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  protected override readonly providerLabel = "ZCODE";
  protected override readonly clientId = "zcode-cli";
  protected override readonly tokenUrl = ZCODE_TOKEN_URL;
  protected override readonly scopes = "";

  constructor(fetchFn: FetchLike = globalThis.fetch) {
    super(fetchFn);
  }

  /**
   * Starts the device flow.
   *
   * The init call is authenticated with a random bearer the caller must echo on
   * every poll; the server hands the same value back as `poll_token`, so the
   * reply is authoritative when it carries one. It travels in `providerState`
   * (server-side only) and never reaches the dashboard.
   */
  async startDeviceAuth(
    _context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDeviceStartResult & { providerState: string }> {
    const pollToken = crypto.randomBytes(32).toString("hex");
    const response = await this.fetchFn(ZCODE_DEVICE_INIT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pollToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ provider: ZCODE_OAUTH_PROVIDER }),
    });
    const payload = await readJsonResponse(response, "ZCODE device authorization");
    const root = isRecord(payload) ? payload : {};
    const data = isRecord(root["data"]) ? root["data"] : {};
    const flowId = nonEmptyTrimmedString(data["flow_id"]);
    const authorizeUrl = nonEmptyTrimmedString(data["authorize_url"]);
    if (flowId === undefined || authorizeUrl === undefined) {
      throw new Error("ZCODE device authorization returned an invalid response");
    }
    const interval = Number(data["poll_interval_sec"]);
    return {
      verificationUri: authorizeUrl,
      // The flow has no short user code: approval happens on the opened page.
      userCode: "",
      deviceAuthId: flowId,
      intervalSeconds:
        Number.isFinite(interval) && interval > 0 ? interval : ZCODE_POLL_INTERVAL_SECONDS,
      expiresInSeconds: ZCODE_FLOW_TTL_SECONDS,
      providerState: nonEmptyTrimmedString(data["poll_token"]) ?? pollToken,
    };
  }

  /**
   * Polls one flow.
   *
   * `ready` is the only terminal success: it carries the plan JWT in `token`.
   * `failed` and `expired` end the flow; anything else stays pending, which
   * matches the server's own `pending` status and keeps a transient blip from
   * cancelling a flow the operator is still approving.
   */
  async pollDeviceAuth(
    deviceAuthId: string,
    context?: OAuthDeviceFlowContext,
  ): Promise<OAuthDevicePollResult> {
    const pollToken = context?.providerState;
    if (pollToken === undefined || pollToken.length === 0) {
      return { status: "failed", reason: "device flow lost its poll token; start again" };
    }
    const response = await this.fetchFn(`${ZCODE_DEVICE_POLL_BASE}/${encodeURIComponent(deviceAuthId)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${pollToken}`, accept: "application/json" },
    });
    if (!response.ok) {
      return { status: "failed", reason: `device polling failed (${response.status})` };
    }
    const payload = await readJsonResponse(response, "ZCODE device poll");
    const root = isRecord(payload) ? payload : {};
    // A non-zero envelope code is a terminal answer even on HTTP 200. The one
    // that matters is 3004 `invalid_flow`: a `ready` poll is single-use, so a
    // retry after a failed persist can never succeed. Reporting it as `pending`
    // left the dialog spinning forever with no way out.
    const code = typeof root["code"] === "number" ? root["code"] : 0;
    if (code !== 0) {
      const message = nonEmptyTrimmedString(root["msg"]) ?? `device poll code ${code}`;
      return { status: "failed", reason: `${message} (code ${code})` };
    }
    const data = isRecord(root["data"]) ? root["data"] : {};
    const status = nonEmptyTrimmedString(data["status"]);
    if (status === "ready") {
      const planToken = nonEmptyTrimmedString(data["token"]);
      if (planToken === undefined) {
        return { status: "failed", reason: "device flow returned no plan token" };
      }
      const user = isRecord(data["user"]) ? data["user"] : undefined;
      const tokens = tokensFromPayload(data);
      const credential: ZcodeCredential = {
        planToken,
        ...(tokens.accessToken === undefined ? {} : { accessToken: tokens.accessToken }),
        ...(user === undefined ? {} : { user }),
      };
      const accountLabel = accountLabelFromUser(user);
      return {
        status: "complete",
        result: {
          access: encodeCredential(credential),
          // No refresh token means *empty*, not an envelope around an empty
          // string. The account identity index hashes this value, so a wrapped
          // empty token is still a non-empty string: every login would hash to
          // the same digest and the second account would be refused as a
          // duplicate of the first.
          refresh: tokens.refreshToken === undefined ? "" : encodeRefreshCredential(tokens.refreshToken),
          // A far-future expiry is the honest value here. The plan JWT carries
          // no `exp` claim, so nothing about it expires; only a `token_version`
          // bump revokes it, and that surfaces as a 401 at dispatch. Recording
          // a short expiry would make the refresh sweep treat a live credential
          // as stale on every request — and because this flow has no refresh
          // token to redeem, that sweep can only fail.
          expiresAt: ZCODE_NON_EXPIRING,
          ...(accountLabel === undefined ? {} : { accountLabel }),
        },
      };
    }
    if (status === "failed") {
      return { status: "failed", reason: nonEmptyTrimmedString(root["msg"]) ?? "device flow was rejected" };
    }
    if (status === "expired") {
      return { status: "failed", reason: "device flow expired before approval" };
    }
    return { status: "pending" };
  }

  /**
   * Refreshes the vendor OAuth pair.
   *
   * The plan JWT itself is not refreshed by this grant — it is re-minted by a
   * new device flow. A rejection here means the operator must log in again,
   * which is a 15-second phone approval, so it is reported as a failure rather
   * than retried.
   */
  override async refresh(
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<OAuthTokenRefreshResult> {
    const token = parseRefreshCredential(refreshToken);
    if (token.length === 0) throw new Error("ZCODE refresh token is empty");
    const response = await this.fetchFn(ZCODE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        provider: ZCODE_OAUTH_PROVIDER,
        grant_type: "refresh_token",
        refresh_token: token,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = await readJsonResponse(response, "ZCODE token refresh");
    const root = isRecord(payload) ? payload : {};
    const data = isRecord(root["data"]) ? root["data"] : {};
    const planToken = nonEmptyTrimmedString(data["token"]);
    if (planToken === undefined) {
      throw new Error("ZCODE plan token refresh rejected (re-login required)");
    }
    const user = isRecord(data["user"]) ? data["user"] : undefined;
    const tokens = tokensFromPayload(data);
    return {
      access: encodeCredential({
        planToken,
        ...(tokens.accessToken === undefined ? {} : { accessToken: tokens.accessToken }),
        ...(user === undefined ? {} : { user }),
      }),
      ...(tokens.refreshToken === undefined
        ? {}
        : { refresh: encodeRefreshCredential(tokens.refreshToken) }),
      expiresAt: ZCODE_NON_EXPIRING,
    };
  }
}

export const zcodeOAuthClient = new ZcodeOAuthClient();
