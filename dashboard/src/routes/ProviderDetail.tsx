import {
  Boxes,
  Cable,
  ExternalLink,
  FlaskConical,
  KeyRound,
  Pencil,
  LockOpen,
  PackageX,
  Plus,
  PowerOff,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { consoleRequest } from "../lib/api";
import { ProviderIcon } from "../components/ProviderIcon";
import { EditProviderModal } from "./Providers";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { BackLink, PageHeader } from "../components/ui/page-header";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import {
  useProbeAllProviderAccounts,
  useProviderAccounts,
  useProviderModels,
  useProviders,
  useStartOAuthAuthorize,
  useStartAutoClawAuthorize,
  useStartOAuthLoopback,
  useSyncProviderModels,
  useUpdateGlobalProvider,
} from "../lib/hooks/providers";
import { queryKeys } from "../lib/query-keys";
import { providerDisplayName } from "../lib/provider-names";
import { toast } from "../lib/toast";
import type { ProviderAccountResponse } from "../lib/contracts";
import { RoutingStrategyCard } from "./provider-detail/RoutingStrategyCard";
import { AccountsList, AddAccountModal } from "./provider-detail/Accounts";
import {
  DeviceCodeDialog,
  OAuthBrowserDialog,
  OAuthLoopbackDialog,
} from "./provider-detail/OAuthDialogs";
import { AutoClawCaptchaDialog } from "./provider-detail/AutoClawCaptchaDialog";
import {
  CreditBalanceCard,
  supportsCreditBalance,
} from "./provider-detail/CreditBalanceCard";
import { AutoClawTokenDialog } from "./provider-detail/AutoClawTokenDialog";
import { AddModelModal, ModelGrid } from "./provider-detail/Models";
import { ClaimPlansCard, supportsPlanClaims } from "./provider-detail/ClaimPlansCard";

export default function ProviderDetail(): ReactNode {
  const { providerId } = useParams<{ providerId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const notificationAccountId = searchParams.get("account");
  const id = providerId ?? "";
  const providersQuery = useProviders();
  const modelsQuery = useProviderModels(id);
  const accountsQuery = useProviderAccounts(id);
  const syncModels = useSyncProviderModels();
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const probeAllAccounts = useProbeAllProviderAccounts();
  const updateGlobalProvider = useUpdateGlobalProvider();
  const startAuthorize = useStartOAuthAuthorize();
  const startAutoClawAuthorize = useStartAutoClawAuthorize();
  const startLoopback = useStartOAuthLoopback();
  const queryClient = useQueryClient();
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [editProviderOpen, setEditProviderOpen] = useState(false);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false);
  const [autoClawTokenOpen, setAutoClawTokenOpen] = useState(false);
  const [autoClawCaptchaOpen, setAutoClawCaptchaOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProviderAccountResponse | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [oauthBrowserSession, setOauthBrowserSession] = useState<{
    authorizeUrl: string;
    state: string;
    popup: Window;
  } | null>(null);
  // An AutoClaw re-login targets a specific stale account: once the fresh login
  // lands, this id is deleted so the replaced credential is not left behind.
  const reloginTargetRef = useRef<string | null>(null);
  const reloginCleanupRef = useRef<(() => Promise<void>) | null>(null);
  const [oauthLoopbackSession, setOauthLoopbackSession] = useState<{
    shellSnippet: string;
    helperScriptUrl: string;
    ttlSeconds: number;
  } | null>(null);
  // Tracks the OAuth popup outside React state so it can be closed on
  // authorize error or component unmount even if the session never sets.
  const oauthPopupRef = useRef<Window | null>(null);

  useEffect(
    () => () => {
      const popup = oauthPopupRef.current;
      oauthPopupRef.current = null;
      if (popup && !popup.closed) popup.close();
    },
    [],
  );

  const provider = (providersQuery.data ?? []).find((item) => item.providerId === id);
  const accounts = accountsQuery.data ?? [];
  const notificationAccount = accounts.find((account) => account.id === notificationAccountId);
  const visibleAccounts = notificationAccount ? [notificationAccount] : accounts;
  const models = modelsQuery.data ?? [];
  // and sort alphabetically so enable/disable doesn't jump the layout.
  const deduped = (() => {
    const seen = new Map<string, (typeof models)[number]>();
    for (const m of models) {
      const existing = seen.get(m.modelId);
      if (!existing) seen.set(m.modelId, m);
      else {
        // Prefer the one with larger context (builtin over discovered)
        const existingCtx = existing.contextLimit ?? 0;
        const nextCtx = m.contextLimit ?? 0;
        if (nextCtx > existingCtx) seen.set(m.modelId, m);
      }
    }
    return [...seen.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
  })();
  const stableModels = deduped;

  if (providersQuery.isPending) return <LoadingState label="Loading provider..." />;
  // A failed catalog load is NOT a missing provider. Without this branch a 500
  // rendered "Provider not found", which sends the operator looking for a
  // deleted provider instead of at the outage in front of them.
  if (providersQuery.isError)
    return (
      <ErrorState
        title="Unable to load providers"
        message="The provider catalog could not be read, so this page cannot resolve its provider."
        onRetry={() => void providersQuery.refetch()}
        retrying={providersQuery.isFetching}
        action={<BackLink to="/providers" label="Back to providers" />}
      />
    );
  if (!provider)
    return (
      <EmptyState
        icon={<PackageX size={20} />}
        title="Provider not found"
        message={`No provider named “${id}”. It may have been removed, or the link is stale.`}
        action={<BackLink to="/providers" label="Back to providers" />}
      />
    );

  const activeAccounts = accounts.filter((a) => a.status === "active").length;

  /**
   * AutoClaw signs its own OAuth `state`, so the generic browser-code route
   * cannot build its URL — it would hand back a link the exchange rejects. This
   * path asks the AutoClaw route for both the URL and the state the vendor
   * minted, then hands the URL to the challenge window.
   *
   * The challenge window navigates itself. The earlier version pre-opened an
   * `about:blank` tab and assigned `location.href` from here once the authorize
   * URL arrived — but that step only ran when the solved token reached the
   * dashboard, and delivery went through `window.opener` alone. Without an opener
   * the token was dropped, so the placeholder was never navigated and the
   * operator was left looking at a blank tab. The captcha page now listens for
   * `autoclaw-oauth-captcha:redirect` and calls `location.assign` itself, which is
   * what the vendor's own desktop client does.
   */
  const handleAutoClawOAuth = (captchaVerifyParam?: string, challengeWindow?: Window | null) => {
    const challenge = challengeWindow ?? oauthPopupRef.current;
    const navigateChallenge = (url: string): boolean => {
      if (challenge === null || challenge.closed) return false;
      challenge.postMessage(
        { type: "autoclaw-oauth-captcha:redirect", url },
        window.location.origin,
      );
      return true;
    };
    startAutoClawAuthorize.mutate(
      { ...(captchaVerifyParam ? { captchaVerifyParam } : {}), accountLabel: provider?.label ?? "AutoClaw" },
      {
        onSuccess: ({ url, state }) => {
          const delivered = navigateChallenge(url);
          // No challenge window (gate disabled, or it was closed): fall back to a
          // plain popup opened outside a gesture, which may be blocked — the
          // caller then gets the explicit "popup blocked" toast instead of a
          // silent blank tab.
          const target = delivered
            ? challenge
            : window.open(url, "lianrouter-oauth", "popup,width=720,height=820");
          if (!target) {
            toast.error("Popup blocked", "Allow popups to complete OAuth login.");
            return;
          }
          if (!delivered) oauthPopupRef.current = target;
          setOauthBrowserSession({ authorizeUrl: url, state, popup: target });
        },
        onError: (err: unknown) => {
          if (challenge !== null && !challenge.closed) challenge.close();
          if (oauthPopupRef.current === challenge) oauthPopupRef.current = null;
          const message =
            err && typeof err === "object" && "message" in err && typeof err.message === "string"
              ? err.message
              : "Unable to start AutoClaw authorization";
          toast.error("Failed to start OAuth", message);
        },
      },
    );
  };

  /**
   * Re-login for one AutoClaw account: the same captcha + authorize flow, with
   * the stale row deleted once the replacement is confirmed by the account
   * watcher in OAuthBrowserDialog. Deleting eagerly would leave the provider
   * with zero working accounts if the new login is abandoned.
   */
  const handleAutoClawRelogin = (account: { id: string; label: string | null }) => {
    reloginTargetRef.current = account.id;
    reloginCleanupRef.current = async () => {
      const targetId = reloginTargetRef.current;
      reloginTargetRef.current = null;
      if (!targetId) return;
      try {
        await consoleRequest(`/accounts/${encodeURIComponent(targetId)}`, { method: "DELETE" });
        await queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(id) });
        toast.success("Old credential replaced", account.label || targetId.slice(0, 8));
      } catch (err) {
        toast.error(
          "Could not remove the old account",
          (err as { message?: string }).message ?? "Delete failed after re-login",
        );
      }
    };
    // The authorize step is captcha-gated exactly like the first login, so the
    // widget dialog has to run first; calling the authorize handler directly
    // answers 400001 before a URL can even be minted. No placeholder tab is
    // opened here — the challenge window itself becomes the login window.
    oauthPopupRef.current = null;
    setAutoClawCaptchaOpen(true);
  };
  const handleOAuthBrowser = () => {
    if (id === "autoclaw") {
      // The vendor will not mint a URL without a solved challenge, so the flow
      // starts with the widget; its window is the one that later navigates to the
      // login page, so nothing is opened here.
      oauthPopupRef.current = null;
      setAutoClawCaptchaOpen(true);
      return;
    }
    // Opened synchronously in the click handler so popup blockers allow it.
    // `opener` is severed (noopener equivalent) while retaining the handle
    // needed to navigate/close the window; `window.open` with a literal
    // `noopener` feature would return null instead.
    const blankPopup = window.open("about:blank", "lianrouter-oauth", "popup,width=720,height=820");
    if (blankPopup) {
      blankPopup.opener = null;
      oauthPopupRef.current = blankPopup;
    }
    startAuthorize.mutate(
      { providerId: id },
      {
        onSuccess: ({ authorizeUrl, state }) => {
          let target: Window | null = null;
          if (blankPopup && !blankPopup.closed) {
            blankPopup.location.href = authorizeUrl;
            target = blankPopup;
          } else {
            target = window.open(authorizeUrl, "lianrouter-oauth", "popup,width=720,height=820");
            if (target) {
              target.opener = null;
              oauthPopupRef.current = target;
            }
          }
          if (!target) {
            toast.error("Popup blocked", "Allow popups to complete OAuth login.");
            return;
          }
          setOauthBrowserSession({ authorizeUrl, state, popup: target });
        },
        onError: (err) => {
          if (blankPopup && !blankPopup.closed) blankPopup.close();
          if (oauthPopupRef.current === blankPopup) oauthPopupRef.current = null;
          toast.error(
            "Failed to start OAuth",
            (err as { message?: string }).message ?? "Unable to start authorization",
          );
        },
      },
    );
  };
  const closeOAuthBrowserSession = (completed: boolean) => {
    oauthPopupRef.current = null;
    setOauthBrowserSession(null);
    if (completed) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(id) });
    }
  };
  const handleOAuthLoopback = () => {
    startLoopback.mutate(
      { providerId: id },
      {
        onSuccess: ({ shellSnippet, helperScriptUrl, ttlSeconds }) => {
          setOauthLoopbackSession({ shellSnippet, helperScriptUrl, ttlSeconds });
        },
        onError: (err: unknown) => {
          const message =
            err && typeof err === "object" && "message" in err && typeof err.message === "string"
              ? err.message
              : "Unable to start loopback authorization";
          toast.error("Failed to start loopback flow", message);
        },
      },
    );
  };
  const closeOAuthLoopbackSession = (completed: boolean) => {
    setOauthLoopbackSession(null);
    if (completed) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(id) });
    }
  };
  const runGrokAccountProbe = () => {
    probeAllAccounts.mutate(
      {
        providerId: id,
        request: {
          modelId: "grok-4.6",
          wireFamily: "responses",
          prompt: "Reply with exactly: 407",
          reasoningEffort: "high",
          maxOutputTokens: 1024,
          stream: true,
        },
      },
      {
        onSuccess: (result) => {
          const ok = result.results.filter((entry) => entry.ok).length;
          const rateLimited = result.results.filter((entry) => entry.statusCode === 202).length;
          const failed = result.results.length - ok - rateLimited;
          toast.success(
            "Grok account probe complete",
            `${ok} passed · ${rateLimited} returned 202 and were marked degraded · ${failed} other failures`,
          );
        },
        onError: (error) =>
          toast.error(
            "Grok account probe failed",
            (error as { message?: string }).message ?? "Unable to probe Grok accounts",
          ),
      },
    );
  };
  return (
    <Stack gap="16px">
      <PageHeader
        title={providerDisplayName(provider.providerId, provider.label)}
        description={`${provider.providerId}/${provider.baseUrl ? ` · ${provider.baseUrl}` : ""}`}
        icon={
          <ProviderIcon
            icon={provider.providerId}
            name={providerDisplayName(provider.providerId, provider.label)}
            size={28}
            // The top-level field, not `compatibilityProfile.iconUrl`: this page
            // reads the list row, and only the detail endpoint projects the full
            // profile. `sanitizeProviderResponse` lifts the icon onto every row
            // for exactly this reason, so reading the nested path here showed the
            // initials badge on a provider whose card had the operator's icon.
            iconUrl={typeof provider.iconUrl === "string" ? provider.iconUrl : undefined}
          />
        }
        back={{ to: "/providers", label: "Back to Providers" }}
        actions={
          <Inline gap="8px">
            <Button
              variant="secondary"
              size="sm"
              icon={<FlaskConical size={13} />}
              onClick={() =>
                navigate(`/providers/${encodeURIComponent(id)}/accounts/test`)
              }
              title="Probe every account on this provider — one account at a time, with live pass/fail"
            >
              Test All
            </Button>
            {!provider.isBuiltIn ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Pencil size={13} />}
                onClick={() => setEditProviderOpen(true)}
                title="Edit this provider's name, base URL, wire format, headers, and icon"
              >
                Edit
              </Button>
            ) : null}
            {provider.isBuiltIn ? (
              <Button
                variant={provider.enabled ? "danger" : "secondary"}
                icon={provider.enabled ? <PowerOff size={13} /> : <LockOpen size={13} />}
                loading={updateGlobalProvider.isPending}
                onClick={() =>
                  updateGlobalProvider.mutate(
                    { providerId: id, enabled: !provider.enabled },
                    {
                      onSuccess: (updated) =>
                        toast.success(
                          updated.enabled ? "Provider enabled" : "Provider disabled",
                          providerDisplayName(id, provider.label),
                        ),
                      onError: (err) =>
                        toast.error(
                          "Provider update failed",
                          (err as { message?: string }).message ??
                            "Unable to change provider availability",
                        ),
                    },
                  )
                }
                title={provider.enabled ? "Disable provider globally" : "Enable provider globally"}
              >
                {provider.enabled ? "Disable" : "Enable"}
              </Button>
            ) : null}
          </Inline>
        }

      />
      {/* Routing Strategy */}
      <RoutingStrategyCard providerId={id} />

      {notificationAccount ? (
        <div role="status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "12px 16px", border: "1px solid var(--inner-border)", borderRadius: "var(--radius-control)", background: "var(--surface-2)" }}>
          <span>Notification account: <strong>{notificationAccount.label}</strong></span>
          <Button variant="secondary" size="sm" onClick={() => setSearchParams((previous) => { const next = new URLSearchParams(previous); next.delete("account"); return next; })}>Show all accounts</Button>
        </div>
      ) : null}
      {/* Accounts */}
      {provider.requiresAccount === false ? (
        <Card>
          <CardHeader title="Accounts" icon={<Cable size={16} />} />
          <CardBody>
            <p style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
              This provider is a public, unauthenticated route — no account or credential is
              needed. Routing already works without any setup here.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Accounts"
            subtitle={`${accounts.length} total · ${activeAccounts} active · ${accounts.length - activeAccounts} disabled`}
            icon={<Cable size={16} />}
            action={
              <Inline gap="6px" style={{ flexWrap: "wrap" }}>
                {provider.oauthFlows?.browser && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ExternalLink size={13} />}
                    disabled={startAuthorize.isPending}
                    onClick={handleOAuthBrowser}
                    title="Browser OAuth login — opens the provider authorize page in a popup"
                  >
                    {startAuthorize.isPending ? "Starting..." : "Login with browser"}
                  </Button>
                )}
                {provider.oauthFlows?.device && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<KeyRound size={13} />}
                    onClick={() => setDeviceDialogOpen(true)}
                    title="Device-code login — enter the shown code on the provider site"
                  >
                    Login with device code
                  </Button>
                )}
                {id === "autoclaw" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<KeyRound size={13} />}
                    onClick={() => setAutoClawTokenOpen(true)}
                    title="Add an account by pasting a token from the AutoClaw desktop app. Use this when the browser login cannot reach the server's callback port."
                  >
                    Add with token
                  </Button>
                )}
                {id === "antigravity" && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ExternalLink size={13} />}
                    disabled={startLoopback.isPending}
                    onClick={handleOAuthLoopback}
                    title="Loopback OAuth login — Antigravity's Google client only accepts http://127.0.0.1 callbacks, so this hands you a short shell snippet to run on your own machine"
                  >
                    {startLoopback.isPending ? "Starting..." : "Login via loopback helper"}
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Plus size={13} />}
                  onClick={() => setAddAccountOpen(true)}
                >
                  Add Account
                </Button>
              </Inline>
            }
          />
          <CardBody style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {accountsQuery.isPending ? (
              <LoadingState label="Loading accounts..." />
            ) : accountsQuery.isError ? (
              <ErrorState
                message="Failed to load accounts"
                onRetry={() => accountsQuery.refetch()}
              />
            ) : accounts.length === 0 ? (
              <EmptyState
                title="No accounts connected"
                message="Add an API key or OAuth credential to route requests to this provider."
              />
            ) : (
              <AccountsList
                providerId={id}
                accounts={visibleAccounts}
                onDelete={(acc) => setDeleteTarget(acc)}
                showGrokProbe={id === "grok"}
                grokProbePending={probeAllAccounts.isPending}
                onGrokProbe={runGrokAccountProbe}
                onRelogin={id === "autoclaw" ? handleAutoClawRelogin : undefined}
              />
            )}
          </CardBody>
        </Card>
      )}

      {/* Credits — points and the daily check-in, above the claim campaigns */}
      {supportsCreditBalance(id) && provider.requiresAccount !== false ? (
        <CreditBalanceCard
          accounts={visibleAccounts.map((account) => ({
            id: account.id,
            label: account.label,
            status: account.status,
          }))}
        />
      ) : null}

      {/* Claim plan — per-account campaigns, above the model catalog */}
      {supportsPlanClaims(id) && provider.requiresAccount !== false ? (
        <ClaimPlansCard
          key={notificationAccount?.id ?? id}
          providerId={id}
          accounts={visibleAccounts.map((account) => ({
            id: account.id,
            label: account.label,
            status: account.status,
          }))}
        />
      ) : null}

      {/* Models */}
      <Card>
        <CardHeader
          title="Models"
          subtitle={`${models.length} model${models.length === 1 ? "" : "s"} registered`}
          icon={<Boxes size={16} />}
          action={
            <Inline gap="6px" style={{ flexWrap: "wrap" }}>
              {provider?.supportsModelDiscovery !== false ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={
                    <RefreshCw size={13} className={syncModels.isPending ? "animate-spin" : ""} />
                  }
                  disabled={syncModels.isPending}
                  onClick={() => syncModels.mutate(id)}
                >
                  {syncModels.isPending ? "Fetching..." : "Fetch models"}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                icon={<Trash2 size={13} className={bulkDeleting ? "animate-spin" : ""} />}
                disabled={
                  syncModels.isPending ||
                  bulkDeleting ||
                  models.filter((m) => m.source !== "builtin" && m.source !== null).length === 0
                }
                onClick={async () => {
                  const fetched = models.filter((m) => m.source !== "builtin" && m.source !== null);
                  if (fetched.length === 0) return;
                  if (!confirm(`Delete ${fetched.length} fetched/manual model(s) for ${id}?`)) return;
                  setBulkDeleting(true);
                  try {
                    const result = await consoleRequest<{
                      deleted: number;
                      total: number;
                      failures: { modelId: string; route: string; code: string; message: string }[];
                    }>(`/providers/${encodeURIComponent(id)}/models/bulk`, {
                      method: "DELETE",
                      body: JSON.stringify({
                        items: fetched.map((m) => ({ modelId: m.modelId, route: m.route })),
                      }),
                    });
                    await Promise.all([
                      queryClient.invalidateQueries({ queryKey: queryKeys.providers.models(id) }),
                      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
                    ]);
                    const failed = result.failures.length;
                    toast.success(
                      "Fetched models deleted",
                      failed > 0
                        ? `${result.deleted}/${result.total} removed, ${failed} failed`
                        : `${result.deleted}/${result.total} removed`,
                    );
                  } catch (err) {
                    toast.error(
                      "Failed to delete fetched models",
                      (err as { message?: string }).message ?? "Unable to delete models",
                    );
                  } finally {
                    setBulkDeleting(false);
                  }
                }}
              >
                {bulkDeleting ? "Deleting…" : "Delete fetched"}
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={13} />}
                onClick={() => setAddModelOpen(true)}
              >
                Add Model
              </Button>
            </Inline>
          }
        />
        <CardBody style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {modelsQuery.isPending ? (
            <LoadingState label="Loading models..." />
          ) : modelsQuery.isError ? (
            <ErrorState message="Failed to load models" onRetry={() => modelsQuery.refetch()} />
          ) : models.length === 0 ? (
            <EmptyState
              title="No models found"
              message="No models published by this provider yet. Sync or add a custom model above."
            />
          ) : (
            <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-tertiary)" }}>
                Models ({stableModels.length}) · disabled remain in place
              </div>
              <ModelGrid providerId={id} models={stableModels} promotions={provider?.promotions} />
            </section>
          )}
        </CardBody>
      </Card>

      {addAccountOpen && (
        <AddAccountModal
          providerId={id}
          accounts={accounts}
          onClose={() => setAddAccountOpen(false)}
        />
      )}
      {addModelOpen && (
        <AddModelModal providerId={id} provider={provider} onClose={() => setAddModelOpen(false)} />
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!isDeleting) setDeleteTarget(null);
        }}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setIsDeleting(true);
          try {
            // Same split as the bulk path: shared accounts are global-admin
            // only, because the tenant-scoped route filters on a tenant id
            // they do not have.
            const path =
              deleteTarget.tenantId === null
                ? `/global/accounts/${encodeURIComponent(deleteTarget.id)}`
                : `/accounts/${encodeURIComponent(deleteTarget.id)}`;
            await consoleRequest(path, {
              method: "DELETE",
            });
            queryClient.removeQueries({
              queryKey: queryKeys.quota.account(deleteTarget.id),
              exact: true,
            });
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(id) }),
              queryClient.invalidateQueries({
                queryKey: queryKeys.providers.healthEvents(id, deleteTarget.id),
              }),
              queryClient.invalidateQueries({ queryKey: queryKeys.providers.all }),
              queryClient.invalidateQueries({ queryKey: queryKeys.quota.all }),
            ]);
            toast.success(
              "Account deleted",
              deleteTarget.label || deleteTarget.id.slice(0, 8),
            );
            setDeleteTarget(null);
          } catch (err) {
            toast.error(
              "Failed to delete account",
              (err as { message?: string }).message ?? "Unable to delete account",
            );
            throw err;
          } finally {
            setIsDeleting(false);
          }
        }}
        title="Delete account?"
        message={`Delete "${deleteTarget?.label || deleteTarget?.id.slice(0, 8)}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
      />
      {autoClawCaptchaOpen && (
        <AutoClawCaptchaDialog
          open={autoClawCaptchaOpen}
          onSolved={(captchaVerifyParam, challengeWindow) => {
            setAutoClawCaptchaOpen(false);
            handleAutoClawOAuth(captchaVerifyParam, challengeWindow);
          }}
          onClose={() => {
            setAutoClawCaptchaOpen(false);
          }}
        />
      )}
      {!provider.isBuiltIn ? (
        <EditProviderModal
          provider={provider}
          open={editProviderOpen}
          onClose={() => setEditProviderOpen(false)}
        />
      ) : null}
      {autoClawTokenOpen && (
        <AutoClawTokenDialog
          open={autoClawTokenOpen}
          onClose={(completed) => {
            setAutoClawTokenOpen(false);
            if (completed) void queryClient.invalidateQueries({ queryKey: queryKeys.providers.accounts(id) });
          }}
        />
      )}
      {deviceDialogOpen && (
        <DeviceCodeDialog providerId={id} onClose={() => setDeviceDialogOpen(false)} />
      )}
      {oauthBrowserSession && (
        <OAuthBrowserDialog
          providerId={id}
          authorizeUrl={oauthBrowserSession.authorizeUrl}
          state={oauthBrowserSession.state}
          popup={oauthBrowserSession.popup}
          onClose={(completed) => {
            closeOAuthBrowserSession(completed);
            if (completed && reloginCleanupRef.current !== null) {
              const cleanup = reloginCleanupRef.current;
              reloginCleanupRef.current = null;
              void cleanup();
            } else if (!completed) {
              reloginTargetRef.current = null;
              reloginCleanupRef.current = null;
            }
          }}
        />
      )}
      {oauthLoopbackSession && (
        <OAuthLoopbackDialog
          providerId={id}
          shellSnippet={oauthLoopbackSession.shellSnippet}
          helperScriptUrl={oauthLoopbackSession.helperScriptUrl}
          ttlSeconds={oauthLoopbackSession.ttlSeconds}
          onClose={closeOAuthLoopbackSession}
        />
      )}
    </Stack>
  );
}
