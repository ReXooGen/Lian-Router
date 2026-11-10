import { describe, expect, test } from "bun:test";
import {
  ZcodeOAuthClient,
  parseZcodeCredential,
  zcodeOAuthClient,
  zcodePlanToken,
} from "../../../src/providers/integrations/zcode/zcode-oauth";
import { jsonResponse } from "../../helpers/sse-fixtures";

const INIT_URL = "https://zcode.z.ai/api/v1/oauth/cli/init";
const POLL_URL = "https://zcode.z.ai/api/v1/oauth/cli/poll/flow-1";
const TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";

/** Records each request so the assertions can read the wire, not a mock's echo. */
function recordingFetcher(routes: Record<string, () => Response>): {
  fetcher: typeof fetch;
  calls: { url: string; method: string; headers: Record<string, string>; body: string }[];
} {
  const calls: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          String(v),
        ]),
      ),
      body: typeof init?.body === "string" ? init.body : "",
    });
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler();
    }
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const READY_POLL = {
  code: 0,
  data: {
    status: "ready",
    token: "plan.jwt.value",
    user: { user_id: "u-1", email: "operator@example.com" },
    zai: { access_token: "vendor-access", refresh_token: "vendor-refresh" },
  },
};

describe("zcode device flow", () => {
  test("init is a JSON POST authenticated by a random bearer", async () => {
    const { fetcher, calls } = recordingFetcher({
      [INIT_URL]: () =>
        jsonResponse({
          code: 0,
          data: {
            flow_id: "flow-1",
            poll_token: "server-poll-token",
            authorize_url: "https://chat.z.ai/api/oauth/authorize?client_id=x",
            poll_interval_sec: 2,
          },
        }),
    });
    const client = new ZcodeOAuthClient(fetcher);
    const started = await client.startDeviceAuth();
    expect(started.deviceAuthId).toBe("flow-1");
    expect(started.verificationUri).toContain("chat.z.ai");
    expect(started.intervalSeconds).toBe(2);
    // The server's own poll token wins over the locally generated one.
    expect(started.providerState).toBe("server-poll-token");
    const init = calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ provider: "zai" }));
    expect(init?.headers["authorization"]).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(init?.headers["content-type"]).toBe("application/json");
  });

  test("the locally generated bearer is kept when the server does not echo one", async () => {
    const { fetcher, calls } = recordingFetcher({
      [INIT_URL]: () =>
        jsonResponse({
          code: 0,
          data: { flow_id: "flow-1", authorize_url: "https://chat.z.ai/x" },
        }),
    });
    const client = new ZcodeOAuthClient(fetcher);
    const started = await client.startDeviceAuth();
    const sentBearer = calls[0]?.headers["authorization"];
    expect(sentBearer).toBe(`Bearer ${started.providerState}`);
  });

  test("a flow without an authorize URL is rejected instead of half-started", async () => {
    const { fetcher } = recordingFetcher({
      [INIT_URL]: () => jsonResponse({ code: 0, data: { flow_id: "flow-1" } }),
    });
    const client = new ZcodeOAuthClient(fetcher);
    await expect(client.startDeviceAuth()).rejects.toThrow("invalid response");
  });

  test("a ready poll yields the plan JWT inside the stored envelope", async () => {
    const { fetcher, calls } = recordingFetcher({ [POLL_URL]: () => jsonResponse(READY_POLL) });
    const client = new ZcodeOAuthClient(fetcher);
    const polled = await client.pollDeviceAuth("flow-1", {
      providerId: "zcode",
      tenantId: null,
      accountLabel: "zcode",
      providerState: "poll-token",
    });
    expect(polled.status).toBe("complete");
    if (polled.status !== "complete") return;
    // The adapter and the quota reader both decode this envelope; a bare JWT
    // would still work, but the vendor pair would be lost.
    expect(parseZcodeCredential(polled.result.access).planToken).toBe("plan.jwt.value");
    expect(parseZcodeCredential(polled.result.access).accessToken).toBe("vendor-access");
    expect(polled.result.refresh).toContain("vendor-refresh");
    expect(polled.result.accountLabel).toBe("operator@example.com");
    // The poll is a GET carrying the flow id in the path and the poll token as
    // the bearer — not a form body.
    const poll = calls[0];
    expect(poll?.method).toBe("GET");
    expect(poll?.headers["authorization"]).toBe("Bearer poll-token");
    expect(poll?.body).toBe("");
  });

  test("a flow with no refresh token stores no refresh token, not an empty envelope", async () => {
    // The envelope `{"refreshToken":""}` is a non-empty string around an empty
    // token: the identity index hashes it, so every such login collided and a
    // second account could never be added.
    const { fetcher } = recordingFetcher({
      [POLL_URL]: () =>
        jsonResponse({
          code: 0,
          data: { status: "ready", token: "plan.jwt.value", user: { email: "a@example.com" } },
        }),
    });
    const client = new ZcodeOAuthClient(fetcher);
    const polled = await client.pollDeviceAuth("flow-1", {
      providerId: "zcode",
      tenantId: null,
      accountLabel: "zcode",
      providerState: "poll-token",
    });
    if (polled.status !== "complete") throw new Error("expected completion");
    expect(polled.result.refresh).toBe("");
  });

  test("a non-expiring credential is not stamped with a short expiry", async () => {
    // The plan JWT has no `exp`, and this flow issues no refresh token. A short
    // expiry makes every dispatch demand a refresh that can only fail, and the
    // credential service then drops the account to "no credential".
    const { fetcher } = recordingFetcher({ [POLL_URL]: () => jsonResponse(READY_POLL) });
    const client = new ZcodeOAuthClient(fetcher);
    const polled = await client.pollDeviceAuth("flow-1", {
      providerId: "zcode",
      tenantId: null,
      accountLabel: "zcode",
      providerState: "poll-token",
    });
    if (polled.status !== "complete") throw new Error("expected completion");
    expect(polled.result.expiresAt.getUTCFullYear()).toBeGreaterThan(9000);
  });

  test("pending and unknown statuses keep the flow alive", async () => {
    const { fetcher } = recordingFetcher({
      [POLL_URL]: () => jsonResponse({ code: 0, data: { status: "pending" } }),
    });
    const client = new ZcodeOAuthClient(fetcher);
    const polled = await client.pollDeviceAuth("flow-1", {
      providerId: "zcode",
      tenantId: null,
      accountLabel: "zcode",
      providerState: "poll-token",
    });
    expect(polled.status).toBe("pending");
  });

  test("expired and failed are terminal", async () => {
    for (const status of ["expired", "failed"]) {
      const { fetcher } = recordingFetcher({
        [POLL_URL]: () => jsonResponse({ code: 0, data: { status } }),
      });
      const client = new ZcodeOAuthClient(fetcher);
      const polled = await client.pollDeviceAuth("flow-1", {
        providerId: "zcode",
        tenantId: null,
        accountLabel: "zcode",
        providerState: "poll-token",
      });
      expect(polled.status).toBe("failed");
    }
  });

  test("a flow without its poll token fails instead of polling unauthenticated", async () => {
    const { fetcher, calls } = recordingFetcher({});
    const client = new ZcodeOAuthClient(fetcher);
    const polled = await client.pollDeviceAuth("flow-1", {
      providerId: "zcode",
      tenantId: null,
      accountLabel: "zcode",
    });
    expect(polled.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  test("a non-zero envelope code on HTTP 200 is terminal, not pending", async () => {
    // 3004 invalid_flow: a ready poll is single-use, so a retry after a failed
    // persist can never succeed. Reporting it as pending made the dialog spin
    // forever with no way out.
    const { fetcher } = recordingFetcher({
      [POLL_URL]: () => jsonResponse({ code: 3004, msg: "invalid_flow" }),
    });
    const client = new ZcodeOAuthClient(fetcher);
    const polled = await client.pollDeviceAuth("flow-1", {
      providerId: "zcode",
      tenantId: null,
      accountLabel: "zcode",
      providerState: "poll-token",
    });
    expect(polled.status).toBe("failed");
    if (polled.status !== "failed") return;
    expect(polled.reason).toContain("invalid_flow");
  });

  test("a ready poll without a plan token is a failure, not an empty account", async () => {
    const { fetcher } = recordingFetcher({
      [POLL_URL]: () => jsonResponse({ code: 0, data: { status: "ready" } }),
    });
    const client = new ZcodeOAuthClient(fetcher);
    const polled = await client.pollDeviceAuth("flow-1", {
      providerId: "zcode",
      tenantId: null,
      accountLabel: "zcode",
      providerState: "poll-token",
    });
    expect(polled.status).toBe("failed");
  });
});

describe("zcode credential shapes", () => {
  test("a bare JWT is accepted as the credential", () => {
    expect(zcodePlanToken("  eyJhbGciOi.payload.sig  ")).toBe("eyJhbGciOi.payload.sig");
  });

  test("the OAuth envelope is decoded to its plan token", () => {
    const envelope = JSON.stringify({ planToken: "jwt-1", accessToken: "a", user: { email: "x@y" } });
    expect(zcodePlanToken(envelope)).toBe("jwt-1");
    expect(parseZcodeCredential(envelope).accessToken).toBe("a");
  });

  test("an envelope without a plan token is rejected", () => {
    expect(() => parseZcodeCredential(JSON.stringify({ accessToken: "a" }))).toThrow(
      "ZCode credential is empty",
    );
  });

  test("malformed JSON falls back to the raw string", () => {
    // A truncated paste must still be dispatched so the lane's own 401 explains
    // the problem, rather than a parse error hiding it.
    expect(zcodePlanToken("{not json")).toBe("{not json");
  });

  test("the registered client is device-only", () => {
    expect(zcodeOAuthClient.supportsDeviceCode).toBe(true);
    expect(zcodeOAuthClient.supportsBrowserCode).toBe(false);
  });
});

describe("zcode token refresh", () => {
  test("a refresh returns a new plan token and keeps the vendor pair", async () => {
    const { fetcher, calls } = recordingFetcher({
      [TOKEN_URL]: () =>
        jsonResponse({
          code: 0,
          data: {
            token: "plan.jwt.fresh",
            user: { user_id: "u-1" },
            zai: { access_token: "new-access", refresh_token: "new-refresh" },
          },
        }),
    });
    const client = new ZcodeOAuthClient(fetcher);
    const refreshed = await client.refresh(JSON.stringify({ refreshToken: "old-refresh" }));
    expect(parseZcodeCredential(refreshed.access).planToken).toBe("plan.jwt.fresh");
    expect(refreshed.refresh).toContain("new-refresh");
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      provider: "zai",
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
    });
  });

  test("a rejected refresh throws so the account is re-logged instead of retried", async () => {
    const { fetcher } = recordingFetcher({
      [TOKEN_URL]: () => jsonResponse({ code: 3001, msg: "parameter error" }, 400),
    });
    const client = new ZcodeOAuthClient(fetcher);
    await expect(client.refresh("bogus")).rejects.toThrow();
  });
});
