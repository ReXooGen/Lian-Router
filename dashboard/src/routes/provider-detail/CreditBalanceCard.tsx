import { Check, Coins, History, Loader2, LogIn } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Inline } from "../../components/ui/inline";
import { useAutoClawCredits, useTriggerAutoClawCheckin } from "../../lib/hooks/quota";
import { toast } from "../../lib/toast";
import { getErrorMessage } from "../../lib/helpers";
import { AutoClawCreditsHistoryDialog } from "./AutoClawCreditsHistoryDialog";

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
  return (
    <Card>
      <CardHeader
        title="Credits"
        subtitle="Points held by these accounts, and their daily check-in"
        icon={<Coins size={16} />}
      />
      <CardBody>
        {accounts.length === 0 ? (
          <p style={{ margin: 0, fontSize: "12.5px", color: "var(--text-secondary)" }}>
            No account to read points for yet. Add one above.
          </p>
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            {accounts.map((account) => (
              <CreditBalanceRow key={account.id} account={account} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
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
    </div>
  );
}
