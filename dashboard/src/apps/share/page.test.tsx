import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShareEnrollmentData } from "../../lib/hooks/share-data";

(globalThis as { window?: unknown }).window = {
  location: { pathname: "/share/public-token", origin: "https://gateway.example" },
  localStorage: { getItem: () => null, setItem: () => undefined },
};

interface ShareState { data: ShareEnrollmentData | null; error: string | null; loading: boolean; refresh: () => void }
const refresh = () => undefined;
let shareState: ShareState = { data: null, error: null, loading: true, refresh };
mock.module("../../lib/hooks/share-data", () => ({ useShareData: (): ShareState => shareState }));
// Load after mock.module so the page captures the mocked data hook.
const { SharePage } = await import("./page");
function render(): string { return renderToStaticMarkup(createElement(SharePage)); }

const emptyActivity = {
  allTime: { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  lastUsedAt: null,
  models: [],
  requests: [],
  series: [],
} as const;

const data: ShareEnrollmentData = {
  name: "Team Access", keyPrefix: "ctk", canIssue: true, alreadyIssued: false, recoverable: false,
  dailyLimit: 50_000, monthlyLimit: null, oneTimeLimit: null, requestsPerMinute: 20,
  maxConcurrentRequests: 3, providerAllowlist: ["openai"], models: [{
    id: "openai/gpt-5", providerId: "openai", modelId: "gpt-5", wireFamily: "chat",
    contextLimit: 200_000, outputLimit: 64_000, reasoning: true, toolCall: true,
    vision: true, webSearch: false, source: "discovered",
  }],
  modelDenylist: null, modelPrefix: "gpt-", policyConflict: false, notes: { title: null, subtitle: "Shared access", body: "Use responsibly" },
  expiresAt: null, activity: emptyActivity,
};

describe("public share enrollment page", () => {
  test("shows a loading state while enrollment policy is fetched", () => {
    shareState = { data: null, error: null, loading: true, refresh };
    const markup = render();
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("Generate my child key");
  });

  test("shows policy and explicit child-key generation without disclosing any credential", () => {
    shareState = { data, error: null, loading: false, refresh };
    const markup = render();
    expect(markup).toContain("Team Access");
    expect(markup).toContain("LianRouter");
    expect(markup).toContain('data-theme="dark"');
    expect(markup).toContain('aria-label="Light mode"');
    expect(markup).toContain('aria-label="Dark mode"');
    expect(markup).toContain("Generate my child key");
    expect(markup).toContain("never displays a parent credential");
    // The allowlist renders as copyable chips now, so the assertion checks the
    // panel's structure and the model name rather than the old inline sentence.
    expect(markup).toContain("MODEL ACCESS");
    expect(markup).toContain("Allowed models");
    expect(markup).toContain("gpt-5");
    expect(markup).toContain("200k ctx · 64k out");
    expect(markup).toContain("Fetched");
    expect(markup).toContain("Copy all");
    expect(markup).toContain("Required model prefix: gpt-");
    expect(markup).toContain("Community usage");
    expect(markup).toContain("Combined activity from every child key generated through this share");
    // Community usage is a collapsed dropdown by default: the toggle is
    // rendered, and the body is mounted but hidden.
    expect(markup).toContain('aria-controls="share-activity-body"');
    expect(markup).toContain("Show statistics");
    expect(markup).toContain('id="share-activity-body" hidden=""');
    expect(markup).not.toContain("parentSecret");
    expect(markup).not.toContain("sk-parent-raw");
    expect(markup).not.toContain("telemetry");
  });

  test("collapses long model lists to eight and places the endpoint below the policy", () => {
    const models = Array.from({ length: 10 }, (_, index) => ({
      id: `openai/model-${index}`,
      providerId: "openai",
      modelId: `model-${index}`,
      wireFamily: "chat",
      contextLimit: 200_000,
      outputLimit: 64_000,
      reasoning: false,
      toolCall: true,
      vision: false,
      webSearch: false,
      source: "discovered",
    }));
    shareState = { data: { ...data, models }, error: null, loading: false, refresh };
    const markup = render();
    expect((markup.match(/class="share-model-card"/g) ?? []).length).toBe(8);
    expect(markup).toContain("Show 2 more");
    expect(markup).toContain("OpenAI-compatible inference endpoint");
    expect(markup).toContain("https://gateway.example/v1");
    // Order is policy → API configuration → live statistics → model access.
    expect(markup.indexOf("ACCESS POLICY")).toBeLessThan(markup.indexOf("API CONFIGURATION"));
    expect(markup.indexOf("API CONFIGURATION")).toBeLessThan(markup.indexOf("BASE URL"));
    expect(markup.indexOf("BASE URL")).toBeLessThan(markup.indexOf("LIVE STATISTICS"));
    expect(markup.indexOf("LIVE STATISTICS")).toBeLessThan(markup.indexOf("MODEL ACCESS"));
  });

  test("does not offer another generation after this IP has already enrolled", () => {
    shareState = { data: { ...data, canIssue: false, alreadyIssued: true }, error: null, loading: false, refresh };
    const markup = render();
    expect(markup).toContain("An active child key has already been issued from this IP.");
    expect(markup).toContain("Enrollment unavailable");
    expect(markup).not.toContain("Generate my child key");
  });

  test("shows a useful unavailable state", () => {
    shareState = { data: null, error: "This enrollment link has expired.", loading: false, refresh };
    expect(render()).toContain("This enrollment link has expired.");
  });

  test("names the misconfiguration when provider and model rules cancel out", () => {
    // The template allows provider `openai` but lists only `grok/*` models, so
    // the resolved allowlist is empty and no key could ever be spent. The page
    // must say that instead of implying the policy is open.
    shareState = {
      data: {
        ...data,
        providerAllowlist: ["openai"],
        models: [],
        modelDenylist: null,
        modelPrefix: null,
        policyConflict: true,
      },
      error: null,
      loading: false,
      refresh,
    };
    const markup = render();
    expect(markup).toContain("No model is reachable with this template");
    expect(markup).toContain("openai");
    expect(markup).not.toContain("Model access follows the share template policy");
  });

  test("keeps the open-policy wording when the template lists no models", () => {
    shareState = {
      data: { ...data, models: [], modelDenylist: null, modelPrefix: null, policyConflict: false },
      error: null,
      loading: false,
      refresh,
    };
    expect(render()).toContain("Model access follows the share template policy");
  });

  test("renders request/token chart controls, model ranking, and masked-IP activity", () => {
    shareState = {
      data: {
        ...data,
        canIssue: false,
        alreadyIssued: true,
        activity: {
          allTime: { requests: 42, errors: 2, inputTokens: 90_000, outputTokens: 30_000, totalTokens: 120_000 },
          lastUsedAt: "2026-10-03T05:00:00.000Z",
          models: [{
            providerId: "openai", modelId: "openai/gpt-5", retainedRequests: 32,
            retainedErrors: 1, retainedTokens: 100_000, todayRequests: 7,
            todayErrors: 0, todayTokens: 20_000,
          }],
          series: [
            { day: "2026-09-27", requests: 2, inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500 },
            { day: "2026-09-28", requests: 4, inputTokens: 2_000, outputTokens: 700, totalTokens: 2_700 },
          ],
          requests: [{
            requestId: "request-1", startedAt: "2026-10-03T05:00:00.000Z", providerId: "openai",
            modelId: "openai/gpt-5", status: "completed", clientIp: "198.51.100.xxx",
            inputTokens: 700, outputTokens: 300, totalTokens: 1_000,
          }],
        },
      },
      error: null,
      loading: false,
      refresh,
    };
    const markup = render();
    expect(markup).toContain("LIVE STATISTICS");
    expect(markup).toContain("Community usage");
    expect(markup).toContain("Combined activity from every child key generated through this share");
    // Community usage is a collapsed dropdown by default: the toggle is
    // rendered, and the body is mounted but hidden.
    expect(markup).toContain('aria-controls="share-activity-body"');
    expect(markup).toContain("Show statistics");
    expect(markup).toContain('id="share-activity-body" hidden=""');
    expect(markup).not.toContain("Your usage");
    expect(markup).toContain("Total requests");
    expect(markup).toContain("120k");
    expect(markup).toContain("Requests");
    expect(markup).toContain("Tokens");
    expect(markup).toContain("Frequently used");
    expect(markup).toContain("198.51.100.xxx");
    expect(markup).not.toContain("198.51.100.27");
  });
});
