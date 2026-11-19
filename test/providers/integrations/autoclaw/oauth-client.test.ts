import { describe, expect, test } from "bun:test";

import {
  AutoClawOAuthClient,
  autoclawOAuthClient,
  beginAutoClawAuthorize,
} from "../../../../src/providers/integrations/autoclaw/oauth-client";
import { AutoClawOAuthError } from "../../../../src/providers/integrations/autoclaw/oauth";

const SIGNER = { appId: "100003", appKey: "38d2391985e2369a5fb8227d8e6cd5e5" };

function stubFetch(...bodies: unknown[]): typeof fetch {
  let index = 0;
  return (async () => {
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("AutoClawOAuthClient", () => {
  const client = new AutoClawOAuthClient({ signer: SIGNER, deviceId: "dev-1" });

  test("declares browser-code support and no device flow", () => {
    expect(client.supportsBrowserCode).toBe(true);
    expect(client.supportsDeviceCode).toBe(false);
  });

  test("reports AutoClaw's own OAuth client id and callback", () => {
    expect(client.clientId).toBe("client_EnD0QI8bLRFT8cciLp389Q");
    expect(client.redirectUri).toBe("http://localhost:18432/auth/callback-zai");
  });

  /**
   * The generic browser-code route builds a URL from a locally generated state.
   * AutoClaw signs its own state and verifies it at exchange time, so any URL
   * built here would be rejected upstream. Throwing keeps the failure at the
   * caller instead of handing the operator a link that cannot complete.
   */
  test("refuses to build an authorize URL from a caller-supplied state", () => {
    expect(() =>
      client.buildAuthorizeUrl({
        state: "locally-generated",
        redirectUri: "http://localhost:18432/auth/callback-zai",
        codeChallenge: "challenge",
      }),
    ).toThrow(AutoClawOAuthError);
  });

  test("refuses the generic exchange, which would send the wrong state", async () => {
    await expect(client.exchangeCode("code", "verifier", "http://localhost:1/cb")).rejects.toBeInstanceOf(
      AutoClawOAuthError,
    );
  });

  test("has no device flow to start or poll", () => {
    expect(() => client.startDeviceAuth()).toThrow(AutoClawOAuthError);
    expect(() => client.pollDeviceAuth("id")).toThrow(AutoClawOAuthError);
  });

  test("exchanges a real login through the gateway", async () => {
    const fetcher = stubFetch({
      code: 0,
      data: { access_token: "at", refresh_token: "rt", user_id: 7, user_name: "Operator" },
    });
    const authed = new AutoClawOAuthClient({ signer: SIGNER, deviceId: "dev-1", fetchFn: fetcher });
    const result = await authed.exchangeLogin({ code: "c", state: "s" });
    expect(result.access).toBe("at");
    expect(result.refresh).toBe("rt");
    expect(result.accountLabel).toBe("Operator");
    // "at" carries no claims, so the stamp falls back to the 23h window. It
    // must be a near-future value, never a far-future one: the refresh sweep
    // only selects accounts whose stored expiry is inside the skew window, and
    // a never-expiring stamp is what kept the renewal lane from ever running.
    const hoursAhead = (result.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hoursAhead).toBeGreaterThan(22);
    expect(hoursAhead).toBeLessThan(24);
  });

  test("stamps the access JWT's own exp when it states one", async () => {
    const exp = Math.floor(Date.now() / 1000) + 86_400;
    const payload = Buffer.from(JSON.stringify({ user_id: 7, exp })).toString("base64url");
    const jwt = ["h", payload, "sig"].join(".");
    const fetcher = stubFetch({
      code: 0,
      data: { access_token: jwt, refresh_token: "rt", user_id: 7, user_name: "Operator" },
    });
    const authed = new AutoClawOAuthClient({ signer: SIGNER, deviceId: "dev-1", fetchFn: fetcher });
    const result = await authed.exchangeLogin({ code: "c", state: "s" });
    expect(result.expiresAt.getTime()).toBe(exp * 1000);
  });
});

describe("beginAutoClawAuthorize", () => {
  test("reads the challenge, then asks for the URL with the solved token", async () => {
    const fetcher = stubFetch(
      { code: 0, data: { enabled: true, region: "ga", prefix: "sq51tr", scene_id: "18vhnjxl", captcha_supplier: "aliyun" } },
      { code: 0, data: { oauth_url: "https://chat.z.ai/auth/oauth/authorize?x=1", state: "aosi.abc.sig" } },
    );
    const started = await beginAutoClawAuthorize({
      signer: SIGNER,
      deviceId: "d",
      captchaVerifyParam: "solved",
      fetchFn: fetcher,
    });
    expect(started.captcha.enabled).toBe(true);
    expect(started.captcha.sceneId).toBe("18vhnjxl");
    expect(started.url).toContain("chat.z.ai");
    expect(started.state).toBe("aosi.abc.sig");
  });

  test("surfaces the gateway's captcha refusal instead of a generic error", async () => {
    const fetcher = stubFetch(
      { code: 0, data: { enabled: true } },
      { code: 630014, msg: "Verification failed" },
    );
    await expect(
      beginAutoClawAuthorize({ signer: SIGNER, deviceId: "d", fetchFn: fetcher }),
    ).rejects.toMatchObject({ code: 630014 });
  });
});

describe("registry export", () => {
  test("is a real login client instance", () => {
    expect(autoclawOAuthClient).toBeInstanceOf(AutoClawOAuthClient);
    expect(autoclawOAuthClient.supportsBrowserCode).toBe(true);
  });
});
