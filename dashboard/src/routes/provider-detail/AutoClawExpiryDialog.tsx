import { AlarmClockOff, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { getErrorMessage } from "../../lib/helpers";
import type { AutoClawExpiringBucket } from "../../lib/hooks/quota";
import { useAutoClawExpiry } from "../../lib/hooks/quota";

function bucketTable(buckets: readonly AutoClawExpiringBucket[]): ReactNode {
  return (
    <div style={{ display: "grid", gap: "10px" }}>
      {buckets.map((bucket) => (
        <div
          key={bucket.expiresOn}
          style={{
            padding: "10px 12px",
            borderRadius: "8px",
            border: "1px solid var(--inner-border)",
            background: "var(--surface-2)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
            <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--text-primary)" }}>
              Expired {bucket.expiresOn}
            </span>
            <span style={{ fontSize: "12.5px", color: "var(--error, var(--text-secondary))" }}>
              {bucket.points.toLocaleString("en-US")} pts
            </span>
          </div>
          <div style={{ display: "grid", gap: "3px" }}>
            {bucket.entries.slice(0, 8).map((entry) => (
              <div
                key={entry.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "8px",
                  fontSize: "11.5px",
                  color: "var(--text-secondary)",
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.occurredAt.slice(0, 10)} · {entry.description || "Grant"}
                </span>
                <span style={{ whiteSpace: "nowrap" }}>+{entry.amount.toLocaleString("en-US")}</span>
              </div>
            ))}
            {bucket.entries.length > 8 ? (
              <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                …and {bucket.entries.length - 8} more grants in this bucket
              </span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The account's point-expiry summary: grants the vendor already lapsed, and the
 * ones lapsing within a week.
 *
 * The vendor expires wallet scopes on their own clocks — a daily check-in
 * grant measured 2026-11-23 lapsed six days later — so points the card shows
 * as a balance quietly vanish. This dialog names what went and what is about
 * to, per expiry day, net of the debits that already spent each wallet.
 */
export function AutoClawExpiryDialog({
  open,
  accountId,
  accountLabel,
  onClose,
}: {
  readonly open: boolean;
  readonly accountId: string;
  readonly accountLabel: string;
  readonly onClose: () => void;
}): ReactNode {
  const expiry = useAutoClawExpiry(accountId, open);
  const summary = expiry.data?.ok === true ? expiry.data : undefined;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Point expiry"
      description={`${accountLabel} — grants the vendor lapsed, and grants lapsing within 7 days`}
      width={640}
    >
      {expiry.isPending ? (
        <LoadingState label="Walking the ledger…" />
      ) : expiry.isError ? (
        <ErrorState
          message={getErrorMessage(expiry.error, "Could not read the expiry summary.")}
          onRetry={() => void expiry.refetch()}
        />
      ) : summary === undefined ? (
        <ErrorState message={expiry.data?.error ?? "Expiry summary unavailable."} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid var(--inner-border)",
                background: "var(--surface-2)",
              }}
            >
              <span style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>
                Already expired
              </span>
              <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)" }}>
                {summary.expiredPoints.toLocaleString("en-US")} pts
              </div>
            </div>
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid var(--inner-border)",
                background: "var(--surface-2)",
              }}
            >
              <span style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>
                Expiring within 7 days
              </span>
              <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)" }}>
                {summary.expiringSoonPoints.toLocaleString("en-US")} pts
              </div>
            </div>
          </div>

          {summary.expired.length === 0 && summary.expiringSoon.length === 0 ? (
            <EmptyState
              title="Nothing expired or lapsing"
              message="Every grant on this ledger is either spent or still has runway beyond 7 days."
              icon={<AlarmClockOff size={20} />}
            />
          ) : null}

          {summary.expired.length > 0 ? (
            <div style={{ display: "grid", gap: "8px" }}>
              <h4 style={{ margin: 0, fontSize: "12px", color: "var(--text-secondary)" }}>
                Expired (points the vendor removed)
              </h4>
              {bucketTable(summary.expired)}
            </div>
          ) : null}

          {summary.expiringSoon.length > 0 ? (
            <div style={{ display: "grid", gap: "8px" }}>
              <h4 style={{ margin: 0, fontSize: "12px", color: "var(--text-secondary)" }}>
                Expiring within 7 days (spend these first)
              </h4>
              {bucketTable(summary.expiringSoon)}
            </div>
          ) : null}

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
      {expiry.isFetching && !expiry.isPending ? (
        <div
          style={{
            position: "absolute",
            top: "12px",
            right: "14px",
            color: "var(--text-secondary)",
          }}
        >
          <Loader2 size={14} className="animate-spin" />
        </div>
      ) : null}
    </Dialog>
  );
}
