import { FlaskConical, ListChecks, PackageX, RotateCcw, Square } from "lucide-react";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { ProviderIcon } from "../components/ProviderIcon";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Inline } from "../components/ui/inline";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { Stack } from "../components/ui/stack";
import { DataTable, StatCard } from "../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import {
  invalidateProviderAccounts,
  useProviderAccounts,
  useProviderModels,
  useProviders,
} from "../lib/hooks/providers";
import { providerDisplayName } from "../lib/provider-names";
import {
  MAX_PROBE_ROWS,
  PROBE_CONCURRENCY,
  PROBE_FILTER_OPTIONS,
  enabledModelOptions,
  orderProbeRows,
  type ProbeFilter,
  type ProbeRowState,
} from "./account-probe-model";
import { getProbeRunStore } from "./account-probe-run";

const PENDING_STATE: ProbeRowState = { status: "pending" };

function statusBadge(state: ProbeRowState): ReactNode {
  switch (state.status) {
    case "ok":
      return <Badge tone="ok">OK</Badge>;
    case "failed":
      return <Badge tone="err">Failed</Badge>;
    case "running":
      return <Badge tone="info">Running</Badge>;
    default:
      return <Badge tone="default">Pending</Badge>;
  }
}

function rowDetail(state: ProbeRowState): string {
  switch (state.status) {
    case "ok":
      return `${state.latencyMs ?? 0} ms`;
    case "failed":
      return [state.error ?? "Probe failed", ...(state.statusCode === undefined ? [] : [`HTTP ${state.statusCode}`])].join(" · ");
    case "running":
      return "Probing…";
    default:
      return "—";
  }
}

/**
 * Probes every account of one provider, one account at a time, bounded to
 * {@link PROBE_CONCURRENCY} in flight.
 *
 * The run itself lives in the module-level store (`account-probe-run`), so
 * navigating away does not stop it and a reload still shows the persisted
 * snapshot. The batch endpoint (`POST /providers/:id/accounts/probe`) is
 * deliberately not used: on a provider with thousands of accounts it blocks
 * for minutes with no progress.
 */
export default function AccountProbeAll(): ReactNode {
  const { providerId } = useParams<{ providerId: string }>();
  const id = providerId ?? "";
  const providersQuery = useProviders();
  const modelsQuery = useProviderModels(id);
  const accountsQuery = useProviderAccounts(id);
  const queryClient = useQueryClient();
  const store = useMemo(() => getProbeRunStore(id), [id]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const [filter, setFilter] = useState<ProbeFilter>("all");
  const [chosenModel, setChosenModel] = useState("");

  const provider = (providersQuery.data ?? []).find((item) => item.providerId === id);
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const options = useMemo(
    () => enabledModelOptions(modelsQuery.data ?? []),
    [modelsQuery.data],
  );
  const modelId = options.some((option) => option.value === chosenModel)
    ? chosenModel
    : (options[0]?.value ?? "");
  const name = providerDisplayName(id, provider?.label);
  const rows = snapshot.rows;
  const running = snapshot.status === "running";

  const startRun = () => {
    store.start({
      providerId: id,
      modelId,
      accountIds: accounts.map((account) => account.id),
      // The store owns the end of the run, so this still fires when the page
      // was unmounted before the run finished.
      onInvalidate: () => {
        void invalidateProviderAccounts(queryClient, id).catch(() => undefined);
      },
    });
  };

  const states = useMemo(
    () => accounts.map((account) => rows[account.id] ?? PENDING_STATE),
    [accounts, rows],
  );
  const okCount = states.filter((state) => state.status === "ok").length;
  const failedCount = states.filter((state) => state.status === "failed").length;
  const remainingCount = accounts.length - okCount - failedCount;

  const orderedRows = useMemo(() => {
    const entries = accounts
      .map((account) => ({ account, state: rows[account.id] ?? PENDING_STATE }))
      .filter(({ state }) => {
        if (filter === "failed") return state.status === "failed";
        if (filter === "ok") return state.status === "ok";
        return true;
      })
      .map((entry) => ({ ...entry, status: entry.state.status }));
    return orderProbeRows(entries);
  }, [accounts, filter, rows]);
  const visibleRows = orderedRows.slice(0, MAX_PROBE_ROWS);
  const hiddenCount = orderedRows.length - visibleRows.length;

  if (providersQuery.isPending) return <LoadingState label="Loading provider..." />;
  if (providersQuery.isError)
    return (
      <ErrorState
        title="Unable to load providers"
        message="The provider catalog could not be read, so this page cannot resolve its provider."
        onRetry={() => void providersQuery.refetch()}
        retrying={providersQuery.isFetching}
      />
    );
  if (!provider)
    return (
      <EmptyState
        icon={<PackageX size={20} />}
        title="Provider not found"
        message={`No provider named “${id}”. It may have been removed, or the link is stale.`}
      />
    );

  const canStart = modelId !== "" && accounts.length > 0 && !running;

  return (
    <Stack gap="16px">
      <PageHeader
        title={name}
        description={`Probe every account · ${accounts.length} account${accounts.length === 1 ? "" : "s"}`}
        icon={<ProviderIcon icon={provider.providerId} name={name} size={28} />}
        back={{ to: `/providers/${encodeURIComponent(id)}`, label: `Back to ${name}` }}
      />

      <Card>
        <CardBody>
          <Inline gap="12px" wrap>
            <Select
              id="probe-all-model"
              label="Model"
              aria-label="Probe model"
              size="sm"
              value={modelId}
              onValueChange={setChosenModel}
              options={options}
              disabled={running || options.length === 0}
              placeholder={options.length === 0 ? "No enabled model" : "Select…"}
              style={{ minWidth: "220px" }}
            />
            <Button
              variant="primary"
              size="sm"
              icon={<FlaskConical size={13} />}
              loading={running}
              disabled={!canStart}
              onClick={startRun}
              title={
                canStart
                  ? `Probe ${accounts.length} accounts, ${PROBE_CONCURRENCY} at a time`
                  : "Pick an enabled model and connect at least one account"
              }
            >
              Test All Accounts
            </Button>
            {running ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Square size={13} />}
                onClick={() => store.stop()}
                title="Stop after the probes already in flight finish"
              >
                Stop
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCcw size={13} />}
              disabled={running || snapshot.status === "idle"}
              onClick={() => store.clear()}
              title="Discard the stored results for this provider"
            >
              Reset
            </Button>
          </Inline>
          {snapshot.status === "interrupted" ? (
            <p style={{ margin: "8px 0 0", fontSize: "12px", color: "var(--text-tertiary)" }}>
              Previous run stopped when the page was reloaded.
            </p>
          ) : null}
          {modelsQuery.isError ? (
            <p style={{ margin: "8px 0 0", fontSize: "12px", color: "var(--status-danger, #e5484d)" }}>
              Failed to load models — an enabled model is required before probing.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <div className="metric-grid">
        <StatCard label="Total" value={String(accounts.length)} detail="accounts in scope" tone="accent" />
        <StatCard label="OK" value={String(okCount)} detail="reported successfully" tone="green" />
        <StatCard label="Failed" value={String(failedCount)} detail="last probe errored" tone="red" />
        <StatCard label="Remaining" value={String(remainingCount)} detail="pending or in flight" tone="orange" />
      </div>

      <Card>
        <CardHeader
          title="Results"
          subtitle={
            orderedRows.length > MAX_PROBE_ROWS
              ? `Showing first ${MAX_PROBE_ROWS} of ${orderedRows.length} — failures first`
              : "Failures first, then OK, then pending"
          }
          icon={<ListChecks size={16} />}
          action={
            <Select
              size="sm"
              aria-label="Filter results"
              value={filter}
              onValueChange={(next) => setFilter(next as ProbeFilter)}
              options={PROBE_FILTER_OPTIONS}
              style={{ minWidth: "110px" }}
            />
          }
        />
        <CardBody style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {accountsQuery.isPending ? (
            <LoadingState label="Loading accounts..." />
          ) : accountsQuery.isError ? (
            <ErrorState
              message="Failed to load accounts"
              onRetry={() => void accountsQuery.refetch()}
            />
          ) : accounts.length === 0 ? (
            <EmptyState
              title="No accounts connected"
              message="Add an API key or OAuth credential before probing this provider."
            />
          ) : visibleRows.length === 0 ? (
            <p style={{ margin: 0, fontSize: "12px", color: "var(--text-tertiary)" }}>
              No account matches this filter yet.
            </p>
          ) : (
            <DataTable headers={["Account", "Status", "Detail"]}>
              {visibleRows.map(({ account, state }) => (
                <tr key={account.id}>
                  <td>{account.label || account.id.slice(0, 8)}</td>
                  <td>{statusBadge(state)}</td>
                  <td style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>
                    {rowDetail(state)}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
          {hiddenCount > 0 ? (
            <p style={{ margin: 0, fontSize: "11px", color: "var(--text-tertiary)" }}>
              +{hiddenCount} more hidden (cap {MAX_PROBE_ROWS} rows) — narrow the filter to see them.
            </p>
          ) : null}
        </CardBody>
      </Card>
    </Stack>
  );
}
