/**
 * Public model-status page (`/status`).
 *
 * Reads the unauthenticated `GET /status/models` aggregate and renders one
 * timeline per model: sixty buckets over the last day, the same shape an
 * operator reads on a hosted status page. Nothing here is authenticated and
 * nothing is themeable — like the share page, it must look the same to every
 * visitor.
 *
 * The page owns no health *decisions*: state words, bucket colours, and the
 * success percentage all come from the server, so the page and any future
 * consumer cannot disagree about what "degraded" means. This file draws them.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";

import { BrandMark } from "../../components/BrandMark";


/** The console entry, matching the landing page's own constant. */
const CONSOLE_LOGIN_PATH = "/console/login";

/** One bucket of one model's timeline. */
interface StatusBucket {
  readonly at: string;
  readonly state: "ok" | "degraded" | "down" | "idle";
  readonly requests: number;
  readonly failures: number;
}

/** One model's status row, as the server reports it. */
interface StatusModel {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly successPercent: number | null;
  readonly state: "ok" | "degraded" | "down" | "idle";
  readonly coolingUntil: string | null;
  readonly requests: number;
  readonly failures: number;
  /** Absent when the model saw no traffic in the window. */
  readonly buckets?: readonly StatusBucket[];
}

interface StatusReport {
  readonly windowHours: number;
  readonly bucketMinutes: number;
  readonly generatedAt: string;
  readonly summary: {
    readonly models: number;
    readonly healthy: number;
    readonly degraded: number;
    readonly down: number;
  };
  readonly models: readonly StatusModel[];
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly report: StatusReport };

/** Poll cadence. The server caches for 30s, so a faster poll only re-reads it. */
const POLL_MS = 60_000;

const BUCKET_COLOUR: Record<StatusBucket["state"], string> = {
  ok: "var(--st-ok)",
  degraded: "var(--st-warn)",
  down: "var(--st-bad)",
  idle: "var(--st-idle)",
};

/** Bucket count to draw when the server omits a timeline (no traffic). */
const IDLE_BUCKETS = 60;

function stateLabel(model: StatusModel): string {
  if (model.coolingUntil !== null) return "Cooling";
  switch (model.state) {
    case "down":
      return "High errors";
    case "degraded":
      return "Degraded";
    case "ok":
      return "Operational";
    default:
      return "No data";
  }
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
}

function Timeline({ model }: { readonly model: StatusModel }): ReactElement {
  const buckets = model.buckets;
  if (buckets === undefined) {
    return (
      <div className="st-bars" aria-hidden="true">
        {Array.from({ length: IDLE_BUCKETS }, (_, index) => (
          <span key={index} className="st-bar" style={{ background: BUCKET_COLOUR.idle }} />
        ))}
      </div>
    );
  }
  return (
    <div className="st-bars" aria-hidden="true">
      {buckets.map((bucket) => (
        <span
          key={bucket.at}
          className="st-bar"
          style={{ background: BUCKET_COLOUR[bucket.state] }}
          title={
            bucket.requests === 0
              ? `${formatClock(bucket.at)} · no requests`
              : `${formatClock(bucket.at)} · ${bucket.requests - bucket.failures}/${bucket.requests} ok`
          }
        />
      ))}
    </div>
  );
}

function ModelRow({ model }: { readonly model: StatusModel }): ReactElement {
  return (
    <article className="st-row">
      <header className="st-row-head">
        <span className="st-model">{model.modelId}</span>
        <span className="st-model-id">{model.id}</span>
        <span className={`st-state st-state-${model.state}`}>{stateLabel(model)}</span>
        <span className="st-success">
          {model.successPercent === null ? "" : `${model.successPercent}% success`}
        </span>
      </header>
      <Timeline model={model} />
      {model.coolingUntil !== null ? (
        <p className="st-note">
          Cooling until {formatClock(model.coolingUntil)}
          {model.failures > 0 ? ` · ${model.failures} failed in the last ${model.requests} requests` : ""}
        </p>
      ) : null}
    </article>
  );
}

export function StatusPage(): ReactElement {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const response = await fetch("/status/models", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`status endpoint answered ${response.status}`);
      const report = (await response.json()) as StatusReport;
      setState({ kind: "ready", report });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "could not read model status",
      });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // Models with traffic first, then alphabetical: a visitor wants the ones
  // something happened to, and an untouched catalog is noise below them.
  const ordered = useMemo(() => {
    if (state.kind !== "ready") return [];
    return [...state.report.models]
      .filter((model) => model.requests > 0 || model.coolingUntil !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
  }, [state]);

  const idleCount =
    state.kind === "ready" ? state.report.models.length - ordered.length : 0;

  return (
    <div className="st">
      <div className="st-shell">
        <header className="st-head">
          <a className="st-back" href="/">
            <ArrowLeft size={14} aria-hidden={true} />
            LianRouter
          </a>
          <h1 className="st-title">Models status</h1>
          <p className="st-sub">Service health timelines for every published model.</p>
        </header>

        {state.kind === "ready" ? (
          <div className={`st-banner st-banner-${state.report.summary.down > 0 ? "bad" : state.report.summary.degraded > 0 ? "warn" : "ok"}`}>
            <span className="st-banner-text">
              {state.report.summary.down > 0
                ? `${state.report.summary.down} model${state.report.summary.down === 1 ? "" : "s"} failing.`
                : state.report.summary.degraded > 0
                  ? `${state.report.summary.degraded} model${state.report.summary.degraded === 1 ? "" : "s"} degraded.`
                  : "All models operational."}
            </span>
            <span className="st-banner-meta">
              last {state.report.windowHours}h · {state.report.bucketMinutes}m buckets · updated{" "}
              {formatClock(state.report.generatedAt)}
              <button
                type="button"
                className="st-refresh"
                onClick={() => void load()}
                disabled={refreshing}
                aria-label="Refresh model status"
              >
                <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} aria-hidden={true} />
              </button>
            </span>
          </div>
        ) : null}

        {state.kind === "loading" ? (
          <p className="st-message">Reading model status…</p>
        ) : state.kind === "error" ? (
          <div className="st-banner st-banner-warn">
            <span className="st-banner-text">Status is temporarily unavailable.</span>
            <span className="st-banner-meta">{state.message}</span>
          </div>
        ) : ordered.length === 0 ? (
          <p className="st-message">
            No model has served a request in the last {state.report.windowHours} hours.
          </p>
        ) : (
          <div className="st-list">
            {ordered.map((model) => (
              <ModelRow key={model.id} model={model} />
            ))}
          </div>
        )}

        {state.kind === "ready" && idleCount > 0 ? (
          <p className="st-idle-note">
            {idleCount} other model{idleCount === 1 ? "" : "s"} published no traffic in this window.
          </p>
        ) : null}

        <footer className="st-foot">
          <a href={CONSOLE_LOGIN_PATH}>
            Enter console
            <ArrowRight size={13} aria-hidden={true} />
          </a>
          <span className="st-brand">
            <BrandMark />
            LianRouter
          </span>
        </footer>
      </div>
    </div>
  );
}

export default StatusPage;
