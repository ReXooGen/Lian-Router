import { Check, Coins, History, Hourglass, Loader2, LogIn, RefreshCw } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useQueries, useQueryClient, type QueryFunctionContext } from "@tanstack/react-query";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Inline } from "../../components/ui/inline";
import { consoleRequest } from "../../lib/api";
import { querySignal } from "../../lib/hooks/common";
import {
  useAutoClawCredits,
  useTriggerAutoClawCheckin,
  type AutoClawCreditsResult,
} from "../../lib/hooks/quota";
import { queryKeys } from "../../lib/query-keys";
import { toast } from "../../lib/toast";
import { getErrorMessage } from "../../lib/helpers";
import { AutoClawCreditsHistoryDialog } from "./AutoClawCreditsHistoryDialog";
import { AutoClawExpiryDialog } from "./AutoClawExpiryDialog";

/** Providers whose points live on a billing facade this card knows how to read. */
const CREDITS_PROVIDER_IDS: Readonly<Record<string, true>> = { autoclaw: true };

export function supportsCreditBalance(providerId: string): boolean {
  return CREDITS_PROVIDER_IDS[providerId.trim().toLowerCase()] === true;
}

function formatPoints(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("en-US");
}

/**
 * Points and daily check-in for one account.
 *
 * Both live on the same billing facade and both are per account, so the card is
 * per account — a provider with several logins shows one row each, and the
 * check-in button sits on the row it claims for. The number is read from its own
 * route instead of the quota envelope: the quota endpoint is a model-capacity
 * read, and folding a wallet fetch into it would let a billing hiccup blank the
 * quota every other provider depends on.
 *
 * The check-in is idempotent upstream — an already-claimed day answers
 * `already_claimed`, never a second grant — so the button stays live rather
 * than becoming a once-a-day lock the operator has to reason about.
 */
export function CreditBalanceCard({
  accounts,
}: {
  readonly accounts: readonly {
    readonly id: string;
    readonly label: string;
    readonly status: string;
  }[];
}): ReactNode {
  const queryClient = useQueryClient();

  /**
   * Every account's wallet, subscribed at card level so the total is a sum over
   * the *same* cache entries the rows render.
   *
   * The keys are identical to the per-row hooks, which is what makes this free:
   * React Query dedupes by key, so one subscription per account serves both the
   * total and the row, and there is no second wallet read behind the total. A
   * card that fetched its own aggregate endpoint would show a number that could
   * disagree with the rows underneath it.
   */
  const creditQueries = useQueries({
    queries: accounts.map((account) => ({
      queryKey: queryKeys.quota.credits(account.id),
      queryFn: (context: QueryFunctionContext) =>
        consoleRequest<AutoClawCreditsResult>(`/accounts/${encodeURIComponent(account.id)}/credits`, {
          signal: querySignal(context),
        }),
      enabled: Boolean(account.id),
      // The total must move even if a row is virtualised away or the operator
      // scrolls one out of view, so the poll is declared here rather than left
      // to the per-row observers. Same cadence and same key as the row hook:
      // one network read per account per minute feeds both.
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      staleTime: 30_000,
      retry: false,
    })),
  });

  const summary = useMemo(() => {
    let total = 0;
    let daily = 0;
    let counted = 0;
    let pending = 0;
    let failed = 0;
    for (const query of creditQueries) {
      if (query.isPending) {
        pending += 1;
        continue;
      }
      const data = query.data;
      if (data?.ok === false || data?.wallet === undefined) {
        failed += 1;
        continue;
      }
      // Only a successful read contributes: a stale or failed row must not be
      // silently counted as zero, because that would understate the total the
      // operator is looking at.
      total += data.wallet.totalBalance ?? 0;
      daily += data.wallet.dailyPoints ?? 0;
      counted += 1;
    }
    return { total, daily, counted, pending, failed };
  }, [creditQueries]);

  const refreshAll = () => {
    for (const account of accounts) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.quota.credits(account.id) });
    }
  };

  const isFetching = creditQueries.some((query) => query.isFetching);

  return (
    <Card>
      <CardHeader
        title="Credits"
        subtitle="Points held by these accounts, and their daily check-in"
        icon={<Coins size={16} />}
        action={
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={13} className={isFetching ? "animate-spin" : ""} />}
            disabled={isFetching || accounts.length === 0}
            onClick={refreshAll}
            title="Re-read every account's balance now instead of waiting for the poll"
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />
      <CardBody>
        {accounts.length === 0 ? (
          <p style={{ margin: 0, fontSize: "12.5px", color: "var(--text-secondary)" }}>
            No account to read points for yet. Add one above.
          </p>
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            <CreditTotalStrip summary={summary} accountCount={accounts.length} />
            {accounts.map((account) => (
              <CreditBalanceRow key={account.id} account={account} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Sum across every account, shown above the rows it is made of.
 *
 * Reads its numbers from the rows' own cache entries, never from a separate
 * aggregate call: two sources for one figure is how a total starts disagreeing
 * with the list directly under it. `counted` also carries the honesty check —
 * when some accounts failed to read, the total says so instead of quietly
 * rendering a partial sum as if it were the whole picture.
 */
function CreditTotalStrip({
  summary,
  accountCount,
}: {
  readonly summary: {
    readonly total: number;
    readonly daily: number;
    readonly counted: number;
    readonly pending: number;
    readonly failed: number;
  };
  readonly accountCount: number;
}): ReactNode {
  const { total, daily, counted, pending, failed } = summary;
  const complete = counted === accountCount && accountCount > 0;
  const reading = pending > 0 && counted === 0;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "12px 14px",
        borderRadius: "8px",
        border: "1px solid var(--border-strong)",
        background: "var(--surface-muted)",
      }}
    >
      <div style={{ display: "grid", gap: "2px" }}>
        <span
          style={{
            fontSize: "11px",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--text-secondary)",
          }}
        >
          Total credits
        </span>
        <span style={{ fontSize: "11.5px", color: "var(--text-tertiary)" }}>
          {complete
            ? `Across ${accountCount} ${accountCount === 1 ? "account" : "accounts"}`
            : failed > 0
              ? `${counted} of ${accountCount} accounts readable — total is partial`
              : `${counted} of ${accountCount} accounts read`}
        </span>
      </div>
      <Inline gap="14px" align="baseline">
        {daily > 0 ? (
          <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            {formatPoints(daily)} daily
          </span>
        ) : null}
        {reading ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "13px",
              color: "var(--text-secondary)",
            }}
          >
            <Loader2 size={13} className="animate-spin" /> Reading…
          </span>
        ) : (
          <span
            style={{
              fontSize: "20px",
              fontWeight: 700,
              color: "var(--text-primary)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatPoints(total)}
            <span style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginLeft: "4px" }}>
              pts
            </span>
          </span>
        )}
      </Inline>
    </div>
  );
}

function CreditBalanceRow({
  account,
}: {
  readonly account: { readonly id: string; readonly label: string; readonly status: string };
}): ReactNode {
  const credits = useAutoClawCredits(account.id, true);
  const checkin = useTriggerAutoClawCheckin(account.id);
  const wallet = credits.data?.wallet;
  const total = wallet?.totalBalance ?? null;
  const daily = wallet?.dailyPoints ?? null;
  const disabled = account.status !== "active";
  // Two sources, one answer: the route's Redis marker survives a reload, and
  // the mutation result covers the click that just happened (the refetch of
  // `credits` is a separate round trip and would leave the button stale for a
  // moment). Either saying "done" is enough — the claim is idempotent, so the
  // worst case of trusting it is one no-op request.
  const checkedInToday =
    credits.data?.checkedInToday === true ||
    checkin.data?.data?.state === "already_claimed" ||
    checkin.data?.data?.state === "claimed";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expiryOpen, setExpiryOpen] = useState(false);

  const runCheckin = () => {
    checkin.mutate(undefined, {
      onSuccess: (result) => {
        const message = result.message ?? "Check-in finished";
        if (result.ok) toast.success("Check-in", message);
        else toast.error("Check-in failed", message);
        // The points moved, so the number in this row is stale.
        void credits.refetch();
      },
      onError: (error) => {
        toast.error("Check-in failed", getErrorMessage(error));
      },
    });
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "10px 12px",
        border: "1px solid var(--inner-border)",
        borderRadius: "8px",
        background: "var(--surface-2)",
      }}
    >
      <div style={{ display: "grid", gap: "3px", minWidth: 0 }}>
        <Inline gap="8px">
          <span
            style={{
              fontSize: "12.5px",
              fontWeight: 600,
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={account.label}
          >
            {account.label}
          </span>
          {disabled ? <Badge tone="disabled">{account.status}</Badge> : null}
          {credits.data?.wallet?.email ? (
            <span
              style={{
                fontSize: "11.5px",
                color: "var(--text-secondary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginLeft: "auto",
              }}
              title={credits.data.wallet.email}
            >
              {credits.data.wallet.email}
            </span>
          ) : null}
        </Inline>
        <Inline gap="10px">
          {credits.isPending ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                fontSize: "12px",
                color: "var(--text-secondary)",
              }}
            >
              <Loader2 size={12} className="animate-spin" /> Reading points…
            </span>
          ) : credits.data?.ok === false ? (
            <span style={{ fontSize: "12px", color: "var(--error)" }}>
              {credits.data.error ?? "Points unavailable"}
            </span>
          ) : (
            <>
              <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                {formatPoints(total)} pts
              </span>
              {daily !== null ? (
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  {formatPoints(daily)} daily
                </span>
              ) : null}
            </>
          )}
        </Inline>
      </div>
      <Inline gap="6px">
        <Button
          variant="ghost"
          size="sm"
          icon={<Hourglass size={13} />}
          onClick={() => setExpiryOpen(true)}
          title="Points the vendor already expired, and grants lapsing within 7 days"
        >
          Expired
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<History size={13} />}
          onClick={() => setHistoryOpen(true)}
          title="Every grant and model charge on this account's points ledger"
        >
          History
        </Button>
      <Button
        variant="secondary"
        size="sm"
        icon={
          checkin.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : checkedInToday ? (
            <Check size={13} />
          ) : (
            <LogIn size={13} />
          )
        }
        disabled={checkin.isPending || disabled || checkedInToday}
        onClick={runCheckin}
        title={
          disabled
            ? "This account is not active, so the billing facade will refuse the claim."
            : checkedInToday
              ? "Already claimed today. The grant resets at the provider's midnight."
              : "Claim today's sign-in and any outstanding onboarding grants"
        }
      >
        {checkin.isPending ? "Checking in…" : checkedInToday ? "Checked in" : "Check in"}
      </Button>
      </Inline>
      <AutoClawCreditsHistoryDialog
        open={historyOpen}
        accountId={account.id}
        accountLabel={account.label}
        onClose={() => setHistoryOpen(false)}
      />
      <AutoClawExpiryDialog
        open={expiryOpen}
        accountId={account.id}
        accountLabel={account.label}
        onClose={() => setExpiryOpen(false)}
      />
    </div>
  );
}
