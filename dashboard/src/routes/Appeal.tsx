import { LifeBuoy, MessageSquareWarning, RefreshCw, Send, ShieldBan, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Inline } from "../components/ui/inline";
import { Input } from "../components/ui/input";
import { DataTable, StatCard } from "../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Toolbar } from "../components/ui/toolbar";
import { useAppealAccounts, useAppealRecheck, useAppealSend } from "../lib/hooks/appeal";
import type {
  AppealAccountRow,
  AppealRecheckResponse,
  AppealRecheckResult,
  AppealSendResponse,
  AppealStatusFilter,
} from "../lib/contracts";
import { formatTimeAgo } from "../lib/format";
import { getErrorMessage } from "../lib/helpers";
import { toast } from "../lib/toast";
import {
  APPEAL_MESSAGE_MAX_LENGTH,
  APPEAL_RECHECK_DEFAULT,
  APPEAL_RECHECK_MAX,
  APPEAL_RECHECK_MIN,
  APPEAL_RESULT_RENDER_CAP,
  APPEAL_SEND_DEFAULT,
  APPEAL_SEND_MAX,
  APPEAL_SEND_MIN,
  APPEAL_STATUS_OPTIONS,
  appealPageCount,
  appealPageSlice,
  appealStateOf,
  applyAppealFilter,
  beginAppealRecheck,
  beginAppealSend,
  clampAppealLimit,
  clampAppealRecheckLimit,
} from "./appeal-model";

/**
 * CodeBuddy appeal console.
 *
 * One job: show which accounts the upstream banned (the health classifier's
 * `policy_blocked_banned` verdict), which of those already have an accepted
 * appeal ticket, and fire the appeal POST for the rest — one by one, with a
 * bounded batch. Everything here is a view of `/automation/appeal/*`.
 */

export function AppealStateCell({ row }: { readonly row: AppealAccountRow }): ReactNode {
  const state = appealStateOf(row);
  if (state === "accepted") {
    return (
      <span title={row.verdictCheckedAt ?? undefined}>
        <Badge tone="ok">Accepted</Badge>
      </span>
    );
  }
  if (state === "declined") {
    return (
      <span title={row.verdictCheckedAt ?? undefined}>
        <Badge tone="err">Declined</Badge>
      </span>
    );
  }
  if (state === "appealed") {
    return (
      <span
        title={
          row.feedbackId !== null
            ? `feedback_id ${row.feedbackId}`
            : (row.appealedAt ?? "appealed")
        }
      >
        <Badge tone="ok">Appealed</Badge>
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span title={row.lastAppealError ?? undefined}>
        <Badge tone="err">Failed</Badge>
      </span>
    );
  }
  return <Badge tone="default">Pending</Badge>;
}

function ResultLine({ result }: { readonly result: AppealSendResponse["results"][number] }): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        fontSize: "11.5px",
        minWidth: 0,
      }}
    >
      <Badge tone={result.error ? "err" : "ok"}>{result.state}</Badge>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {result.label}
      </span>
      {result.feedbackId !== null ? (
        <span
          title={`feedback_id ${result.feedbackId}`}
          style={{ color: "var(--text-tertiary)", whiteSpace: "nowrap" }}
        >
          #{result.feedbackId}
        </span>
      ) : null}
      {result.error ? (
        <span
          title={result.error}
          style={{
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {result.error}
        </span>
      ) : null}
    </div>
  );
}

/** One re-check result, laid out like `ResultLine` but keyed on the verdict. */
export function VerdictLine({
  result,
}: {
  readonly result: AppealRecheckResult;
}): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        fontSize: "11.5px",
        minWidth: 0,
      }}
    >
      <Badge
        tone={
          result.verdict === "accepted"
            ? "ok"
            : result.verdict === "declined"
              ? "err"
              : "default"
        }
      >
        {result.verdict}
      </Badge>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {result.label}
      </span>
      {result.error ? (
        <span
          title={result.error}
          style={{
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {result.error}
        </span>
      ) : null}
    </div>
  );
}

export default function Appeal(): ReactNode {
  const [statusFilter, setStatusFilter] = useState<AppealStatusFilter>("all");
  const accountsQuery = useAppealAccounts(statusFilter);
  const send = useAppealSend();
  const recheck = useAppealRecheck();

  const [sendLimit, setSendLimit] = useState(APPEAL_SEND_DEFAULT);
  const [message, setMessage] = useState("");
  const [resend, setResend] = useState(false);
  const [lastRun, setLastRun] = useState<AppealSendResponse | null>(null);
  const [recheckLimit, setRecheckLimit] = useState(APPEAL_RECHECK_DEFAULT);
  const [lastRecheck, setLastRecheck] = useState<AppealRecheckResponse | null>(null);
  const [page, setPage] = useState(1);

  const accounts = accountsQuery.data?.accounts ?? [];
  const counts = accountsQuery.data?.counts;

  const totalPages = appealPageCount(accounts.length);
  const currentPage = Math.min(page, totalPages);
  const visibleAccounts = appealPageSlice(accounts, currentPage);

  const run = send.data ?? lastRun;
  const renderedResults = run ? run.results.slice(0, APPEAL_RESULT_RENDER_CAP) : [];
  const hiddenResults = run ? run.results.length - renderedResults.length : 0;
  const recheckRun = recheck.data ?? lastRecheck;
  const renderedRecheckResults = recheckRun
    ? recheckRun.results.slice(0, APPEAL_RESULT_RENDER_CAP)
    : [];
  const hiddenRecheckResults = recheckRun
    ? recheckRun.results.length - renderedRecheckResults.length
    : 0;

  const sendAppeals = () => {
    beginAppealSend(sendLimit, message, resend, (input) => {
      setSendLimit(input.limit);
      send.mutate(input, {
        onSuccess: (result) => {
          setLastRun(result);
          toast.success(
            `Appeal terkirim ${result.succeeded} dari ${result.attempted}`,
            result.failed > 0 ? `${result.failed} gagal` : null,
          );
        },
        onError: (error) => toast.error("Appeal gagal", getErrorMessage(error)),
      });
    });
  };

  const recheckAppeals = () => {
    beginAppealRecheck(recheckLimit, (input) => {
      setRecheckLimit(input.limit);
      recheck.mutate(input, {
        onSuccess: (result) => {
          setLastRecheck(result);
          toast.success(
            `Re-check: accepted ${result.accepted} · declined ${result.declined} · pending ${result.pending}`,
            `${result.attempted} attempted`,
          );
        },
        onError: (error) => toast.error("Re-check gagal", getErrorMessage(error)),
      });
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {accountsQuery.isLoading ? (
        <LoadingState label="Loading banned accounts…" />
      ) : accountsQuery.isError ? (
        <ErrorState
          title="Unable to load banned accounts"
          message={getErrorMessage(accountsQuery.error, "The appeal API did not answer.")}
          onRetry={() => void accountsQuery.refetch()}
        />
      ) : (
        <>
          {/* 1. Send controls */}
          <Card>
            <CardHeader
              title="Send appeal"
              subtitle="Files an appeal for the next pending banned accounts. One upstream POST per account, sequential."
              icon={<LifeBuoy size={15} />}
            />
            <CardBody>
              <Inline gap="12px" wrap align="flex-end">
                <div style={{ width: "160px" }}>
                  <Input
                    id="appeal-send-limit"
                    label="Accounts this run"
                    hint={`${APPEAL_SEND_MIN}–${APPEAL_SEND_MAX}`}
                    type="number"
                    min={APPEAL_SEND_MIN}
                    max={APPEAL_SEND_MAX}
                    value={sendLimit}
                    disabled={send.isPending}
                    onChange={(event) => setSendLimit(clampAppealLimit(event.target.value))}
                  />
                </div>
                <Button
                  variant="primary"
                  icon={<Send size={14} />}
                  loading={send.isPending}
                  disabled={send.isPending}
                  onClick={sendAppeals}
                >
                  Send appeal
                </Button>
              </Inline>

              <div style={{ marginTop: "12px", maxWidth: "640px" }}>
                <label
                  htmlFor="appeal-message"
                  className="text-xs"
                  style={{ color: "var(--text-secondary)", display: "block", marginBottom: "4px" }}
                >
                  Message (opsional — kosong memakai template bawaan per akun)
                </label>
                <textarea
                  id="appeal-message"
                  value={message}
                  maxLength={APPEAL_MESSAGE_MAX_LENGTH}
                  disabled={send.isPending}
                  onChange={(event) => setMessage(event.target.value)}
                  rows={3}
                  style={{
                    width: "100%",
                    resize: "vertical",
                    borderRadius: "8px",
                    border: "1px solid var(--inner-border)",
                    background: "var(--surface-1)",
                    color: "var(--text-primary)",
                    padding: "8px 10px",
                    fontSize: "12.5px",
                  }}
                />
                <p className="text-xs" style={{ marginTop: "4px", color: "var(--text-tertiary)" }}>
                  {message.length}/{APPEAL_MESSAGE_MAX_LENGTH}
                </p>
              </div>

              <label
                className="text-xs"
                style={{
                  marginTop: "8px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  color: "var(--text-secondary)",
                }}
              >
                <input
                  type="checkbox"
                  checked={resend}
                  disabled={send.isPending}
                  onChange={(event) => setResend(event.target.checked)}
                />
                Re-send termasuk akun yang sudah di-appeal (file tiket kedua)
              </label>

              <p
                className="text-xs"
                data-testid="appeal-progress"
                style={{ marginTop: "10px", color: "var(--text-secondary)" }}
              >
                {send.isPending
                  ? "Batch in flight — attempted 0 / succeeded 0 / failed 0"
                  : run
                    ? `attempted ${run.attempted} / succeeded ${run.succeeded} / failed ${run.failed}`
                    : "No batch yet this session."}
              </p>

              {run && renderedResults.length > 0 ? (
                <div
                  style={{
                    marginTop: "12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  {renderedResults.map((result) => (
                    <ResultLine key={result.accountId} result={result} />
                  ))}
                  {hiddenResults > 0 ? (
                    <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                      +{hiddenResults} more not rendered
                    </span>
                  ) : null}
                </div>
              ) : null}

              <div
                style={{
                  marginTop: "16px",
                  paddingTop: "12px",
                  borderTop: "1px solid var(--inner-border)",
                }}
              >
                <p
                  className="text-xs"
                  style={{ color: "var(--text-secondary)", marginBottom: "8px" }}
                >
                  Re-check already-appealed accounts and record whether the upstream accepted or
                  declined them.
                </p>
                <Inline gap="12px" wrap align="flex-end">
                  <div style={{ width: "170px" }}>
                    <Input
                      id="appeal-recheck-limit"
                      label="Accounts this re-check"
                      hint={`${APPEAL_RECHECK_MIN}–${APPEAL_RECHECK_MAX}`}
                      type="number"
                      min={APPEAL_RECHECK_MIN}
                      max={APPEAL_RECHECK_MAX}
                      value={recheckLimit}
                      disabled={recheck.isPending}
                      onChange={(event) =>
                        setRecheckLimit(clampAppealRecheckLimit(event.target.value))
                      }
                    />
                  </div>
                  <Button
                    variant="secondary"
                    icon={<RefreshCw size={14} />}
                    loading={recheck.isPending}
                    disabled={recheck.isPending}
                    onClick={recheckAppeals}
                  >
                    Re-check appeals
                  </Button>
                </Inline>

                <p
                  className="text-xs"
                  data-testid="appeal-recheck-progress"
                  style={{ marginTop: "10px", color: "var(--text-secondary)" }}
                >
                  {recheck.isPending
                    ? "Re-check in flight — accepted 0 / declined 0 / pending 0"
                    : recheckRun
                      ? `accepted ${recheckRun.accepted} / declined ${recheckRun.declined} / pending ${recheckRun.pending}`
                      : "No re-check yet this session."}
                </p>

                {recheckRun && renderedRecheckResults.length > 0 ? (
                  <div
                    style={{
                      marginTop: "12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    {renderedRecheckResults.map((result) => (
                      <VerdictLine key={result.accountId} result={result} />
                    ))}
                    {hiddenRecheckResults > 0 ? (
                      <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                        +{hiddenRecheckResults} more not rendered
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </CardBody>
          </Card>

          {/* 2. Progress readout over every banned account */}
          <div className="metric-grid">
            <StatCard
              label="Total"
              value={String(counts?.total ?? 0)}
              detail="banned cb accounts"
              icon={<Users size={12} />}
              tone="accent"
            />
            <StatCard
              label="Appealed"
              value={String(counts?.appealed ?? 0)}
              detail="upstream acknowledged"
              icon={<ShieldCheck size={12} />}
              tone="green"
            />
            <StatCard
              label="Accepted"
              value={String(counts?.accepted ?? 0)}
              detail="appeal accepted"
              icon={<ShieldCheck size={12} />}
              tone="green"
            />
            <StatCard
              label="Declined"
              value={String(counts?.declined ?? 0)}
              detail="appeal declined"
              icon={<ShieldBan size={12} />}
              tone="red"
            />
            <StatCard
              label="Pending"
              value={String(counts?.pending ?? 0)}
              detail="no accepted appeal yet"
              icon={<MessageSquareWarning size={12} />}
              tone="orange"
            />
            <StatCard
              label="Failed"
              value={String(counts?.failed ?? 0)}
              detail="last attempt errored"
              icon={<TriangleAlert size={12} />}
              tone="red"
            />
          </div>

          {/* 3. Banned account list */}
          <Card>
            <CardHeader
              title="Banned accounts"
              subtitle="From the health classifier (policy_blocked_banned). Never-appealed first. Paginated 25 per page."
              icon={<ShieldBan size={15} />}
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RefreshCw size={13} />}
                  loading={accountsQuery.isFetching}
                  onClick={() => void accountsQuery.refetch()}
                >
                  Refresh
                </Button>
              }
            />
            <CardBody>
              <Toolbar meta={`Page ${currentPage} of ${totalPages}`}>
                <div
                  role="group"
                  aria-label="Filter by appeal state"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "2px",
                    flexWrap: "wrap",
                    padding: "2px",
                    borderRadius: "8px",
                    border: "1px solid var(--inner-border)",
                    background: "var(--surface-1)",
                  }}
                >
                  {APPEAL_STATUS_OPTIONS.map((option) => (
                    <Button
                      key={option.value}
                      size="sm"
                      variant={statusFilter === option.value ? "primary" : "ghost"}
                      aria-pressed={statusFilter === option.value}
                      onClick={() =>
                        applyAppealFilter(option.value, {
                          setStatus: setStatusFilter,
                          setPage,
                        })
                      }
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                >
                  Prev
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                >
                  Next
                </Button>
              </Toolbar>

              {accounts.length === 0 ? (
                <EmptyState
                  title="No banned accounts"
                  message={
                    statusFilter === "all"
                      ? "Nothing to appeal: no account carries the upstream ban verdict."
                      : "No account matches this filter."
                  }
                />
              ) : (
                <DataTable headers={["Account", "Status", "Banned since", "Appeal state", "Last attempt"]}>
                  {visibleAccounts.map((row) => (
                    <tr key={row.id}>
                      <td style={{ fontWeight: 600 }}>{row.label}</td>
                      <td>
                        <Badge tone={row.status === "active" ? "ok" : "default"}>{row.status}</Badge>
                      </td>
                      <td style={{ color: "var(--text-secondary)" }}>
                        <span title={row.lastErrorAt ?? undefined}>
                          {formatTimeAgo(row.lastErrorAt)}
                        </span>
                      </td>
                      <td>
                        <AppealStateCell row={row} />
                      </td>
                      <td style={{ color: "var(--text-secondary)" }}>
                        <span title={row.lastAppealError ?? row.appealedAt ?? undefined}>
                          {row.appealedAt
                            ? formatTimeAgo(row.appealedAt)
                            : (row.lastAppealError ?? "—")}
                        </span>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
