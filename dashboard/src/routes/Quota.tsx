import {
  Activity,
  CalendarCheck,
  Check,
  Clock3,
  EyeOff,
  Loader2,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Switch } from "../components/ui/switch";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Badge } from "../components/ui/badge";
import { DataTable } from "../components/ui/layout";
import { Inline } from "../components/ui/inline";
import { StatePanel, EmptyState, LoadingState, ErrorState } from "../components/ui/state";
import { ProviderIcon } from "../components/ProviderIcon";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { HealthEventsModal } from "../components/HealthEventsModal";
import { Select } from "../components/ui/select";
import { Toolbar } from "../components/ui/toolbar";
import { Stack } from "../components/ui/stack";
import { toast } from "../lib/toast";
import {
  useQuotaOverview,
  useRefreshAccountQuota,
  useRefreshAllQuotas,
  useTriggerGrowthPass,
  useBulkAccountCheckin,
  useTriggerAccountReset,
  useAccountResets,
  useUpdateAccountActive,
  useSetAccountsActiveBatch,
  useDeleteQuotaAccount,
  supportsAccountCheckin,
  supportsAccountReset,
  type QuotaEntry,
} from "../lib/hooks/quota";
import {
  friendlyQuotaError,
  formatQuotaRefresh,
  formatQuotaWindowLabel,
  formatResetDistance,
  quotaBarTone,
  pendingGrantLabel,
  accountIdentity,
} from "../lib/quota-formatters";
import { getErrorMessage } from "../lib/helpers";


/** Upper bound for one bulk check-in: above this, narrow filters instead. */
const BULK_CHECKIN_LIMIT = 50;

function isEmpty(account: QuotaEntry): boolean {
  return Boolean(
    account.quota?.windows.length &&
    account.quota.windows.every(
      (window) => window.remainingPercent !== null && window.remainingPercent <= 0,
    ),
  );
}

function firstResetAt(account: QuotaEntry): number {
  const resetTimes =
    account.quota?.windows.map((window) =>
      window.resetsAt ? new Date(window.resetsAt).getTime() : Number.POSITIVE_INFINITY,
    ) ?? [];
  return Math.min(...resetTimes, Number.POSITIVE_INFINITY);
}

function QuotaAccountResetModal({
  account,
  onClose,
}: {
  readonly account: QuotaEntry;
  readonly onClose: () => void;
}): ReactNode {
  const resets = useAccountResets(account.id, true);
  const reset = useTriggerAccountReset(account.id);
  const credits = resets.data?.credits ?? [];

  const grantedLabel = (value: string | undefined): string =>
    value ? new Date(value).toLocaleString() : "—";
  const expiryLabel = (value: string | undefined): string =>
    value ? new Date(value).toLocaleString() : "—";
  const remainingLabel = (value: string | undefined): string => {
    if (!value) return "";
    const remaining = new Date(value).getTime() - Date.now();
    if (!Number.isFinite(remaining)) return "";
    if (remaining <= 0) return "expired";
    const days = Math.floor(remaining / 86_400_000);
    if (days >= 1) return `in ${days}d`;
    const hours = Math.floor(remaining / 3_600_000);
    if (hours >= 1) return `in ${hours}h`;
    return `in ${Math.max(1, Math.floor(remaining / 60_000))}m`;
  };

  return (
    <Dialog
      open={true}
      onClose={onClose}
      width={720}
      title={`Saved Rate-Limit Resets — ${account.name}`}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            padding: "12px 16px",
            borderRadius: "10px",
            background: "var(--surface-2)",
            border: "1px solid var(--inner-border)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Zap size={14} style={{ color: "var(--status-success)" }} />
              <span style={{ fontSize: "13px", fontWeight: 600 }}>Available resets</span>
            </div>
            <p
              style={{
                fontSize: "11.5px",
                color: "var(--text-tertiary)",
                marginTop: "4px",
                lineHeight: 1.5,
              }}
            >
              Each credit lifts a spent rate-limit window before its natural reset.
            </p>
          </div>
          <Badge tone={resets.data && resets.data.availableCount > 0 ? "ok" : "disabled"} dot>
            {resets.data?.availableCount ?? 0} reset
            {(resets.data?.availableCount ?? 0) === 1 ? "" : "s"}
          </Badge>
        </div>

        {resets.isPending ? (
          <LoadingState label="Reading saved resets…" />
        ) : resets.isError ? (
          <ErrorState message="Failed to read saved resets" onRetry={() => void resets.refetch()} />
        ) : credits.length === 0 ? (
          <EmptyState
            title="No saved resets"
            message="This account has no saved rate-limit reset credits right now."
            icon={<Zap size={20} />}
          />
        ) : (
          <div
            style={{
              maxHeight: "340px",
              overflowY: "auto",
              border: "1px solid var(--inner-border)",
              borderRadius: "10px",
            }}
          >
            <DataTable headers={["Status", "Title", "Granted", "Expires", ""]}>
              {credits.map((credit) => {
                const available = (credit.status ?? "available") === "available";
                const remaining = remainingLabel(credit.expiresAt);
                return (
                  <tr key={credit.id}>
                    <td style={{ whiteSpace: "nowrap", verticalAlign: "middle" }}>
                      <Badge
                        tone={available ? "ok" : credit.status === "expired" ? "disabled" : "warn"}
                      >
                        {credit.status ?? "available"}
                      </Badge>
                    </td>
                    <td
                      style={{
                        fontSize: "12px",
                        color: "var(--text-primary)",
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                        verticalAlign: "middle",
                      }}
                    >
                      {credit.title ?? "Rate-limit reset"}
                    </td>
                    <td
                      style={{
                        fontSize: "11px",
                        color: "var(--text-secondary)",
                        whiteSpace: "nowrap",
                        fontVariantNumeric: "tabular-nums",
                        verticalAlign: "middle",
                      }}
                    >
                      {grantedLabel(credit.grantedAt)}
                    </td>
                    <td
                      style={{
                        fontSize: "11px",
                        color: "var(--text-secondary)",
                        whiteSpace: "nowrap",
                        fontVariantNumeric: "tabular-nums",
                        verticalAlign: "middle",
                      }}
                    >
                      {expiryLabel(credit.expiresAt)}
                      {remaining && (
                        <span style={{ color: "var(--text-tertiary)", marginLeft: "6px" }}>
                          ({remaining})
                        </span>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap", textAlign: "right", verticalAlign: "middle" }}>
                      <Button
                        size="sm"
                        variant={available ? "primary" : "secondary"}
                        disabled={!available || reset.isPending}
                        onClick={() =>
                          reset.mutate(
                            { creditId: credit.id },
                            {
                              onSuccess: (result) => {
                                if (result.ok) {
                                  toast.success(result.message ?? "Rate limit reset applied");
                                } else {
                                  toast.error(result.message ?? "Rate limit reset failed");
                                }
                              },
                              onError: (err) => {
                                toast.error(
                                  getErrorMessage(err, "Unable to redeem rate-limit reset"),
                                );
                              },
                            },
                          )
                        }
                      >
                        Use
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </div>
        )}

        <Inline justify="flex-end" gap="0px">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </Inline>
      </div>
    </Dialog>
  );
}

function QuotaCard({
  account,
  onToggle,
  onDelete,
  onShowHealth,
  onShowResets,
}: {
  readonly account: QuotaEntry;
  readonly onToggle: (account: QuotaEntry, active: boolean) => void;
  readonly onDelete: (account: QuotaEntry) => void;
  readonly onShowHealth: (account: QuotaEntry) => void;
  readonly onShowResets: (account: QuotaEntry) => void;
}): ReactNode {
  const refresh = useRefreshAccountQuota(account.id);
  const growth = useTriggerGrowthPass(account.id);
  const canCheckin = supportsAccountCheckin(account.provider);
  const canReset = supportsAccountReset(account.provider);
  const resets = useAccountResets(account.id, canReset);
  const quota = account.quota;
  const busy = refresh.isPending || growth.isPending;
  const resetCreditsCount = resets.data?.availableCount ?? 0;
  // Manual trigger result wins while fresh; otherwise the sweep ledger tells
  // whether today was already attempted. Neither is a live upstream read, so
  // the label is a state hint, not a guarantee of today's grant.
  const [lastCheckin, setLastCheckin] = useState<{
    readonly state: string;
    readonly credit: number | null;
    readonly streakDays: number | null;
  } | null>(null);
  const [lastReported, setLastReported] = useState(false);
  const attemptedToday = account.checkin?.attemptedToday ?? false;
  const checkinHint = lastCheckin
    ? lastCheckin.state === "claimed"
      ? `Checked in${lastCheckin.credit !== null ? ` +${lastCheckin.credit}` : ""}${lastCheckin.streakDays !== null ? ` · ${lastCheckin.streakDays}d streak` : ""}`
      : lastCheckin.state === "already_claimed"
        ? "Already checked in"
        : lastCheckin.state === "not_eligible"
          ? "Not eligible"
          : lastCheckin.state === "event_ended"
            ? "Event ended"
            : "Check-in unavailable"
    : attemptedToday
      ? "Check-in attempted today"
      : "Check-in due";
  const activityHint = lastReported ? "Reported today" : "Not reported";
  const statusHint = `${checkinHint} · ${activityHint}`;
  const rawError =
    (refresh.error ? getErrorMessage(refresh.error, "Unable to refresh this account") : null) ??
    quota?.error ??
    account.health?.sanitizedMessage;
  const friendly = friendlyQuotaError(rawError, account.credentialHint);
  const isUnsupported = friendly === "Quota tracking is not supported for this provider";
  const cardError = isUnsupported ? null : friendly;
  const identity = accountIdentity(account.credentialHint, account.name);
  const healthStatus = account.health?.status ?? "unknown";

  return (
    <div
      className="overflow-hidden rounded-2xl border border-[var(--inner-border)] bg-[var(--glass-bg)] shadow-[0_8px_30px_rgba(0,0,0,.12)] backdrop-blur-xl"
      style={{
        background: "var(--glass-bg)",
        borderColor: "var(--inner-border)",
        borderRadius: "16px",
      }}
      aria-busy={busy}
    >
      {/* Header: icon + provider name + plan + account hint + actions */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "12px 16px",
        }}
      >
        <ProviderIcon icon={account.providerIcon} name={account.providerName} size={36} />
        <div className="min-w-0 flex-1" style={{ minWidth: 0, flex: 1 }}>
          <div
            className="flex min-w-0 items-center gap-2"
            style={{ display: "flex", alignItems: "center", gap: "8px" }}
          >
            <div
              className="truncate text-sm font-bold"
              style={{
                fontSize: "13.5px",
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              {account.providerName}
            </div>
            {canCheckin ? (
              <Badge
                tone="info"
                title={`Billing facade: ${account.providerName} (${account.provider})`}
              >
                {account.provider}
              </Badge>
            ) : null}
            {quota?.plan && (
              <span
                className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent)]"
                style={{
                  padding: "2px 8px",
                  borderRadius: "9999px",
                  fontSize: "10px",
                  fontWeight: 600,
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                }}
              >
                {quota.plan}
              </span>
            )}
            {healthStatus !== "active" ? (
              <Badge
                tone={
                  healthStatus === "disabled"
                    ? "disabled"
                    : healthStatus === "unknown"
                      ? "default"
                      : "warn"
                }
                dot
                title={account.health?.sanitizedMessage ?? undefined}
              >
                {healthStatus}
                {account.health?.lastErrorCategory ? ` · ${account.health.lastErrorCategory}` : ""}
              </Badge>
            ) : null}
          </div>
          <div
            className="truncate text-[11px] text-[var(--text-secondary)]"
            style={{ fontSize: "11px", color: "var(--text-secondary)" }}
          >
            {identity.primary}
          </div>
          {identity.secondary !== null && (
            <div
              className="truncate text-[10px] text-[var(--text-tertiary)]"
              style={{ fontSize: "10px", color: "var(--text-tertiary)" }}
            >
              {identity.secondary}
            </div>
          )}
          {quota && (
            <div
              className="truncate text-[10px] text-[var(--text-tertiary)]"
              style={{ fontSize: "10px", color: "var(--text-tertiary)" }}
            >
              {formatQuotaRefresh(quota.lastSuccessAt ?? quota.fetchedAt)}
            </div>
          )}
          {canReset && (
            <div
              className="truncate text-[10px]"
              style={{
                fontSize: "10px",
                color: "var(--text-tertiary)",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
              title="Saved rate-limit reset credits available on this account"
            >
              {resets.isPending ? (
                "Checking saved resets…"
              ) : resetCreditsCount > 0 ? (
                <>
                  <Zap
                    size={10}
                    style={{ color: "var(--status-success)", flexShrink: 0 }}
                    aria-hidden="true"
                  />
                  <span className="reset-credit-live">
                    {resetCreditsCount} rate-limit reset
                    {resetCreditsCount === 1 ? "" : "s"} available
                  </span>
                </>
              ) : (
                "No rate-limit resets available"
              )}
            </div>
          )}
          {canCheckin && (
            <div
              className="truncate text-[10px] text-[var(--text-tertiary)]"
              style={{ fontSize: "10px", color: "var(--text-tertiary)" }}
              title="Daily growth state: manual pass result, else the sweep ledger for today"
            >
              {growth.isPending ? "Running growth pass…" : statusHint}
            </div>
          )}
        </div>
        <div
          className="flex items-center gap-1"
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          {canReset && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title={
                resets.isPending
                  ? "Checking saved rate-limit resets…"
                  : resetCreditsCount > 0
                    ? `Saved rate-limit resets (${resetCreditsCount} available)`
                    : "Saved rate-limit resets"
              }
              aria-label={`Open saved rate-limit resets for ${account.name}`}
              disabled={busy}
              onClick={() => onShowResets(account)}
              style={{ width: "32px", height: "32px", padding: 0 }}
            >
              <Zap size={14} />
            </Button>
          )}
          {canCheckin && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title={`Daily growth pass (check-in + activity report) on ${account.providerName} — ${statusHint}`}
              aria-label={`Run daily growth pass for ${account.name}`}
              disabled={busy}
              onClick={() =>
                growth.mutate(undefined, {
                  onSuccess: (result) => {
                    const checkinData = result.checkin.data;
                    if (checkinData) {
                      setLastCheckin({
                        state: checkinData.state,
                        credit: checkinData.credit,
                        streakDays: checkinData.streakDays,
                      });
                    }
                    if (result.report.ok) setLastReported(true);
                    if (result.ok) {
                      toast.success(result.message);
                    } else {
                      toast.error(result.message);
                    }
                  },
                  onError: (err) => {
                    toast.error(getErrorMessage(err, "Unable to run daily growth pass"));
                  },
                })
              }
              style={{ width: "32px", height: "32px", padding: 0 }}
            >
              {growth.isPending ? <Loader2 size={14} className="animate-spin" /> : <CalendarCheck size={14} />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Health & Error Log"
            aria-label={`Health log for ${account.name}`}
            disabled={busy}
            onClick={() => onShowHealth(account)}
            style={{ width: "32px", height: "32px", padding: 0 }}
          >
            <Activity size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Refresh quota"
            aria-label={`Refresh ${account.name} quota`}
            disabled={busy}
            onClick={() => refresh.mutate()}
            style={{ width: "32px", height: "32px", padding: 0 }}
          >
            {refresh.isPending ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Delete account"
            aria-label={`Delete ${account.name}`}
            onClick={() => onDelete(account)}
            style={{ width: "32px", height: "32px", padding: 0, color: "var(--red)" }}
          >
            <Trash2 size={14} />
          </Button>
          <Switch
            checked={account.active}
            disabled={refresh.isPending}
            onChange={(active) => onToggle(account, active)}
            label=""
            id={`switch-${account.id}`}
          />
        </div>
      </div>

      {cardError && (
        <div
          className="flex items-center justify-center gap-2 border-t border-[var(--inner-border)] px-4 py-3 text-center text-[11px] text-[var(--red)]"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            borderTop: "1px solid var(--inner-border)",
            padding: "10px 16px",
            fontSize: "11px",
            color: "var(--red)",
          }}
          role="alert"
        >
          <TriangleAlert size={13} className="shrink-0" />
          <span>{cardError}</span>
        </div>
      )}

      {/* Quota progress bars */}
      {quota?.windows.length ? (
        <div
          className="space-y-3 border-t border-[var(--inner-border)] px-4 py-3"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            borderTop: "1px solid var(--inner-border)",
            padding: "12px 16px",
          }}
        >
          {quota.windows.map((window, index) => {
            const remaining = window.remainingPercent ?? null;
            const limit = window.limit ?? null;
            // A scheduled grant has no usage yet by definition, so its bar would
            // be an empty grey line with a bare "limit 300,000,000". The schedule
            // is the only useful fact about it.
            const pendingLabel = pendingGrantLabel(window.availableAt);
            const colors = quotaBarTone(remaining);
            const quotaFillPct = pendingLabel !== null ? 0 : remaining !== null ? Math.max(0, Math.min(100, remaining)) : 0;
            // A plan heading appears above the first bar of each plan. With one
            // plan the heading would repeat the badge already in the card
            // header, so it is only drawn when the account holds more than one;
            // the split itself is what tells an operator that the referral
            // grant and the paid plan are separate pools.
            const planGroups = quota.windows.map((entry) => entry.group ?? null);
            const distinctPlans = new Set(planGroups.filter((group) => group !== null));
            const showPlanHeading = distinctPlans.size > 1 && planGroups.indexOf(window.group ?? null) === index;
            return (
              <div key={`${window.kind ?? window.label}:${window.resetsAt ?? "none"}:${index}`}>
                {showPlanHeading && window.group ? (
                  <div
                    style={{
                      fontSize: "10px",
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      color: "var(--text-tertiary)",
                      marginBottom: "8px",
                      marginTop: index === 0 ? "0" : "4px",
                    }}
                  >
                    {window.group}
                  </div>
                ) : null}
                {/* Label + percentage */}
                <div
                  className="mb-1.5 flex items-center justify-between"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: "6px",
                  }}
                >
                  <span
                    className="text-[11px] font-semibold text-[var(--text-primary)]"
                    style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-primary)" }}
                  >
                    {formatQuotaWindowLabel(window.label)}
                  </span>
                  {pendingLabel !== null ? (
                    <span
                      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      style={{
                        padding: "2px 8px",
                        borderRadius: "9999px",
                        fontSize: "10px",
                        fontWeight: 600,
                        background: "var(--accent-soft)",
                        color: "var(--accent)",
                      }}
                    >
                      {pendingLabel}
                    </span>
                  ) : remaining !== null ? (
                    <span
                      className="text-[11px] font-bold tabular-nums"
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        color: colors.text,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {remaining}%
                    </span>
                  ) : null}
                </div>
                {/* Pill progress bar */}
                <div
                  className="h-2 overflow-hidden rounded-full bg-[var(--inner-border)]"
                  style={{
                    height: "8px",
                    borderRadius: "9999px",
                    background: "var(--inner-border)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${quotaFillPct}%`,
                      height: "100%",
                      borderRadius: "9999px",
                      background: colors.bar,
                      transition: "width var(--dur-macro) var(--ease-spring)",
                    }}
                  />
                </div>
                {/* Used / limit + reset */}
                <div
                  className="mt-1 flex items-center justify-between text-[10px] text-[var(--text-tertiary)]"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: "10px",
                    color: "var(--text-tertiary)",
                    marginTop: "4px",
                  }}
                >
                  {(window.usedPercent !== null || limit !== null) && (
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {window.usedPercent !== null ? `${window.usedPercent}% used` : ""}
                      {limit !== null
                        ? `${window.usedPercent !== null ? " · " : ""}limit ${limit.toLocaleString()}`
                        : ""}
                    </span>
                  )}
                  {window.resetsAt && (
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {formatResetDistance(window.resetsAt, window.recurring)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : !cardError ? (
        <div
          className="border-t border-[var(--inner-border)] py-6 text-center text-[11px] text-[var(--text-tertiary)]"
          style={{
            borderTop: "1px solid var(--inner-border)",
            padding: "24px 16px",
            textAlign: "center",
            fontSize: "11px",
            color: "var(--text-tertiary)",
          }}
        >
          {/* A pending fill is a real state with a known end, so it gets its own
              copy instead of the misleading "No quota data" a settled empty
              account would show. */}
          {busy || account.pending ? "Fetching quota…" : "No quota data"}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Cards per page. The account grid used to render every account at once. One
 * page of 24 twelve-window cards already renders ~3,500 elements and 288 bars,
 * so a 2,400-account tenant ran to six figures of DOM with a transition on
 * every fill. One page bounds that work and every account stays reachable
 * through the pager.
 */
export const QUOTA_PAGE_SIZE = 24;

/**
 * Prev / page indicator / Next. Rendered above and below the grid so a long
 * page can be advanced from the bottom without scrolling back up.
 */
function QuotaPager({
  currentPage,
  totalPages,
  onPageChange,
}: {
  readonly currentPage: number;
  readonly totalPages: number;
  readonly onPageChange: (page: number) => void;
}): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "8px",
      }}
    >
      <Button
        variant="secondary"
        size="sm"
        disabled={currentPage <= 1}
        onClick={() => onPageChange(currentPage - 1)}
      >
        Prev
      </Button>
      <span
        aria-live="polite"
        style={{
          fontSize: "11px",
          color: "var(--text-tertiary)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        Page {currentPage} of {totalPages}
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={currentPage >= totalPages}
        onClick={() => onPageChange(currentPage + 1)}
      >
        Next
      </Button>
    </div>
  );
}

/**
 * The visible page of account cards plus its pager. Exported so the bounded
 * grid can be rendered at a chosen page without a DOM.
 */
export function QuotaAccountGrid({
  accounts,
  page,
  onPageChange,
  onToggle,
  onDelete,
  onShowHealth,
  onShowResets,
}: {
  readonly accounts: readonly QuotaEntry[];
  readonly page: number;
  readonly onPageChange: (page: number) => void;
  readonly onToggle: (account: QuotaEntry, active: boolean) => void;
  readonly onDelete: (account: QuotaEntry) => void;
  readonly onShowHealth: (account: QuotaEntry) => void;
  readonly onShowResets: (account: QuotaEntry) => void;
}): ReactNode {
  const totalPages = Math.max(1, Math.ceil(accounts.length / QUOTA_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * QUOTA_PAGE_SIZE;
  const visible = accounts.slice(start, start + QUOTA_PAGE_SIZE);

  return (
    <Stack gap="12px">
      <QuotaPager
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={onPageChange}
      />

      <div
        className="grid grid-cols-1 gap-3 lg:grid-cols-2"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(420px, 100%), 1fr))",
          gap: "12px",
        }}
      >
        {visible.map((account) => (
          <QuotaCard
            key={account.id}
            account={account}
            onToggle={onToggle}
            onDelete={onDelete}
            onShowHealth={onShowHealth}
            onShowResets={onShowResets}
          />
        ))}
      </div>

      <QuotaPager
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={onPageChange}
      />
    </Stack>
  );
}

/**
 * Whether an account belongs in the grid under the current account filter.
 *
 * A read that failed carries no windows, but that says nothing about the
 * account: the default "With quota" filter used to drop it, so an account whose
 * quota endpoint rate-limited simply vanished from the page — the accounts most
 * in need of attention were the ones missing.
 */
export function quotaAccountMatchesFilter(
  account: QuotaEntry,
  accountFilter: string,
  providerFilter: string,
): boolean {
  if (providerFilter !== "all" && account.provider !== providerFilter) return false;
  const hasQuota = Boolean(account.quota?.windows.length);
  const readFailed = Boolean(account.quota?.error);
  if (accountFilter === "untracked") return !hasQuota && !readFailed;
  const spent = isSpentAccount(account);
  // A plan whose grants are all spent still answers, but it holds nothing an
  // operator can use, so it leaves the default list instead of sitting there
  // looking like capacity. It stays reachable through "Spent", because hiding
  // a fact is not the same as deleting it and an operator still needs to see
  // which accounts ran dry.
  if (accountFilter === "spent") return spent;
  if (spent) return false;
  if (!hasQuota && !readFailed) return false;
  if (accountFilter === "active" && !account.active) return false;
  if (accountFilter === "disabled" && account.active) return false;
  return true;
}

/**
 * True when the account's every grant is spent.
 *
 * Mirrors the server's `isQuotaExhausted`: a read error and an empty window
 * list both mean "unknown", not "spent", so neither is hidden by this rule.
 */
function isSpentAccount(account: QuotaEntry): boolean {
  const windows = account.quota?.windows ?? [];
  if (account.quota?.error || windows.length === 0) return false;
  return windows.every((window) => window.remainingPercent !== null && window.remainingPercent <= 0);
}
export default function Quota(): ReactNode {
  const [providerFilter, setProviderFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error, isFetching, dataUpdatedAt, refetch } =
    useQuotaOverview();
  const providers = useMemo(
    () =>
      [...(data?.providers ?? [])].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      ),
    [data?.providers],
  );
  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts]);
  const refreshingCount = data?.refreshing ?? 0;
  const refreshAll = useRefreshAllQuotas();
  const bulkCheckin = useBulkAccountCheckin();
  const updateActive = useUpdateAccountActive();
  const setActiveBatch = useSetAccountsActiveBatch();
  const deleteAccountMutation = useDeleteQuotaAccount();
  const [deleteTarget, setDeleteTarget] = useState<QuotaEntry | null>(null);
  const [healthTarget, setHealthTarget] = useState<QuotaEntry | null>(null);
  const [resetTarget, setResetTarget] = useState<QuotaEntry | null>(null);

  const filteredAccounts = useMemo(() => {
    const result = accounts.filter((account) =>
      quotaAccountMatchesFilter(account, accountFilter, providerFilter),
    );
    // Default order is A→Z by display name; "Expiring first" swaps to the
    // soonest-resetting account, with the name as a stable tiebreaker so the
    // grid does not reshuffle between polls.
    const byName = (left: QuotaEntry, right: QuotaEntry): number =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    return [...result].sort(
      expiringFirst
        ? (left, right) => firstResetAt(left) - firstResetAt(right) || byName(left, right)
        : byName,
    );
  }, [accountFilter, accounts, expiringFirst, providerFilter]);

  // Bulk check-in follows the current filters, not the whole tenant: the
  // toolbar already shows "N matching" beside the action, and a check-in costs
  // upstream requests. An operator who wants the wider set widens the filters.
  const checkinTargets = useMemo(
    () => filteredAccounts.filter((account) => supportsAccountCheckin(account.provider)),
    [filteredAccounts],
  );
  const bulkCheckinBlocked = checkinTargets.length > BULK_CHECKIN_LIMIT;

  // Any filter or ordering change re-enters the list at page 1; otherwise a
  // narrowed result can leave the operator on an empty tail page.
  const changeProviderFilter = (value: string) => {
    setProviderFilter(value);
    setPage(1);
  };

  const changeAccountFilter = (value: string) => {
    setAccountFilter(value);
    setPage(1);
  };

  const toggleExpiringFirst = () => {
    setExpiringFirst((current) => !current);
    setPage(1);
  };
  const updateAccount = async (account: QuotaEntry, active: boolean) => {
    try {
      await updateActive.mutateAsync({ id: account.id, active });
      toast.success(`${account.name} ${active ? "enabled" : "disabled"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to update account");
    }
  };

  const turnOffEmpty = async () => {
    const targets = accounts.filter((account) => account.active && isEmpty(account));
    await setActiveBatch.mutateAsync({ ids: targets.map((target) => target.id), active: false });
    toast.success(`Disabled ${targets.length} empty accounts`);
  };

  const turnOnAvailable = async () => {
    const targets = accounts.filter(
      (account) =>
        !account.active &&
        account.quota?.windows.some(
          (window) => window.remainingPercent !== null && window.remainingPercent > 0,
        ),
    );
    await setActiveBatch.mutateAsync({ ids: targets.map((target) => target.id), active: true });
    toast.success(`Enabled ${targets.length} available accounts`);
  };

  const deleteAccount = async (account: QuotaEntry) => {
    await deleteAccountMutation.mutateAsync(account.id);
    toast.success(`${account.name} deleted`);
  };

  const lastUpdated =
    dataUpdatedAt > 0
      ? new Date(dataUpdatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Not updated";
  const emptyCount = accounts.filter(isEmpty).length;

  return (
    <Stack gap="16px" className="dashboard-page" style={{ minHeight: 0, flex: 1 }}>
      <Toolbar className="page-toolbar-sticky">
        <SlidersHorizontal
          size={14}
          className="mx-1 text-[var(--text-tertiary)]"
          style={{ color: "var(--text-tertiary)" }}
          aria-hidden="true"
        />
        <Select
          aria-label="Filter quota by provider"
          value={providerFilter}
          onValueChange={changeProviderFilter}
          style={{ width: "160px", height: "32px" }}
          options={[
            { value: "all", label: "All Providers" },
            ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
          ]}
        />
        <Select
          aria-label="Filter quota by account"
          value={accountFilter}
          onValueChange={changeAccountFilter}
          style={{ width: "135px", height: "32px" }}
          options={[
            { value: "all", label: "With quota" },
            { value: "active", label: "Active" },
            { value: "disabled", label: "Disabled" },
            { value: "spent", label: "Spent" },
            { value: "untracked", label: "No quota" },
          ]}
        />
        <Button
          variant={expiringFirst ? "secondary" : "ghost"}
          size="sm"
          onClick={() => toggleExpiringFirst()}
          aria-pressed={expiringFirst}
          icon={<Clock3 size={13} />}
        >
          Expiring first
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-[var(--red)]"
          style={{ color: "var(--red)" }}
          disabled={emptyCount === 0 || isFetching}
          onClick={() => void turnOffEmpty()}
          icon={<EyeOff size={13} />}
        >
          Turn off Empty
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-[var(--green)]"
          style={{ color: "var(--green)" }}
          disabled={isFetching}
          onClick={() => void turnOnAvailable()}
          icon={<Check size={13} />}
        >
          Turn on Available
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<CalendarCheck size={13} />}
          title={
            bulkCheckinBlocked
              ? `Too many matching accounts (${checkinTargets.length}); narrow the filters to ${BULK_CHECKIN_LIMIT} or fewer`
              : "Run the daily check-in for every account matching the current filters (each provider uses its own billing facade)"
          }
          aria-label={`Check in ${checkinTargets.length} matching accounts`}
          loading={bulkCheckin.isPending}
          disabled={
            checkinTargets.length === 0 ||
            bulkCheckinBlocked ||
            bulkCheckin.isPending ||
            isFetching
          }
          onClick={() =>
            bulkCheckin.mutate(
              checkinTargets.map((account) => account.id),
              {
                onSuccess: (summary) => {
                  const parts = [
                    `${summary.claimed} claimed`,
                    `${summary.alreadyClaimed} already`,
                    ...(summary.other > 0 ? [`${summary.other} other`] : []),
                    ...(summary.failed > 0 ? [`${summary.failed} failed`] : []),
                  ];
                  const message = parts.join(" · ");
                  if (summary.failed > 0) {
                    toast.error("Bulk check-in finished", message);
                  } else {
                    toast.success("Bulk check-in finished", message);
                  }
                },
                onError: (error) =>
                  toast.error(
                    "Bulk check-in failed",
                    getErrorMessage(error, "Unable to check in accounts"),
                  ),
              },
            )
          }
        >
          Check in all ({checkinTargets.length})
        </Button>
        <span
          className="ml-auto flex items-center gap-1 text-[10px] text-[var(--text-tertiary)]"
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "10.5px",
            color: "var(--text-tertiary)",
          }}
        >
          {refreshingCount > 0
            ? `Refreshing ${refreshingCount} account${refreshingCount === 1 ? "" : "s"}…`
            : `Auto-refresh (60s) · updated ${lastUpdated}`}{" "}
          · {filteredAccounts.length} shown
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          title="Queue quota refresh"
          aria-label="Queue quota refresh"
          disabled={isFetching || refreshAll.isPending || accounts.length === 0}
          onClick={() =>
            refreshAll.mutate(
              accounts.map((account) => account.id),
              {
                onSuccess: (result) => {
                  toast.success(
                    result.failed === 0
                      ? `Refreshed ${result.succeeded} quota${result.succeeded === 1 ? "" : "s"}`
                      : `Refreshed ${result.succeeded}, ${result.failed} failed`,
                  );
                },
                onError: (err) =>
                  toast.error(err instanceof Error ? err.message : "Unable to refresh quota"),
              },
            )
          }
          style={{ width: "32px", height: "32px", padding: 0 }}
        >
          <RefreshCw size={14} className={refreshAll.isPending ? "animate-spin" : undefined} />
        </Button>
      </Toolbar>

      {isLoading ? (
        <StatePanel
          className="min-h-0 flex flex-1 flex-col items-center justify-center"
          kind="loading"
          title="Loading quota data"
          description="Reading provider account limits…"
        />
      ) : isError ? (
        <StatePanel
          className="min-h-0 flex flex-1 flex-col items-center justify-center"
          kind="error"
          title="Unable to load quota data"
          description={
            error instanceof Error ? error.message : "Check the console session and retry."
          }
          action={
            <Button variant="secondary" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      ) : filteredAccounts.length === 0 ? (
        <StatePanel
          className="min-h-0 flex flex-1 flex-col items-center justify-center"
          kind="empty"
          title="No account quota data"
          description="No tracked provider quota is available yet."
        />
      ) : (
        <QuotaAccountGrid
          accounts={filteredAccounts}
          page={page}
          onPageChange={setPage}
          onToggle={(entry, active) => void updateAccount(entry, active)}
          onDelete={(entry) => setDeleteTarget(entry)}
          onShowHealth={(entry) => setHealthTarget(entry)}
          onShowResets={(entry) => setResetTarget(entry)}
        />
      )}

      {healthTarget && (
        <HealthEventsModal
          summary={{
            providerId: healthTarget.provider,
            accountId: healthTarget.id,
            title: healthTarget.name,
            status: healthTarget.health?.status ?? "unknown",
            errorCategory: healthTarget.health?.lastErrorCategory ?? undefined,
            errorMessage: healthTarget.health?.sanitizedMessage ?? undefined,
            emptyMessage:
              "Status transitions, rate limits, quota refreshes, check-ins, and auto-recoveries will appear here.",
          }}
          onClose={() => setHealthTarget(null)}
        />
      )}

      {resetTarget && (
        <QuotaAccountResetModal account={resetTarget} onClose={() => setResetTarget(null)} />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) await deleteAccount(deleteTarget);
        }}
        title="Delete account?"
        message={`Delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        danger
      />
    </Stack>
  );
}
