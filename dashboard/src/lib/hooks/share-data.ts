import { shareCodeMessage } from "../helpers";
import { useCallback, useEffect, useState } from "react";

export interface ShareAccessModel {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly wireFamily: string;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly reasoning: boolean;
  readonly toolCall: boolean;
  readonly vision: boolean;
  readonly webSearch: boolean;
  readonly source: string | null;
}

export interface ShareUsageTotals {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ShareUsageModel {
  readonly providerId: string | null;
  readonly modelId: string;
  readonly retainedRequests: number;
  readonly retainedErrors: number;
  readonly retainedTokens: number;
  readonly todayRequests: number;
  readonly todayErrors: number;
  readonly todayTokens: number;
}

export interface ShareUsageRequest {
  readonly requestId: string;
  readonly startedAt: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: string;
  readonly httpStatus?: number;
  readonly errorCategory?: string;
  readonly clientIp?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ShareUsageActivity {
  readonly allTime: ShareUsageTotals;
  readonly lastUsedAt: string | null;
  readonly models: readonly ShareUsageModel[];
  readonly requests: readonly ShareUsageRequest[];
  readonly series: readonly {
    readonly day: string;
    readonly requests: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  }[];
}

export interface ShareEnrollmentData {
  readonly name: string;
  readonly keyPrefix: string | null;
  /**
   * Absolute base URL a recipient should configure, when the operator set
   * `LIANROUTER_PUBLIC_BASE_URL`. `null` means the page's own origin is
   * correct — the gateway is reachable at the address that served the page.
   */
  readonly apiBaseUrl: string | null;
  readonly canIssue: boolean;
  readonly alreadyIssued: boolean;
  /**
   * True when the active child still stores its encrypted secret, so a
   * locked-out device can re-reveal it. False for keys minted before the
   * reveal feature existed — auto-recovery would spin forever on those.
   */
  readonly recoverable: boolean;
  readonly dailyLimit: number | null;
  readonly monthlyLimit: number | null;
  readonly oneTimeLimit: number | null;
  readonly requestsPerMinute: number | null;
  readonly maxConcurrentRequests: number | null;
  readonly providerAllowlist: string[] | null;
  readonly models: readonly ShareAccessModel[];
  /**
   * True when the template names specific models but its provider allowlist
   * excludes every one of them, so the resolved list is empty. Lets the page
   * name the misconfiguration instead of implying open access.
   */
  readonly policyConflict: boolean;
  readonly modelDenylist: string[] | null;
  readonly modelPrefix: string | null;
  readonly notes: { readonly title: string | null; readonly subtitle: string | null; readonly body: string | null };
  readonly expiresAt: string | null;
  readonly activity: ShareUsageActivity;
}

interface ShareDataState<TData> {
  readonly data: TData | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => void;
}

interface ShareErrorResponse {
  readonly error?: string | { readonly code?: string; readonly message?: string };
  readonly message?: string;
}

function errorMessage(payload: ShareErrorResponse, fallback: string): string {
  const rawError = payload.error;
  const code = typeof rawError === "string" ? rawError : rawError?.code;
  return shareCodeMessage(code) ?? (typeof rawError === "string" ? rawError : rawError?.message) ?? payload.message ?? fallback;
}

/**
 * Loads the public enrollment contract without caching response bodies.
 *
 * Re-reads when the tab becomes visible again, because `alreadyIssued` is
 * decided per client IP and changes as a consequence of *someone else's*
 * action: a second visitor on the same address claiming a key flips it while
 * this page sits open. The visitor cannot know to refresh, and without the
 * re-read the page keeps offering a button whose request comes back 409.
 *
 * The refresh is silent — it never returns to the loading state — because
 * replacing the whole panel with a skeleton on every tab switch would be a
 * worse experience than the staleness it prevents. A failed silent refresh
 * keeps the last good data; a *rejected* one does not, since a revoked or
 * expired link must be able to say so.
 */
export function useShareData<TData>(path: string): ShareDataState<TData> {
  const [state, setState] = useState<Omit<ShareDataState<TData>, "refresh">>({ data: null, error: null, loading: true });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let controller: AbortController | null = null;

    const load = (silent: boolean): void => {
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      void fetch(path, { signal: controller.signal, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" })
        .then(async (response) => {
          const payload = await response.json() as TData | ShareErrorResponse;
          if (!active) return;
          if (!response.ok) {
            setState({ data: null, error: errorMessage(payload as ShareErrorResponse, "This enrollment link is unavailable."), loading: false });
            return;
          }
          setState({ data: payload as TData, error: null, loading: false });
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          // A silent refresh that merely failed to reach the gateway must not
          // wipe a policy the visitor is reading.
          if (active && !silent) {
            setState({ data: null, error: "Unable to reach the LianRouter gateway.", loading: false });
          }
        })
        .finally(() => {
          inFlight = false;
          controller = null;
        });
    };

    load(false);

    const onVisible = (): void => {
      if (document.visibilityState === "visible") load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      active = false;
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [path, revision]);
  return { ...state, refresh };
}
