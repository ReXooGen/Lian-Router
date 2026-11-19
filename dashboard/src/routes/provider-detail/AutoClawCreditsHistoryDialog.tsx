import { ChevronDown, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Inline } from "../../components/ui/inline";
import {
  useAutoClawCreditsHistory,
  type AutoClawCreditsHistoryDirection,
  type AutoClawLedgerEntry,
} from "../../lib/hooks/quota";

/** The three views the vendor's ledger route accepts. */
const DIRECTIONS: readonly { readonly id: AutoClawCreditsHistoryDirection; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "income", label: "Added" },
  { id: "expense", label: "Spent" },
];

function formatAmount(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toLocaleString("en-US")}`;
}

/**
 * The local date and time of a ledger movement.
 *
 * The vendor stamps `occurred_at` with its own offset; rendering it in the
 * operator's zone is the whole point of a history view, so the value is parsed
 * rather than sliced. An unparseable stamp is shown verbatim instead of
 * "Invalid Date", which would look like a bug in the ledger itself.
 */
function formatMoment(raw: string): string {
  if (raw.length === 0) return "—";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function LedgerRow({ entry }: { readonly entry: AutoClawLedgerEntry }): ReactNode {
  const credit = entry.direction === "credit" || entry.amount > 0;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: "4px 12px",
        padding: "9px 12px",
        border: "1px solid var(--inner-border)",
        borderRadius: "8px",
        background: "var(--surface-2)",
      }}
    >
      <span
        style={{
          fontSize: "12.5px",
          color: "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={entry.description}
      >
        {entry.description.length > 0 ? entry.description : "Points movement"}
      </span>
      <span
        style={{
          fontSize: "13px",
          fontWeight: 600,
          textAlign: "right",
          color: credit ? "var(--success)" : "var(--text-primary)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatAmount(entry.amount)}
      </span>
      <Inline gap="8px">
        <span style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>
          {formatMoment(entry.occurredAt)}
        </span>
        {entry.walletScope !== null ? <Badge tone="default">{entry.walletScope}</Badge> : null}
      </Inline>
      <span />
    </div>
  );
}

/**
 * The account's points ledger.
 *
 * Two questions drive this surface, and the vendor answers both from one
 * stream with a signed amount: "where did the points go" (model charges are
 * negative) and "what did I earn" (grants are positive). The filter narrows the
 * read upstream instead of filtering locally, so a page always means the same
 * thing on both sides.
 */
export function AutoClawCreditsHistoryDialog({
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
  const [direction, setDirection] = useState<AutoClawCreditsHistoryDirection>("all");
  const history = useAutoClawCreditsHistory(accountId, direction, open);

  const pages = history.data?.pages ?? [];
  const entries: readonly AutoClawLedgerEntry[] = pages.flatMap((page) => page.entries ?? []);
  const failed = pages.find((page) => page.ok === false) ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Credit history"
      description={`Points added and spent by ${accountLabel}`}
      width={560}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "2px 0" }}>
        <Inline gap="6px">
          {DIRECTIONS.map((option) => (
            <Button
              key={option.id}
              variant={direction === option.id ? "primary" : "ghost"}
              size="sm"
              onClick={() => setDirection(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </Inline>
        {history.isPending ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              color: "var(--text-secondary)",
            }}
          >
            <Loader2 size={13} className="animate-spin" /> Reading the ledger…
          </span>
        ) : null}
        {failed !== null ? (
          <p style={{ margin: 0, fontSize: "12px", color: "var(--error)" }}>
            {failed.error ?? "The ledger could not be read."}
          </p>
        ) : null}
        {history.isError ? (
          <p style={{ margin: 0, fontSize: "12px", color: "var(--error)" }}>
            The ledger could not be read. Retry in a moment.
          </p>
        ) : null}
        {!history.isPending && entries.length === 0 ? (
          <p style={{ margin: 0, fontSize: "12px", color: "var(--text-secondary)" }}>
            Nothing recorded for this filter yet.
          </p>
        ) : null}
        {entries.map((entry) => (
          <LedgerRow key={entry.id} entry={entry} />
        ))}
        {history.hasNextPage ? (
          <Button
            variant="secondary"
            size="sm"
            icon={
              history.isFetchingNextPage ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <ChevronDown size={13} />
              )
            }
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
