import { Activity, CheckCircle2, Clock3, RefreshCw, Send, TriangleAlert, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Inline } from "../components/ui/inline";
import { Input } from "../components/ui/input";
import { DataTable, StatCard } from "../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Switch } from "../components/ui/switch";
import { Toolbar } from "../components/ui/toolbar";
import { useHitReport, useReportAccounts, useSaveReportSchedule } from "../lib/hooks/automation";
import { useQuotaOverview, type QuotaEntry, type QuotaWindow } from "../lib/hooks/quota";
import type { ReportAccountRow, ReportStatusFilter } from "../lib/contracts";
import { formatTimeAgo } from "../lib/format";
import {
  formatQuotaWindowLabel,
  formatResetDistance,
  quotaBarTone,
} from "../lib/quota-formatters";
import { getErrorMessage } from "../lib/helpers";
import { toast } from "../lib/toast";
import {
  applyStatusFilter,
  beginHit,
  beginScheduleSave,
  clampHitLimit,
  clampIntervalMinutes,
  hitStateOf,
  pageCount,
  pageSlice,
  REPORT_HIT_DEFAULT,
  REPORT_HIT_MAX,
  REPORT_HIT_MIN,
  REPORT_INTERVAL_DEFAULT,
  REPORT_INTERVAL_MAX,
  REPORT_INTERVAL_MIN,
  REPORT_QUOTA_WINDOW_CAP,
  REPORT_RESULT_RENDER_CAP,
  REPORT_STATUS_OPTIONS,
  scheduleSummary,
} from "./automation-model";

/**
 * CodeBuddy growth-activity report console.
 *
 * One job: pick how many `cb` accounts to hit, fire the report, and read back
 * which accounts landed and which did not. Everything on this page is a view of
 * `/automation/report/*`; the quota column is a peek at the existing
 * `/quota/overview` projection joined by account id, not a second quota page.
 */

/**
 * One quota window, rendered with the same visual language as Quota Management
 * (`QuotaCard`): label + percentage, pill bar, then `used · limit` against the
 * reset distance. Compact only in type scale, not in information.
 */
function QuotaWindowRow({ window }: { readonly window: QuotaWindow }): ReactNode {
  const remaining = window.remainingPercent ?? null;
  const usedPercent = window.usedPercent ?? null;
  const limit = window.limit ?? null;
  const colors = quotaBarTone(remaining);
  const fill = remaining === null ? 0 : Math.max(0, Math.min(100, remaining));
  const usage =
    usedPercent === null && limit === null
      ? ""
      : `${usedPercent !== null ? `${usedPercent}% used` : ""}${
          limit !== null
            ? `${usedPercent !== null ? " · " : ""}limit ${limit.toLocaleString()}`
            : ""
        }`;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <span style={{ fontSize: "10.5px", fontWeight: 600, color: "var(--text-primary)" }}>
          {formatQuotaWindowLabel(window.label)}
        </span>
        {remaining !== null ? (
          <span
            style={{
              fontSize: "10.5px",
              fontWeight: 700,
              color: colors.text,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {remaining}%
          </span>
        ) : null}
      </div>
      <div
        style={{
          height: "5px",
          borderRadius: "9999px",
          background: "var(--inner-border)",
          overflow: "hidden",
          marginTop: "3px",
        }}
      >
        <div
          style={{ width: `${fill}%`, height: "100%", borderRadius: "9999px", background: colors.bar }}
        />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          marginTop: "2px",
          fontSize: "9.5px",
          color: "var(--text-tertiary)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>{usage}</span>
        {window.resetsAt ? <span>{formatResetDistance(window.resetsAt, window.recurring)}</span> : null}
      </div>
    </div>
  );
}

/**
 * The account row's quota peek: the cached overview projection joined by id,
 * capped at four windows so a full page renders at most 100 bars.
 */
function QuotaCell({ entry }: { readonly entry: QuotaEntry | undefined }): ReactNode {
  const windows = entry?.quota?.windows ?? [];
  if (!entry || !entry.quota || windows.length === 0) {
    const message = !entry ? "not tracked" : !entry.quota ? "no cached quota" : "no windows";
    return <span style={{ color: "var(--text-tertiary)" }}>{message}</span>;
  }
  const shown = windows.slice(0, REPORT_QUOTA_WINDOW_CAP);
  const hidden = windows.length - shown.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "7px", minWidth: "150px" }}>
      {shown.map((window, index) => (
        <QuotaWindowRow
          key={`${window.kind ?? window.label}:${window.resetsAt ?? "none"}:${index}`}
          window={window}
        />
      ))}
      {hidden > 0 ? (
        <span style={{ fontSize: "9.5px", color: "var(--text-tertiary)" }}>+{hidden} more</span>
      ) : null}
    </div>
  );
}

function HitStateCell({ row }: { readonly row: ReportAccountRow }): ReactNode {
  const state = hitStateOf(row);
  if (state === "failed") {
    return (
      <span title={row.lastError ?? undefined}>
        <Badge tone="err">Failed</Badge>
      </span>
    );
  }
  if (state === "hit") {
    return (
      <span title={row.lastState ?? undefined}>
        <Badge tone="ok">Hit</Badge>
      </span>
    );
  }
  return <Badge tone="default">Never</Badge>;
}

export default function Automation(): ReactNode {
  const [statusFilter, setStatusFilter] = useState<ReportStatusFilter>("all");
  const accountsQuery = useReportAccounts(statusFilter);
  const hitReport = useHitReport();
  const saveSchedule = useSaveReportSchedule();

  const [hitLimit, setHitLimit] = useState(REPORT_HIT_DEFAULT);
  const [page, setPage] = useState(1);
  const [showQuota, setShowQuota] = useState(false);

  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleAccounts, setScheduleAccounts] = useState(REPORT_HIT_DEFAULT);
  const [scheduleInterval, setScheduleInterval] = useState(REPORT_INTERVAL_DEFAULT);
  const [savedSchedule, setSavedSchedule] = useState<string>("Off");

  const quota = useQuotaOverview({ enabled: showQuota });

  const accounts = accountsQuery.data?.accounts ?? [];
  const counts = accountsQuery.data?.counts;
  const schedule = accountsQuery.data?.schedule;

  // Adopt the server schedule whenever it changes: the card is an editor over
  // the saved row, not a second source of truth.
  useEffect(() => {
    if (!schedule) return;
    setScheduleEnabled(schedule.enabled);
    setScheduleAccounts(schedule.accountsPerRun);
    setScheduleInterval(schedule.intervalMinutes);
    setSavedSchedule(
      scheduleSummary(schedule.enabled, schedule.accountsPerRun, schedule.intervalMinutes),
    );
  }, [schedule]);

  const quotaById = useMemo(() => {
    const map = new Map<string, QuotaEntry>();
    for (const entry of quota.data?.accounts ?? []) map.set(entry.id, entry);
    return map;
  }, [quota.data?.accounts]);

  const totalPages = pageCount(accounts.length);
  const currentPage = Math.min(page, totalPages);
  const visibleAccounts = pageSlice(accounts, currentPage);

  const run = hitReport.data;
  const renderedResults = run ? run.results.slice(0, REPORT_RESULT_RENDER_CAP) : [];
  const hiddenResults = run ? run.results.length - renderedResults.length : 0;

  const runHit = () => {
    beginHit(hitLimit, (limit) => {
      setHitLimit(limit);
      hitReport.mutate(limit, {
        onSuccess: (result) => {
          toast.success(
            `Hit ${result.succeeded} of ${result.attempted}`,
            result.failed > 0 ? `${result.failed} failed` : null,
          );
        },
        onError: (error) => toast.error("Report run failed", getErrorMessage(error)),
      });
    });
  };

  const saveScheduleRow = () => {
    beginScheduleSave(
      {
        enabled: scheduleEnabled,
        accountsPerRun: scheduleAccounts,
        intervalMinutes: scheduleInterval,
      },
      (input) => {
        setScheduleAccounts(input.accountsPerRun);
        setScheduleInterval(input.intervalMinutes);
        saveSchedule.mutate(input, {
          onSuccess: (saved) => {
            setSavedSchedule(
              scheduleSummary(saved.enabled, saved.accountsPerRun, saved.intervalMinutes),
            );
            toast.success(
              "Schedule saved",
              scheduleSummary(saved.enabled, saved.accountsPerRun, saved.intervalMinutes),
            );
          },
          onError: (error) => toast.error("Unable to save schedule", getErrorMessage(error)),
        });
      },
    );
  };

  const headers = showQuota
    ? ["Account", "Status", "Hit state", "Last hit", "Quota"]
    : ["Account", "Status", "Hit state", "Last hit"];

  return (
    <div className="flex flex-col gap-4">
      {accountsQuery.isLoading ? (
        <LoadingState label="Loading report accounts…" />
      ) : accountsQuery.isError ? (
        <ErrorState
          title="Unable to load report accounts"
          message={getErrorMessage(accountsQuery.error, "The automation report API did not answer.")}
          onRetry={() => void accountsQuery.refetch()}
        />
      ) : (
        <>
          {/* 2. Hit controls */}
          <Card>
            <CardHeader
              title="Hit now"
              subtitle="Runs the growth-activity report for the next unhit accounts."
              icon={<Send size={15} />}
            />
            <CardBody>
              <Inline gap="12px" wrap align="flex-end">
                <div style={{ width: "160px" }}>
                  <Input
                    id="automation-hit-limit"
                    label="Accounts this run"
                    hint={`${REPORT_HIT_MIN}–${REPORT_HIT_MAX}`}
                    type="number"
                    min={REPORT_HIT_MIN}
                    max={REPORT_HIT_MAX}
                    value={hitLimit}
                    disabled={hitReport.isPending}
                    onChange={(event) => setHitLimit(clampHitLimit(event.target.value))}
                  />
                </div>
                <Button
                  variant="primary"
                  icon={<Send size={14} />}
                  loading={hitReport.isPending}
                  disabled={hitReport.isPending}
                  onClick={runHit}
                >
                  Hit now
                </Button>
              </Inline>

              <p
                className="text-xs"
                data-testid="hit-progress"
                style={{ marginTop: "10px", color: "var(--text-secondary)" }}
              >
                {hitReport.isPending
                  ? `Run in flight — attempted 0 / succeeded 0 / failed 0`
                  : run
                    ? `attempted ${run.attempted} / succeeded ${run.succeeded} / failed ${run.failed}`
                    : "No run yet this session."}
              </p>

              {run && renderedResults.length > 0 ? (
                <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "4px" }}>
                  {renderedResults.map((result) => (
                    <div
                      key={result.accountId}
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
                      {result.error ? (
                        <span
                          title={result.error}
                          style={{ color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {result.error}
                        </span>
                      ) : null}
                    </div>
                  ))}
                  {hiddenResults > 0 ? (
                    <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
                      +{hiddenResults} more not rendered
                    </span>
                  ) : null}
                </div>
              ) : null}
            </CardBody>
          </Card>

          {/* 3. Progress readout */}
          <div className="metric-grid">
            <StatCard
              label="Total"
              value={String(counts?.total ?? 0)}
              detail="cb accounts in scope"
              icon={<Users size={12} />}
              tone="accent"
            />
            <StatCard
              label="Hit"
              value={String(counts?.hit ?? 0)}
              detail="reported successfully"
              icon={<CheckCircle2 size={12} />}
              tone="green"
            />
            <StatCard
              label="Pending"
              value={String(counts?.pending ?? 0)}
              detail="not hit yet"
              icon={<Clock3 size={12} />}
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

          {/* 4 + 5. Account list with quota peek */}
          <Card>
            <CardHeader
              title="Accounts"
              subtitle="Never-hit first. Paginated 25 per page."
              icon={<Activity size={15} />}
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
                  aria-label="Filter by hit state"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "2px",
                    padding: "2px",
                    borderRadius: "8px",
                    border: "1px solid var(--inner-border)",
                    background: "var(--surface-1)",
                  }}
                >
                  {REPORT_STATUS_OPTIONS.map((option) => (
                    <Button
                      key={option.value}
                      size="sm"
                      variant={statusFilter === option.value ? "primary" : "ghost"}
                      aria-pressed={statusFilter === option.value}
                      onClick={() =>
                        applyStatusFilter(option.value, {
                          setStatus: setStatusFilter,
                          setPage,
                        })
                      }
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
                <Switch
                  checked={showQuota}
                  onChange={setShowQuota}
                  label="Show quota"
                  aria-label="Show quota"
                />
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
                  title="No cb accounts"
                  message="Add a CodeBuddy account before running the growth-activity report."
                />
              ) : (
                <DataTable headers={headers}>
                  {visibleAccounts.map((row) => (
                    <tr key={row.id}>
                      <td style={{ fontWeight: 600 }}>{row.label}</td>
                      <td>
                        <Badge tone={row.status === "active" ? "ok" : "default"}>{row.status}</Badge>
                      </td>
                      <td>
                        <HitStateCell row={row} />
                      </td>
                      <td style={{ color: "var(--text-secondary)" }}>
                        <span title={row.hitAt ?? "never hit"}>{formatTimeAgo(row.hitAt)}</span>
                      </td>
                      {showQuota ? (
                        <td style={{ color: "var(--text-secondary)", verticalAlign: "top" }}>
                          {quota.isLoading ? (
                            "…"
                          ) : quota.isError ? (
                            "unavailable"
                          ) : (
                            <QuotaCell entry={quotaById.get(row.id)} />
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </DataTable>
              )}

              {showQuota ? (
                <p className="text-xs" style={{ marginTop: "8px", color: "var(--text-tertiary)" }}>
                  Quota is the cached projection from the quota overview, max four windows per
                  account — open Quota Management to refresh it.
                </p>
              ) : null}
            </CardBody>
          </Card>

          {/* 6. Schedule */}
          <Card>
            <CardHeader
              title="Schedule"
              subtitle={savedSchedule === "Off" ? "Off" : `Saved · ${savedSchedule}`}
              icon={<Clock3 size={15} />}
            />
            <CardBody>
              <Inline gap="12px" wrap align="flex-end">
                <Switch
                  checked={scheduleEnabled}
                  onChange={setScheduleEnabled}
                  label="Enabled"
                  aria-label="Schedule enabled"
                />
                <div style={{ width: "150px" }}>
                  <Input
                    id="automation-schedule-accounts"
                    label="Accounts per run"
                    type="number"
                    min={REPORT_HIT_MIN}
                    max={REPORT_HIT_MAX}
                    value={scheduleAccounts}
                    disabled={!scheduleEnabled}
                    onChange={(event) => setScheduleAccounts(clampHitLimit(event.target.value))}
                  />
                </div>
                <div style={{ width: "150px" }}>
                  <Input
                    id="automation-schedule-interval"
                    label="Interval (minutes)"
                    hint={`${REPORT_INTERVAL_MIN}–${REPORT_INTERVAL_MAX}`}
                    type="number"
                    min={REPORT_INTERVAL_MIN}
                    max={REPORT_INTERVAL_MAX}
                    value={scheduleInterval}
                    disabled={!scheduleEnabled}
                    onChange={(event) => setScheduleInterval(clampIntervalMinutes(event.target.value))}
                  />
                </div>
                <Button
                  variant="primary"
                  loading={saveSchedule.isPending}
                  disabled={saveSchedule.isPending}
                  onClick={saveScheduleRow}
                >
                  Save
                </Button>
              </Inline>
              <p className="text-xs" style={{ marginTop: "10px", color: "var(--text-secondary)" }}>
                {scheduleEnabled
                  ? `every ${scheduleInterval} min · ${scheduleAccounts} accounts`
                  : "Off"}
              </p>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
