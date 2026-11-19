import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
// Console-owned device-poll DTO; token material remains provider-internal.
import type { AccountHealthEventRecord, ByokConnectionTestRequest, ByokConnectionTestResult, CreateProviderAccountRequest, CreateProviderRequest, OAuthDevicePollResponse as OAuthDevicePollResult, ProbeAllAccountsResult, ProbeModelRequest, ProbeModelResult, ProviderAccountResponse, ProviderAccountsExportResponse, ProviderResponse, SetModelEnabledRequest, UpdateProviderAccountRequest, UpdateProviderRequest } from "../contracts";
import { queryKeys } from "../query-keys";
import { QUERY_OPTIONS, assertModels, assertProviders, querySignal } from "./common";
import { getErrorMessage } from "../helpers";
import { toast } from "../toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";


/** Loads the tenant provider catalog. */
export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers.all,
    queryFn: (context) =>
      consoleRequest<unknown>("/providers", { signal: querySignal(context) }).then(assertProviders),
    ...QUERY_OPTIONS,
  });
}

/** Loads models for one provider; no request is made until a provider is selected. */
export function useProviderModels(providerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.providers.models(providerId),
    queryFn: (context) => {
      if (!providerId) throw { status: 400, code: "invalid_request", message: "Provider is required" } satisfies ApiErrorShape;
      return consoleRequest<unknown>(`/providers/${encodeURIComponent(providerId)}/models`, {
        signal: querySignal(context),
      }).then(assertModels);
    },
    ...QUERY_OPTIONS,
    enabled: Boolean(providerId),
  });
}

/** Manually registers additional models on an existing provider (no upstream call). */
export function useRegisterProviderModels() {
  const queryClient = useQueryClient();
  return useMutation<
    { registered: number },
    ApiErrorShape,
    { providerId: string; modelIds: readonly string[]; wireFamily?: string }
  >({
    mutationFn: ({ providerId, modelIds, wireFamily }) =>
      consoleRequest<{ registered: number }>(
        `/providers/${encodeURIComponent(providerId)}/models`,
        {
          method: "POST",
          body: JSON.stringify({ modelIds, ...(wireFamily ? { wireFamily } : {}) }),
        },
      ),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providers.models(variables.providerId),
      });
      toast.success("Models registered", `${variables.modelIds.length} model(s) added to ${variables.providerId}`);
    },
    onError: (error) => {
      toast.error("Failed to register models", getErrorMessage(error));
    },
  });
}

/** Probes a model's connectivity through the real provider adapter; records
 * the outcome into telemetry. Works for a not-yet-registered candidate id
 * (pass `wireFamily`) or an already-registered model (pass `route`). */
export function useProbeModel() {
  const queryClient = useQueryClient();
  return useMutation<
    ProbeModelResult,
    ApiErrorShape,
    { providerId: string; request: ProbeModelRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<ProbeModelResult>(
        `/providers/${encodeURIComponent(providerId)}/models/probe`,
        {
          method: "POST",
          body: JSON.stringify(request),
        },
      ),
    // A probe writes account health (cooldown on quota failure, recover on
    // success), so the account list + health panels must refetch the moment it
    // settles — success AND failure. Deliberately fire-and-forget: `execute()`
    // awaits `onSettled`, so awaiting the refetch would keep the mutation's
    // promise (and every probe slot) hostage to a full account-list refresh.
    onSettled: (_result, _error, variables) => {
      void invalidateProviderAccounts(queryClient, variables.providerId).catch(() => undefined);
    },
  });
}
/**
 * Ad-hoc connectivity test for an operator-entered custom provider that has
 * not been saved yet. Probes `GET <base>/models` with the credential header
 * the chosen wire family reads, so the modal can validate the base URL and API
 * key before persisting anything. No cache invalidation: nothing is created.
 */
export function useTestByokConnection() {
  return useMutation<ByokConnectionTestResult, ApiErrorShape, ByokConnectionTestRequest>({
    mutationFn: (request) =>
      consoleRequest<ByokConnectionTestResult>("/providers/connection-test", {
        method: "POST",
        body: JSON.stringify(request),
      }),
  });
}

/** Probes one explicit model against every configured account for a provider. */
export function useProbeAllProviderAccounts() {
  const queryClient = useQueryClient();
  return useMutation<
    ProbeAllAccountsResult,
    ApiErrorShape,
    { providerId: string; request: ProbeModelRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<ProbeAllAccountsResult>(
        `/providers/${encodeURIComponent(providerId)}/accounts/probe`,
        { method: "POST", body: JSON.stringify(request) },
      ),
    onSettled: async (_result, _error, variables) => {
      await invalidateProviderAccounts(queryClient, variables.providerId);
    },
  });
}

/** Enables or disables one registered model — a hard routing invariant, not a display flag. */
export function useSetModelEnabled() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean },
    ApiErrorShape,
    { providerId: string; request: SetModelEnabledRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<{ success: boolean }>(`/providers/${encodeURIComponent(providerId)}/models`, {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providers.models(variables.providerId),
      });
    },
  });
}
/** Deletes one registered model from a provider catalog. */
export function useDeleteProviderModel() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean },
    ApiErrorShape,
    { providerId: string; request: { modelId: string; route: string } }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<{ success: boolean }>(`/providers/${encodeURIComponent(providerId)}/models`, {
        method: "DELETE",
        body: JSON.stringify(request),
      }),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providers.models(variables.providerId),
      });
    },
  });
}

/** Loads accounts configured for one provider. */
export function useProviderAccounts(providerId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.providers.accounts(providerId),
    queryFn: (context) =>
      consoleRequest<ProviderAccountResponse[]>(
        `/providers/${encodeURIComponent(providerId ?? "")}/accounts`,
        { signal: querySignal(context) },
      ),
    enabled: Boolean(providerId),
    ...QUERY_OPTIONS,
  });
}

/** Creates a provider account. */
export function useCreateProviderAccount() {
  const queryClient = useQueryClient();
  return useMutation<
    ProviderAccountResponse,
    ApiErrorShape,
    { providerId: string; request: CreateProviderAccountRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<ProviderAccountResponse>(
        `/providers/${encodeURIComponent(providerId)}/accounts`,
        { method: "POST", body: JSON.stringify(request) },
      ),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(variables.providerId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Updates a provider account. */
export function useUpdateProviderAccount() {
  const queryClient = useQueryClient();
  return useMutation<
    ProviderAccountResponse,
    ApiErrorShape,
    { providerId: string; accountId: string; request: UpdateProviderAccountRequest }
  >({
    mutationFn: ({ providerId, accountId, request }) =>
      consoleRequest<ProviderAccountResponse>(
        `/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`,
        { method: "PATCH", body: JSON.stringify(request) },
      ),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(variables.providerId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/** Loads health transition event history for one account. */
export function useAccountHealthEvents(
  providerId: string | undefined,
  accountId: string | undefined,
) {
  return useQuery({
    queryKey: queryKeys.providers.healthEvents(providerId, accountId),
    queryFn: (context) =>
      consoleRequest<AccountHealthEventRecord[]>(
        `/providers/${encodeURIComponent(providerId ?? "")}/accounts/${encodeURIComponent(accountId ?? "")}/health-events`,
        { signal: querySignal(context) },
      ),
    enabled: Boolean(providerId) && Boolean(accountId),
    ...QUERY_OPTIONS,
    refetchInterval: 10_000,
  });
}

/**
 * Invalidates every cached account health-event query for one provider.
 * OAuth completion and device-poll success mint or revive accounts outside
 * the account list, so the health-event family must refresh alongside it.
 */
async function invalidateAccountHealthFamily(
  queryClient: QueryClient,
  providerId: string,
): Promise<void> {
  await queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey;
      return (
        key[0] === "console" &&
        key[1] === "providers" &&
        key[2] === providerId &&
        key[3] === "accounts" &&
        key[5] === "health-events"
      );
    },
  });
}

/**
 * Invalidates every cached query a provider-account mutation can stale: the
 * account list, the health-event family, and the provider list itself. Four
 * mutations used to spell this trio out separately, so a fifth could silently
 * forget one and leave a stale list on screen.
 */
export async function invalidateProviderAccounts(
  queryClient: QueryClient,
  providerId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(providerId) }),
    invalidateAccountHealthFamily(queryClient, providerId),
    queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
  ]);
}

/** Manually recovers an account from cooldown back to active. */
export function useRecoverAccount() {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean },
    ApiErrorShape,
    { providerId: string; accountId: string }
  >({
    mutationFn: ({ providerId, accountId }) =>
      consoleRequest<{ success: boolean }>(
        `/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}/recover`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.providers.accounts(variables.providerId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.providers.healthEvents(variables.providerId, variables.accountId),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
      ]);
    },
  });
}

/**
 * Exports the selected accounts (with decrypted credentials) for one provider.
 * Returns the raw export body so the caller owns the download step; a mutation
 * (not a query) because the payload carries plaintext secrets and must never be
 * cached or auto-refetched.
 */
export function useExportProviderAccounts() {
  return useMutation<
    ProviderAccountsExportResponse,
    ApiErrorShape,
    { providerId: string; accountIds: string[] }
  >({
    mutationFn: ({ providerId, accountIds }) =>
      consoleRequest<ProviderAccountsExportResponse>(
        `/providers/${encodeURIComponent(providerId)}/accounts/export`,
        { method: "POST", body: JSON.stringify({ accountIds }) },
      ),
  });
}


export interface OAuthAuthorizeResult {
  readonly authorizeUrl: string;
  readonly state: string;
}

/** Begins the browser OAuth login flow for a provider account; caller opens `authorizeUrl` in a popup. */
/** Authorize-start response: the vendor URL, its signed state, and the challenge. */
export interface AutoClawAuthorizeResult {
  readonly url: string;
  readonly state: string;
  readonly captcha: {
    readonly enabled: boolean;
    readonly region: string;
    readonly prefix: string;
    readonly sceneId: string;
    readonly supplier: string;
  };
}

/** The Aliyun challenge the AutoClaw authorize step demands. */
export interface AutoClawCaptchaConfig {
  readonly enabled: boolean;
  readonly region: string;
  readonly prefix: string;
  readonly sceneId: string;
  readonly supplier: string;
}

/**
 * Reads the challenge before a login is attempted.
 *
 * `useStartAutoClawAuthorize` cannot succeed without it whenever the gate is
 * on, and the vendor's own answer to a bare attempt is an error rather than the
 * challenge parameters — so the dialog reads this first and only then offers
 * the button that starts the flow.
 */
export function useAutoClawCaptchaConfig(enabled = true) {
  return useQuery({
    queryKey: queryKeys.providers.autoClawCaptcha(),
    queryFn: (context) =>
      consoleRequest<AutoClawCaptchaConfig>("/providers/autoclaw/oauth/captcha", {
        signal: querySignal(context),
      }),
    enabled,
    ...QUERY_OPTIONS,
    retry: false,
  });
}

/** Starts an AutoClaw login; `captchaVerifyParam` is required when the gate is on. */
export function useStartAutoClawAuthorize() {
  return useMutation<
    AutoClawAuthorizeResult,
    ApiErrorShape,
    { captchaVerifyParam?: string; accountLabel?: string }
  >({
    mutationFn: ({ captchaVerifyParam, accountLabel }) =>
      consoleRequest<AutoClawAuthorizeResult>("/providers/autoclaw/oauth/authorize", {
        method: "POST",
        body: JSON.stringify({
          ...(captchaVerifyParam ? { captchaVerifyParam } : {}),
          ...(accountLabel ? { accountLabel } : {}),
        }),
      }),
  });
}

/**
 * Redeems the code AutoClaw's callback carries.
 *
 * Separate from `useCompleteOAuthBrowserLogin` because that hook posts to the
 * generic callback route, which exchanges against a locally generated state —
 * rejected by AutoClaw's gateway. `state` here must be the vendor-minted value
 * the authorize step returned.
 */
export function useCompleteAutoClawLogin() {
  const queryClient = useQueryClient();
  return useMutation<
    { accountId: string },
    ApiErrorShape,
    { code: string; state: string; accountLabel?: string }
  >({
    mutationFn: ({ code, state, accountLabel }) =>
      consoleRequest<{ accountId: string }>("/providers/autoclaw/oauth/complete", {
        method: "POST",
        body: JSON.stringify({ code, state, ...(accountLabel ? { accountLabel } : {}) }),
      }),
    onSuccess: async () => {
      await invalidateProviderAccounts(queryClient, "autoclaw");
    },
  });
}

/**
 * Stores a token obtained from the AutoClaw desktop app.
 *
 * The OAuth route needs a captcha token that is bound to the browser's IP, so a
 * headless deployment cannot mint one on the operator's behalf. This path needs
 * no challenge: the server verifies the pasted value against the gateway and
 * rejects it if the credential is not live.
 */
export function useImportAutoClawToken() {
  const queryClient = useQueryClient();
  return useMutation<
    { accountId: string },
    ApiErrorShape,
    { token: string; accountLabel?: string }
  >({
    mutationFn: ({ token, accountLabel }) =>
      consoleRequest<{ accountId: string }>("/providers/autoclaw/oauth/token", {
        method: "POST",
        body: JSON.stringify({ token, ...(accountLabel ? { accountLabel } : {}) }),
      }),
    onSuccess: async () => {
      await invalidateProviderAccounts(queryClient, "autoclaw");
    },
  });
}

export function useStartOAuthAuthorize() {
  return useMutation<
    OAuthAuthorizeResult,
    ApiErrorShape,
    { providerId: string; accountLabel?: string }
  >({
    mutationFn: ({ providerId, accountLabel }) =>
      consoleRequest<OAuthAuthorizeResult>(
        `/providers/${encodeURIComponent(providerId)}/oauth/authorize`,
        { method: "POST", body: JSON.stringify(accountLabel ? { accountLabel } : {}) },
      ),
  });
}

/**
 * Completes a browser OAuth login using a `code` copied by hand from the
 * provider's redirect URL. Required whenever that redirect points at the
 * fixed loopback address (`http://127.0.0.1:59653/callback`) the dashboard can
 * never reach directly — the code/state pair still round-trips through the
 * same server-side callback route the automatic redirect would have hit.
 */
export function useCompleteOAuthBrowserLogin() {
  const queryClient = useQueryClient();
  return useMutation<
    { message?: string },
    ApiErrorShape,
    { providerId: string; code: string; state: string }
  >({
    mutationFn: ({ providerId, code, state }) =>
      consoleRequest<{ message?: string; providerId?: string }>(
        `/providers/${encodeURIComponent(providerId)}/oauth/callback?${new URLSearchParams({ code, state }).toString()}`,
      ),
    onSuccess: async (_result, variables) => {
      await invalidateProviderAccounts(queryClient, variables.providerId);
    },
  });
}

export interface OAuthDeviceStartResult {
  readonly verificationUri: string;
  readonly userCode: string;
  readonly deviceAuthId: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
}

/** Begins the device-code OAuth login flow for providers that support it. */
export function useStartOAuthDevice() {
  return useMutation<
    OAuthDeviceStartResult,
    ApiErrorShape,
    { providerId: string; accountLabel?: string }
  >({
    mutationFn: ({ providerId, accountLabel }) =>
      consoleRequest<OAuthDeviceStartResult>(
        `/providers/${encodeURIComponent(providerId)}/oauth/device/start`,
        { method: "POST", body: JSON.stringify(accountLabel ? { accountLabel } : {}) },
      ),
  });
}

export type { OAuthDevicePollResult };

/** Polls one device-code authorization attempt; invalidates accounts once complete. */
export function usePollOAuthDevice() {
  const queryClient = useQueryClient();
  return useMutation<
    OAuthDevicePollResult,
    ApiErrorShape,
    { providerId: string; deviceAuthId: string }
  >({
    mutationFn: ({ providerId, deviceAuthId }) =>
      consoleRequest<OAuthDevicePollResult>(
        `/providers/${encodeURIComponent(providerId)}/oauth/device/poll`,
        { method: "POST", body: JSON.stringify({ deviceAuthId }) },
      ),
    onSuccess: async (result, variables) => {
      if (result.status === "complete") {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.providers.accounts(variables.providerId),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.providers.healthEvents(variables.providerId, result.accountId),
          }),
          // A new OAuth account changes the provider row (accountCount) and
          // gains quota rows immediately; keep both trees fresh so the
          // Providers table and Quota panel reflect the completed exchange.
          queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
          // Shares the cluster's three keys with every other account mutation,
          // plus the one extra tree this path needs (the quota panel).
          invalidateProviderAccounts(queryClient, variables.providerId),
        ]);
      }
    },
  });
}

export interface OAuthLoopbackStartResult {
  readonly state: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly authorizeBase: string;
  readonly scope: string;
  readonly clientId: string;
  readonly extra: Record<string, string>;
  readonly ttlSeconds: number;
  readonly shellSnippet: string;
  readonly helperScriptUrl: string;
}

/**
 * Begins the Antigravity-only loopback OAuth flow. The server reserves a
 * `state` + PKCE pair and returns a ready-to-paste shell snippet; the
 * operator runs the snippet on their own machine, which starts a local HTTP
 * server to catch Google's loopback redirect and POSTs the resulting code
 * back to `/oauth/loopback/complete`. Google's Desktop OAuth client type
 * only accepts `http://127.0.0.1:*` redirects, which the hosted dashboard
 * cannot provide on its own; this hook powers the UI that bridges that gap.
 */
export function useStartOAuthLoopback() {
  return useMutation<
    OAuthLoopbackStartResult,
    ApiErrorShape,
    { providerId: string; accountLabel?: string }
  >({
    mutationFn: ({ providerId, accountLabel }) =>
      consoleRequest<OAuthLoopbackStartResult>(
        `/providers/${encodeURIComponent(providerId)}/oauth/loopback/start`,
        { method: "POST", body: JSON.stringify(accountLabel ? { accountLabel } : {}) },
      ),
  });
}

/** Creates a custom provider and refreshes all provider-derived views. */
export function useCreateProvider() {
  const queryClient = useQueryClient();
  return useMutation<ProviderResponse, ApiErrorShape, CreateProviderRequest>({
    mutationFn: (request) =>
      consoleRequest<ProviderResponse>("/providers", {
        method: "POST",
        body: JSON.stringify(request),
      }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.all }),
      ]);
      toast.success("Provider created", result.label ?? result.providerId);
    },
    onError: (error) => {
      toast.error("Failed to create provider", getErrorMessage(error));
    },
  });
}

export function useUpdateProvider() {
  const queryClient = useQueryClient();
  return useMutation<
    ProviderResponse,
    ApiErrorShape,
    { providerId: string; request: UpdateProviderRequest }
  >({
    mutationFn: ({ providerId, request }) =>
      consoleRequest<ProviderResponse>(`/providers/${encodeURIComponent(providerId)}`, {
        method: "PATCH",
        body: JSON.stringify(request),
      }),
    onSuccess: async (_result, { providerId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.detail(providerId) }),
      ]);
      toast.success("Provider updated", providerId);
    },
    onError: (error) => {
      toast.error("Failed to update provider", getErrorMessage(error));
    },
  });
}

/** Enables or disables a global builtin provider for platform administrators. */
export function useUpdateGlobalProvider() {
  const queryClient = useQueryClient();
  return useMutation<
    ProviderResponse,
    ApiErrorShape,
    { providerId: string; enabled: boolean }
  >({
    mutationFn: ({ providerId, enabled }) =>
      consoleRequest<ProviderResponse>(
        `/providers/platform/global/${encodeURIComponent(providerId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        },
      ),
    onSuccess: async (_result, { providerId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.detail(providerId) }),
      ]);
    },
  });
}

/** Synchronizes one provider's model catalog when the session has platform admin scope. */
export function useSyncProviderModels() {
  const queryClient = useQueryClient();
  return useMutation<{ synced: number }, ApiErrorShape, string>({
    mutationFn: (providerId) =>
      consoleRequest<{ synced: number }>(
        `/providers/${encodeURIComponent(providerId)}/models/sync`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: async (_result, providerId) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers.models(providerId) });
    },
  });
}

/** Deletes a provider (custom only). */
export function useDeleteProvider() {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, ApiErrorShape, string>({
    mutationFn: (providerId) =>
      consoleRequest<{ success: boolean }>(`/providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      }),
    onSuccess: async (_result, providerId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.modelRouting.all }),
      ]);
      toast.success("Provider deleted", providerId);
    },
    onError: (error) => {
      toast.error("Failed to delete provider", getErrorMessage(error));
    },
  });
}
/** One claimable campaign advertised for a start-plan account. */
export interface ProviderClaimPlan {
  readonly planId: string;
  readonly name: string;
  readonly priority: number | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly source: "preview" | "banner";
}

/** The campaign surfaces for one account, with any read failures. */
export interface ProviderClaimListing {
  readonly plans: ProviderClaimPlan[];
  readonly errors: string[];
  readonly supported?: boolean;
}

/** Reads the campaigns an account can claim. */
export function useProviderClaims(accountId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.providers.claims(accountId),
    queryFn: (context) =>
      consoleRequest<ProviderClaimListing>(
        `/accounts/${encodeURIComponent(accountId ?? "")}/claims`,
        { signal: querySignal(context) },
      ),
    enabled: Boolean(accountId) && enabled,
    ...QUERY_OPTIONS,
  });
}

/** The Aliyun captcha the claim endpoint expects for one account. */
export interface ProviderClaimVerificationConfig {
  readonly enabled: boolean;
  readonly region: string;
  readonly prefix: string;
  readonly sceneId: string;
  readonly skipModelRequest: boolean;
}

/**
 * Reads the captcha config for one account.
 *
 * The claim endpoint refuses a bare claim with `3007`, and the only way past it
 * is a token produced by the Aliyun widget loaded with these values. Without
 * this read the dashboard has nothing to render, which is why the claim used to
 * end in "finish it in the desktop app".
 */
export function useProviderClaimVerification(accountId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.providers.claimVerification(accountId),
    queryFn: (context) =>
      consoleRequest<{ ok: boolean; config: ProviderClaimVerificationConfig }>(
        `/accounts/${encodeURIComponent(accountId ?? "")}/claims/verification`,
        { signal: querySignal(context) },
      ),
    enabled: Boolean(accountId) && enabled,
    // A refused config read is a real state (the vendor may simply not gate
    // this campaign); retrying it just re-reads the same answer.
    ...QUERY_OPTIONS,
    retry: false,
  });
}

/**
 * Claims one campaign.
 *
 * The upstream endpoint is captcha-gated for the campaigns that matter, so a
 * `409 claim_captcha_required` is a real answer rather than a failure: the
 * campaign exists and the credential works, and the claim has to be finished in
 * the desktop app.
 */
export function useClaimProviderPlan() {
  const queryClient = useQueryClient();
  return useMutation<
    { ok: boolean; status: string; planId: string; message?: string },
    ApiErrorShape,
    { accountId: string; planId: string; captchaParam?: string; captchaRegion?: string }
  >({
    mutationFn: ({ accountId, planId, captchaParam, captchaRegion }) =>
      consoleRequest<{ ok: boolean; status: string; planId: string; message?: string }>(
        `/accounts/${encodeURIComponent(accountId)}/claims`,
        {
          method: "POST",
          body: JSON.stringify({
            planId,
            ...(captchaParam ? { captchaParam } : {}),
            ...(captchaRegion ? { captchaRegion } : {}),
          }),
        },
      ),
    onSuccess: async (result, variables) => {
      if (result.ok) toast.success("Plan claimed", variables.planId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.providers.claims(variables.accountId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
      ]);
    },
    onError: (error, variables) => {
      // A captcha-gated campaign is a non-2xx, so it lands here rather than in
      // onSuccess: the campaign exists and the credential works, and the claim
      // has to be finished where a human can solve the challenge.
      if (error.code === "claim_captcha_required") {
        toast.error("Captcha required", "Solve the challenge, then claim again.");
        return;
      }
      // The vendor throttles repeated claims. Saying "rejected" here would read
      // as "this plan is gone", when all that expired was the rate window.
      if (error.code === "claim_rate_limited") {
        toast.error("Claim throttled by ZCode", "The campaign is still live — wait a moment and claim again.");
        return;
      }
      toast.error("Claim rejected", `${variables.planId}: ${getErrorMessage(error)}`);
    },
  });
}
