import { describe, expect, test } from "bun:test";

import {
  AUTOCLAW_OAUTH_CLIENT_ID,
  AUTOCLAW_OAUTH_REDIRECT_URI,
  AutoClawOAuthError,
  autoClawSignedHeaders,
  exchangeAutoClawCode,
  fetchAutoClawCaptchaConfig,
  requestAutoClawAuthorizeUrl,
} from "../../../../src/providers/integrations/autoclaw/oauth";

const SIGNER = { appId: "100003", appKey: "38d2391985e2369a5fb8227d8e6cd5e5" };

/** A fetcher that records the request and replays one canned body. */
function stubFetch(body: unknown, status = 200): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  fetcher: typeof fetch;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("AutoClaw OAuth constants", () => {
  /**
   * The client id is AutoClaw's own, not ZCode's. A URL built with the ZCode id
   * is accepted by the authorize page and renders normally, so only this value
   * yields a `state` the exchange endpoint accepts — which makes it a contract,
   * not a preference.
   */
  test("uses AutoClaw's own OAuth client id", () => {
    expect(AUTOCLAW_OAUTH_CLIENT_ID).toBe("client_EnD0QI8bLRFT8cciLp389Q");
  });

  test("sends the browser callback to the port the desktop client listens on", () => {
    expect(AUTOCLAW_OAUTH_REDIRECT_URI).toBe("http://localhost:18432/auth/callback-zai");
  });
});

describe("autoClawSignedHeaders", () => {
  test("signs appid&timestamp&appkey with MD5", () => {
    const headers = autoClawSignedHeaders(SIGNER, 1_800_000_000);
    const expected = new Bun.CryptoHasher("md5")
      .update("100003&1800000000&38d2391985e2369a5fb8227d8e6cd5e5")
      .digest("hex");
    expect(headers["x-auth-sign"]).toBe(expected);
    expect(headers["x-auth-timestamp"]).toBe("1800000000");
  });

  /**
   * `accept` and the client identity headers are load-bearing on every
   * AutoClaw endpoint: without `accept` the gateway answers a 405 HTML page
   * before reading the body.
   */
  test("carries the client identity the gateway expects", () => {
    const headers = autoClawSignedHeaders(SIGNER, 1);
    expect(headers["accept"]).toBe("*/*");
    expect(headers["user-agent"]).toBe("AutoClaw/1.17.9");
    expect(headers["x-product"]).toBe("autoclaw");
    expect(headers["x-client-type"]).toBe("pc");
  });
});

describe("fetchAutoClawCaptchaConfig", () => {
  test("normalizes the snake_case challenge payload", async () => {
    const { fetcher } = stubFetch({
      code: 0,
      data: {
        enabled: true,
        region: "ga",
        prefix: "sq51tr",
        scene_id: "18vhnjxl",
        captcha_supplier: "aliyun",
      },
    });
    const config = await fetchAutoClawCaptchaConfig(SIGNER, fetcher);
    expect(config).toEqual({
      enabled: true,
      region: "ga",
      prefix: "sq51tr",
      sceneId: "18vhnjxl",
      supplier: "aliyun",
    });
  });

  test("treats a disabled gate as a real answer rather than an error", async () => {
    const { fetcher } = stubFetch({ code: 0, data: { enabled: false } });
    const config = await fetchAutoClawCaptchaConfig(SIGNER, fetcher);
    expect(config.enabled).toBe(false);
    // Defaults fill the fields the payload omitted, so the dashboard never
    // renders an empty region prefix.
    expect(config.region).toBe("ga");
    expect(config.supplier).toBe("aliyun");
  });
});

describe("requestAutoClawAuthorizeUrl", () => {
  test("returns the URL and the state minted with it", async () => {
    const { calls, fetcher } = stubFetch({
      code: 0,
      data: { oauth_url: "https://chat.z.ai/auth/oauth/authorize?x=1", state: "aosi.abc.sig" },
    });
    const started = await requestAutoClawAuthorizeUrl(SIGNER, { deviceId: "dev-1" }, fetcher);
    expect(started.url).toBe("https://chat.z.ai/auth/oauth/authorize?x=1");
    expect(started.state).toBe("aosi.abc.sig");

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toMatchObject({
      source_id: "autoclaw",
      device_id: "dev-1",
      navigate_uri: AUTOCLAW_OAUTH_REDIRECT_URI,
    });
  });

  test("forwards the solved captcha parameter when one is supplied", async () => {
    const { calls, fetcher } = stubFetch({ code: 0, data: { url: "u", state: "s" } });
    await requestAutoClawAuthorizeUrl(SIGNER, { deviceId: "d", captchaVerifyParam: "solved" }, fetcher);
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body["ali_captcha_verify_param"]).toBe("solved");
    // An absent parameter must not be sent as an empty string: the gateway
    // rejects an empty one as a malformed request instead of "no captcha".
    const second = stubFetch({ code: 0, data: { url: "u", state: "s" } });
    await requestAutoClawAuthorizeUrl(SIGNER, { deviceId: "d", captchaVerifyParam: "" }, second.fetcher);
    expect(JSON.parse(String(second.calls[0]?.init?.body))["ali_captcha_verify_param"]).toBeUndefined();
  });

  test("raises the gateway's code when it refuses to mint a URL", async () => {
    const { fetcher } = stubFetch({ code: 630014, msg: "Verification failed" });
    await expect(requestAutoClawAuthorizeUrl(SIGNER, { deviceId: "d" }, fetcher)).rejects.toMatchObject({
      code: 630014,
      message: "The captcha token is invalid or expired",
    });
  });
});

describe("exchangeAutoClawCode", () => {
  test("returns the account token pair and identity", async () => {
    const { calls, fetcher } = stubFetch({
      code: 0,
      data: {
        access_token: "at",
        refresh_token: "rt",
        user_id: 4242,
        user_name: "Operator",
      },
    });
    const result = await exchangeAutoClawCode(
      SIGNER,
      { code: "the-code", state: "the-state", deviceId: "dev-1" },
      fetcher,
    );
    expect(result).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      userId: "4242",
      displayName: "Operator",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      code: "the-code",
      state: "the-state",
      source_id: "autoclaw",
      navigate_uri: AUTOCLAW_OAUTH_REDIRECT_URI,
    });
  });

  test("reports the vendor verdict for a rejected code instead of a generic failure", async () => {
    const { fetcher } = stubFetch({ code: 631001, msg: "User login error" });
    await expect(
      exchangeAutoClawCode(SIGNER, { code: "bogus", state: "s", deviceId: "d" }, fetcher),
    ).rejects.toMatchObject({ code: 631001 });
  });

  test("refuses an empty code without spending a request", async () => {
    const { calls, fetcher } = stubFetch({ code: 0, data: {} });
    await expect(
      exchangeAutoClawCode(SIGNER, { code: "   ", state: "s", deviceId: "d" }, fetcher),
    ).rejects.toBeInstanceOf(AutoClawOAuthError);
    expect(calls).toHaveLength(0);
  });

  test("rejects an incomplete token set", async () => {
    const { fetcher } = stubFetch({ code: 0, data: { access_token: "at", user_id: 1 } });
    await expect(
      exchangeAutoClawCode(SIGNER, { code: "c", state: "s", deviceId: "d" }, fetcher),
    ).rejects.toMatchObject({ message: "AutoClaw returned an incomplete token set" });
  });
});
