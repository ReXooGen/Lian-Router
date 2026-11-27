import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fetchDailyCheckinStatus,
  type DailyCheckinStatusResult,
} from "../../../../src/providers/integrations/buddy/buddy-checkin";
import {
  VERSION_SOURCES,
  _resetCodeBuddyVersionCache,
} from "../../../../src/providers/operations/client-versions";

const STATUS_URL = "https://www.codebuddy.ai/v2/billing/meter/checkin-activity-status";

type FetchCall = {
  readonly url: string;
  readonly method: string;
};

function recorder(response: Response | Error): { calls: FetchCall[]; fetcher: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return { calls, fetcher };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fetchStatus(response: Response): Promise<{
  readonly result: DailyCheckinStatusResult;
  readonly calls: readonly FetchCall[];
}> {
  const { calls, fetcher } = recorder(response);
  const result = await fetchDailyCheckinStatus({
    providerId: "cb",
    accountId: "account-1",
    credential: "refresh-aware-token",
    fetcher,
  });
  return { result, calls };
}

beforeEach(() => {
  _resetCodeBuddyVersionCache(VERSION_SOURCES.codebuddy.fallback);
});

afterEach(() => {
  _resetCodeBuddyVersionCache();
});

describe("fetchDailyCheckinStatus", () => {
  test("reports due only for an explicit false activity while active", async () => {
    const { result, calls } = await fetchStatus(
      jsonResponse({ code: 0, data: { active: true, today_checked_in: false, streak_days: 3 } }),
    );

    expect(result).toEqual({
      providerId: "cb",
      accountId: "account-1",
      state: "due",
      streakDays: 3,
      error: null,
    });
    expect(calls).toEqual([{ url: STATUS_URL, method: "POST" }]);
  });

  test("reports completed when today_checked_in is true", async () => {
    const { result, calls } = await fetchStatus(
      jsonResponse({ code: 0, data: { active: true, today_checked_in: true, streak_days: 8 } }),
    );

    expect(result.state).toBe("completed");
    expect(result.streakDays).toBe(8);
    expect(result.error).toBeNull();
    expect(calls).toEqual([{ url: STATUS_URL, method: "POST" }]);
  });

  test("reads the nested CodeBuddy response shape", async () => {
    const { result, calls } = await fetchStatus(
      jsonResponse({
        code: 0,
        data: { Response: { Data: { active: true, today_checked_in: false, streak_days: 4 } } },
      }),
    );

    expect(result.state).toBe("due");
    expect(result.streakDays).toBe(4);
    expect(calls).toEqual([{ url: STATUS_URL, method: "POST" }]);
  });

  test("does not report due when the activity is inactive", async () => {
    const { result, calls } = await fetchStatus(
      jsonResponse({ code: 0, data: { active: false, today_checked_in: false, streak_days: 2 } }),
    );

    expect(result.error).toBe("No check-in activity running.");
    expect(calls).toEqual([{ url: STATUS_URL, method: "POST" }]);
  });

  test("does not infer due from malformed or missing activity", async () => {
    for (const data of [
      { active: true, today_checked_in: "false" },
      { active: true },
      { active: true, today_checked_in: null },
    ]) {
      const { result, calls } = await fetchStatus(jsonResponse({ code: 0, data }));
      expect(result.state).toBe("unavailable");
      expect(calls).toEqual([{ url: STATUS_URL, method: "POST" }]);
    }
  });

  test("returns an error for a nonzero business code without exposing credentials", async () => {
    const { result, calls } = await fetchStatus(
      jsonResponse({ code: 1001, message: "already checked in: refresh-aware-token" }),
    );

    expect(result.state).toBe("error");
    expect(result.error).toBe("Check-in status error (code 1001).");
    expect(result.error).not.toContain("refresh-aware-token");
    expect(calls).toEqual([{ url: STATUS_URL, method: "POST" }]);
  });

  test("returns a sanitized error for transport failures", async () => {
    const { calls, fetcher } = recorder(new Error("upstream rejected refresh-aware-token"));
    const result = await fetchDailyCheckinStatus({
      providerId: "cb",
      accountId: "account-1",
      credential: "refresh-aware-token",
      fetcher,
    });

    expect(result.state).toBe("error");
    expect(result.error).toBe("Check-in status request failed.");
    expect(result.error).not.toContain("refresh-aware-token");
    expect(calls).toEqual([{ url: STATUS_URL, method: "POST" }]);
  });
});
