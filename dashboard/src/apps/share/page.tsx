import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Activity, Bot, Brain, Check, ChevronDown, Clipboard, Clock3, Eye, Home, Moon, Search, ShieldCheck, Sun, Wrench } from "lucide-react";
import { BrandMark } from "../../components/BrandMark";
import { copyToClipboard } from "../../lib/helpers";
import {
  useShareData,
  type ShareAccessModel,
  type ShareEnrollmentData,
  type ShareUsageActivity,
} from "../../lib/hooks/share-data";

/**
 * Public share-key enrollment.
 *
 * Visual language follows the console shell: plain black canvas, one floating
 * glass nav pill, and glass panels with a brighter top edge. The page carries
 * no background image — depth comes from the panel treatment alone.
 *
 * The accent is a single fixed grey, matching the shell's `--lr-accent`.
 * Nothing on the page is visitor-themeable: a public enrollment surface should
 * look the same for everyone it is handed to.
 */

interface IssueResult {
  readonly key: string;
  readonly keyId: string;
  readonly keyPrefix: string;
  readonly createdAt: string;
}

interface ApiError {
  readonly error?: string | { readonly code?: string; readonly message?: string };
  readonly message?: string;
}

const DEVICE_ID_STORAGE_KEY = "lianrouter.enrollment.deviceId";

/**
 * Stable per-browser enrollment identifier.
 *
 * Generated once in localStorage and re-sent on every issue/reveal so the
 * enrollment page can show this device its own key again after a reload — the
 * "shown once" rule previously turned a lost key into a permanent lockout.
 * It identifies the browser, not the person: the canonical client IP stays
 * the security boundary, and a device id from another network matches nothing.
 */
function enrollmentDeviceId(): string {
  let id = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (id === null) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    id = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
  }
  return id;
}

/**
 * The models this key may call, as copyable chips.
 *
 * A recipient copies these by hand into a client config, so each one is a
 * one-click copy rather than a name buried in a comma-separated sentence, and
 * the whole set copies at once for the paste-into-config case. RAW is the flat
 * list the gateway itself matches; GROUPED buckets by provider prefix so a long
 * allowlist stays scannable. Both views copy the same underlying names — the
 * grouping is presentation only and never changes what is sent.
 */
function compactNumber(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return value.toLocaleString();
}

function sourceLabel(source: string | null): string {
  if (source === "discovered") return "Fetched";
  if (source === "builtin") return "Bundled";
  return source ? source.replaceAll("_", " ") : "Configured";
}

function ModelCard({ model, copied, onCopy }: {
  readonly model: ShareAccessModel;
  readonly copied: boolean;
  readonly onCopy: () => void;
}): ReactElement {
  return (
    <li className="share-model-card">
      <header>
        <span className="share-model-bot"><Bot size={14} aria-hidden="true" /></span>
        <code title={model.id}>{model.modelId}</code>
        <button type="button" onClick={onCopy} aria-label={`Copy ${model.id}`}>
          {copied ? <Check size={13} /> : <Clipboard size={13} />}
        </button>
      </header>
      <div className="share-model-tags">
        <span>{model.wireFamily}</span>
        <span>{sourceLabel(model.source)}</span>
      </div>
      <div className="share-model-meta">
        <span>{compactNumber(model.contextLimit)} ctx · {compactNumber(model.outputLimit)} out</span>
        <span className="share-model-capabilities" aria-label="Model capabilities">
          {model.reasoning ? <Brain size={12} aria-label="Reasoning" /> : null}
          {model.vision ? <Eye size={12} aria-label="Vision" /> : null}
          {model.toolCall ? <Wrench size={12} aria-label="Tools" /> : null}
          {model.webSearch ? <Search size={12} aria-label="Web search" /> : null}
        </span>
      </div>
      <span className="share-model-provider">{model.providerId}</span>
    </li>
  );
}

/** How many models fit before the list needs an explicit "Show more". */
const COLLAPSED_MODEL_COUNT = 8;

function ModelAccessPanel({ models }: { readonly models: readonly ShareAccessModel[] }): ReactElement {
  const [view, setView] = useState<"raw" | "grouped">("raw");
  const [copied, setCopied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // A share template can allow the operator's whole catalog. Eight rows is
  // enough to recognize the policy and keeps the enrollment page scannable;
  // the rest is one click away and "Copy all" still copies the full set.
  const visible = expanded ? models : models.slice(0, COLLAPSED_MODEL_COUNT);

  const groups = new Map<string, ShareAccessModel[]>();
  for (const model of visible) {
    const bucket = groups.get(model.providerId);
    if (bucket) bucket.push(model);
    else groups.set(model.providerId, [model]);
  }

  const copy = (value: string): void => {
    void copyToClipboard(value);
    setCopied(value);
    window.setTimeout(() => setCopied((current) => (current === value ? null : current)), 1500);
  };

  return (
    <section className="share-panel share-models">
      <header className="share-models-head">
        <div>
          <p className="share-eyebrow">MODEL ACCESS</p>
          <h3 className="share-models-title">Allowed models</h3>
        </div>
        <div className="share-models-actions">
          <div className="share-models-toggle" role="group" aria-label="Model list layout">
            <button
              type="button"
              className="share-models-toggle-btn"
              aria-pressed={view === "raw"}
              onClick={() => setView("raw")}
            >
              RAW
            </button>
            <button
              type="button"
              className="share-models-toggle-btn"
              aria-pressed={view === "grouped"}
              onClick={() => setView("grouped")}
            >
              GROUPED
            </button>
          </div>
          <button
            type="button"
            className="share-models-copyall"
            onClick={() => copy(models.map((model) => model.id).join(", "))}
          >
            {copied === models.map((model) => model.id).join(", ") ? <Check size={13} /> : <Clipboard size={13} />}
            Copy all
          </button>
        </div>
      </header>

      {view === "raw" ? (
        <ul className="share-models-grid">
          {visible.map((model) => <ModelCard key={model.id} model={model} copied={copied === model.id} onCopy={() => copy(model.id)} />)}
        </ul>
      ) : (
        <div className="share-models-groups">
          {[...groups.entries()].map(([provider, members]) => (
            <div key={provider} className="share-models-group">
              <p className="share-models-group-name">{provider}</p>
              <ul className="share-models-grid">
                {members.map((model) => <ModelCard key={model.id} model={model} copied={copied === model.id} onCopy={() => copy(model.id)} />)}
              </ul>
            </div>
          ))}
        </div>
      )}

      {models.length > COLLAPSED_MODEL_COUNT ? (
        <button
          type="button"
          className="share-models-copyall share-models-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : `Show ${models.length - COLLAPSED_MODEL_COUNT} more`}
        </button>
      ) : null}
    </section>
  );
}

type UsageMetric = "requests" | "tokens";

/** Per-browser theme memory for the public page. */
const SHARE_THEME_KEY = "lianrouter.share.theme";

function UsageChart({ activity, metric }: {
  readonly activity: ShareUsageActivity;
  readonly metric: UsageMetric;
}): ReactElement {
  const values = activity.series.map((point) => metric === "requests" ? point.requests : point.totalTokens);
  const ceiling = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = activity.series.length <= 1 ? 0 : (index / (activity.series.length - 1)) * 640;
    const y = 150 - (value / ceiling) * 124;
    return { x, y, value };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = points.length === 0
    ? ""
    : `M ${points.map((point) => `${point.x} ${point.y}`).join(" L ")} L 640 150 L 0 150 Z`;
  return (
    <div className="share-usage-chart" role="img" aria-label={`Seven day ${metric} chart`}>
      <svg viewBox="0 0 640 160" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`share-${metric}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--share-accent-hot)" stopOpacity=".38" />
            <stop offset="100%" stopColor="var(--share-accent-hot)" stopOpacity=".01" />
          </linearGradient>
        </defs>
        {[26, 67, 108, 150].map((y) => <line key={y} x1="0" x2="640" y1={y} y2={y} className="share-chart-gridline" />)}
        {area ? <path d={area} fill={`url(#share-${metric}-fill)`} /> : null}
        {line ? <polyline points={line} className="share-chart-line" /> : null}
        {points.map((point, index) => <circle key={activity.series[index]?.day} cx={point.x} cy={point.y} r="3.2" className="share-chart-point"><title>{`${activity.series[index]?.day}: ${point.value.toLocaleString()}`}</title></circle>)}
      </svg>
      <div className="share-chart-labels">
        {activity.series.map((point) => <span key={point.day}>{new Date(`${point.day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short" })}</span>)}
      </div>
    </div>
  );
}

function ShareActivityPanel({ activity }: { readonly activity: ShareUsageActivity }): ReactElement {
  const [metric, setMetric] = useState<UsageMetric>("requests");
  // Community statistics are supplemental: the enrollment/key controls must be
  // reachable without scrolling past a chart. Collapsed by default; the body
  // stays mounted so a re-open is instant and its text remains available to
  // assistive tech via `hidden` semantics.
  const [open, setOpen] = useState(false);
  const rankedModels = useMemo(
    () => [...activity.models].sort((left, right) =>
      metric === "requests"
        ? right.retainedRequests - left.retainedRequests
        : right.retainedTokens - left.retainedTokens,
    ).slice(0, 5),
    [activity.models, metric],
  );
  const maxModelValue = Math.max(1, ...rankedModels.map((model) =>
    metric === "requests" ? model.retainedRequests : model.retainedTokens));
  const topModel = rankedModels[0];
  return (
    <section className="share-panel share-activity-panel">
      <header className="share-activity-heading">
        <div>
          <p className="share-eyebrow"><Activity size={11} aria-hidden="true" /> LIVE STATISTICS</p>
          <h2>Community usage</h2>
          <p>Combined activity from every child key generated through this share. Updated automatically.</p>
        </div>
        <button
          type="button"
          className="share-models-copyall share-activity-toggle"
          aria-expanded={open}
          aria-controls="share-activity-body"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide statistics" : "Show statistics"}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </header>

      <div id="share-activity-body" hidden={!open}>
        <div className="share-activity-metrics">
          <div className="share-metric-toggle" role="group" aria-label="Chart metric">
            <button type="button" aria-pressed={metric === "requests"} onClick={() => setMetric("requests")}>Requests</button>
            <button type="button" aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>Tokens</button>
          </div>
        </div>

        <div className="share-stat-grid">
        <div><span>Total requests</span><strong>{activity.allTime.requests.toLocaleString()}</strong><small>{activity.allTime.errors.toLocaleString()} errors</small></div>
        <div><span>Tokens used</span><strong>{compactNumber(activity.allTime.totalTokens)}</strong><small>{compactNumber(activity.allTime.inputTokens)} in · {compactNumber(activity.allTime.outputTokens)} out</small></div>
        <div><span>Most used model</span><strong title={topModel?.modelId}>{topModel?.modelId ?? "No traffic"}</strong><small>{topModel ? `${topModel.retainedRequests.toLocaleString()} requests` : "Waiting for first request"}</small></div>
      </div>

      <div className="share-chart-shell">
        <div className="share-chart-caption">
          <div><span>LAST 7 DAYS</span><strong>{metric === "requests" ? "Request volume" : "Token volume"}</strong></div>
          <span>{activity.lastUsedAt ? `Last used ${new Date(activity.lastUsedAt).toLocaleString()}` : "No activity yet"}</span>
        </div>
        <UsageChart activity={activity} metric={metric} />
      </div>

      <div className="share-activity-columns">
        <section>
          <div className="share-section-title"><span>MODEL RANKING</span><h3>Frequently used</h3></div>
          {rankedModels.length ? <div className="share-model-ranking">{rankedModels.map((model, index) => {
            const value = metric === "requests" ? model.retainedRequests : model.retainedTokens;
            return <div key={`${model.providerId ?? ""}-${model.modelId}`} className="share-rank-row">
              <span className="share-rank-index">{String(index + 1).padStart(2, "0")}</span>
              <div><strong>{model.modelId}</strong><span><i style={{ width: `${Math.max(4, (value / maxModelValue) * 100)}%` }} /></span></div>
              <b>{compactNumber(value)}</b>
            </div>;
          })}</div> : <p className="share-empty-copy">No model activity yet.</p>}
        </section>
        <section>
          <div className="share-section-title"><span>RECENT ACTIVITY</span><h3>Latest requests</h3></div>
          {activity.requests.length ? <div className="share-public-events">{activity.requests.slice(0, 8).map((event) => (
            <article key={event.requestId}>
              <span className={`share-event-dot share-event-dot--${event.status}`} />
              <div>
                <strong>{event.modelId ?? "Unknown model"}</strong>
                <span><Clock3 size={10} /> {new Date(event.startedAt).toLocaleString()} · {event.clientIp ?? "IP unavailable"}</span>
              </div>
              <div><b>{compactNumber(event.totalTokens)}</b><span>tokens</span></div>
            </article>
          ))}</div> : <p className="share-empty-copy">No requests yet.</p>}
        </section>
      </div>
      </div>
    </section>
  );
}

function message(payload: ApiError): string {
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message ?? payload.message ?? "Unable to generate a child key.";
}

function fmt(value: number | null): string {
  return value === null ? "Unlimited" : value.toLocaleString();
}

export function SharePage(): ReactElement {
  const path = typeof window === "undefined" ? "/share" : window.location.pathname.replace(/\/$/, "");
  const dataPath = `${path}/data`;
  const issuePath = `${path}/issue`;
  const state = useShareData<ShareEnrollmentData>(dataPath);
  const [secret, setSecret] = useState<IssueResult | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueConflict, setIssueConflict] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [baseCopied, setBaseCopied] = useState(false);
  // The page used to be deliberately single-theme; the operator asked for a
  // visitor toggle, so the choice is remembered per browser. Default stays dark.
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    try {
      return window.localStorage.getItem(SHARE_THEME_KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const baseUrl = typeof window === "undefined" ? "/v1" : `${window.location.origin}/v1`;

  const data = state.data;

  useEffect(() => {
    document.title = "LianRouter — Shared access";
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SHARE_THEME_KEY, theme);
    } catch {
      // Storage can be denied in a private embed; the toggle still works for
      // this view, it just is not remembered.
    }
  }, [theme]);

  const issue = async () => {
    setIssueBusy(true);
    setIssueError(null);
    try {
      const response = await fetch(issuePath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: enrollmentDeviceId() }),
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
      });
      const payload = (await response.json()) as IssueResult | ApiError;
      if (response.status === 409) {
        setIssueConflict(true);
        return;
      }
      if (!response.ok) {
        setIssueError(message(payload as ApiError));
        return;
      }
      setSecret(payload as IssueResult);
      state.refresh();
    } catch {
      setIssueError("Unable to reach the LianRouter gateway. Please try again.");
    } finally {
      setIssueBusy(false);
    }
  };

  // A device that enrolled before the page knew about device ids (or that lost
  // its secret some other way) gets one automatic recovery attempt when the
  // page reports an existing child for this IP. Only an explicit match — same
  // link, same canonical IP, same stored device id — returns the key.
  useEffect(() => {
    // A child minted before the reveal feature stores no ciphertext, so the
    // lookup can never succeed — skip the request instead of spinning.
    if (!data?.alreadyIssued || data.canIssue || !data.recoverable) return;
    let cancelled = false;
    const reveal = async () => {
      setRevealBusy(true);
      try {
        const response = await fetch(`${path}/reveal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId: enrollmentDeviceId() }),
          credentials: "same-origin",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { key?: string };
        if (typeof payload.key !== "string" || cancelled) return;
        setSecret({ key: payload.key, keyId: "", keyPrefix: "", createdAt: "" });
      } catch {
        /* A failed recovery leaves the locked-out copy; the visitor can retry. */
      } finally {
        if (!cancelled) setRevealBusy(false);
      }
    };
    void reveal();
    return () => {
      cancelled = true;
    };
  }, [data?.alreadyIssued, data?.canIssue, data?.recoverable, path]);

  const copySecret = async () => {
    if (!secret) return;
    setCopied(await copyToClipboard(secret.key));
  };

  const copyBaseUrl = async (): Promise<void> => {
    setBaseCopied(await copyToClipboard(baseUrl));
    window.setTimeout(() => setBaseCopied(false), 1500);
  };

  useEffect(() => {
    if (!data) return;
    const timer = window.setInterval(state.refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [data, state.refresh]);

  return (
    <div className="share-page" data-theme={theme}>
      <div className="share-navwrap">
        <div className="share-nav-cluster">
          <header className="share-nav-pill">
            <a className="share-brand" href="/">
              <span className="share-brand-mark">
                <BrandMark />
              </span>
              <span className="share-brand-name">LianRouter</span>
            </a>
            <div className="share-nav-actions">
              <a href="/" className="share-home-link">
                <Home size={12} aria-hidden="true" />
                Home
              </a>
            </div>
          </header>
          <div className="share-theme-switch" role="group" aria-label="Color theme">
            <button
              type="button"
              aria-label="Light mode"
              aria-pressed={theme === "light"}
              onClick={() => setTheme("light")}
            >
              <Sun size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Dark mode"
              aria-pressed={theme === "dark"}
              onClick={() => setTheme("dark")}
            >
              <Moon size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <main className="share-main">
        {state.loading ? (
          <section className="share-panel" aria-busy="true">
            <div className="share-skeleton" />
            <div className="share-skeleton share-skeleton--short" />
          </section>
        ) : state.error ? (
          <section className="share-panel" role="alert">
            <p className="share-eyebrow">Enrollment unavailable</p>
            <h1>Link not available</h1>
            <p className="share-body">{state.error}</p>
            <button type="button" className="share-action-secondary" onClick={() => window.location.reload()}>
              Retry
            </button>
          </section>
        ) : data ? (
          <>
            <section className="share-panel share-panel--intro">
              <h1>{data.notes.title || data.name || "Shared API access"}</h1>
              {data.notes.subtitle ? <p className="share-subtitle">{data.notes.subtitle}</p> : null}
              {data.notes.body ? <p className="share-body share-notes">{data.notes.body}</p> : null}
              <p className="share-trust-copy">
                This page never displays a parent credential. Generate your own child key manually;
                it will be shown once in this page only.
              </p>
              {data.expiresAt ? (
                <p className="share-expiry">
                  Enrollment link expires {new Date(data.expiresAt).toLocaleString()}
                </p>
              ) : null}
            </section>

            <section className="share-panel">
              <div className="share-policy-heading">
                <div>
                  <p className="share-eyebrow">ACCESS POLICY</p>
                  <h2>What this key can do</h2>
                </div>
                <span className="share-key-prefix">{data.keyPrefix ?? "API"} · child key</span>
              </div>

              <div className="share-policy-grid">
                <div>
                  <span>Requests / minute</span>
                  <strong>{fmt(data.requestsPerMinute)}</strong>
                </div>
                <div>
                  <span>Concurrent requests</span>
                  <strong>{fmt(data.maxConcurrentRequests)}</strong>
                </div>
                <div>
                  <span>Daily token cap</span>
                  <strong>{fmt(data.dailyLimit)}</strong>
                </div>
                <div>
                  <span>Monthly token cap</span>
                  <strong>{fmt(data.monthlyLimit)}</strong>
                </div>
                <div>
                  <span>Lifetime cap</span>
                  <strong>{fmt(data.oneTimeLimit)}</strong>
                </div>
                <div>
                  <span>Providers</span>
                  <strong>
                    {data.providerAllowlist?.length ? data.providerAllowlist.join(", ") : "All allowed"}
                  </strong>
                </div>
              </div>

              {data.policyConflict ? (
                <p className="share-model-policy share-model-policy--conflict" role="alert">
                  No model is reachable with this template. It allows the providers{" "}
                  {data.providerAllowlist?.join(", ") ?? "(none)"} but only lists models from
                  other providers, so the two rules cancel out. The operator has to fix the
                  template before this key can be used.
                </p>
              ) : data.models.length === 0 ? (
                <p className="share-model-policy">
                  Model access follows the share template policy.
                </p>
              ) : null}
              {data.modelDenylist?.length ? (
                <p className="share-model-policy">Excluded: {data.modelDenylist.join(", ")}</p>
              ) : null}
              {data.modelPrefix ? (
                <p className="share-model-policy">Required model prefix: {data.modelPrefix}</p>
              ) : null}
            </section>

            <section className="share-panel share-key-panel">
              <div className="share-policy-heading">
                <div>
                  <p className="share-eyebrow">API CONFIGURATION</p>
                  <h2>Connect your client</h2>
                </div>
              </div>
              <div className="share-endpoint">
                <div>
                  <p className="share-eyebrow">BASE URL</p>
                  <span className="share-endpoint-caption">OpenAI-compatible inference endpoint</span>
                </div>
                <code>{baseUrl}</code>
                <button
                  type="button"
                  className="share-models-copyall"
                  onClick={() => void copyBaseUrl()}
                >
                  {baseCopied ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
                  {baseCopied ? "Copied" : "Copy"}
                </button>
              </div>

              {secret ? (
                <div className="share-issued-secret" role="status">
                  <p className="share-eyebrow">
                    {revealBusy ? "RECOVERING YOUR KEY…" : "GENERATED ONCE · SAVE IT NOW"}
                  </p>
                  <h2>Your child API key</h2>
                  <code>{secret.key}</code>
                  <div className="share-secret-actions">
                    <button type="button" className="share-action-primary" onClick={() => void copySecret()}>
                      {copied ? <Check size={14} aria-hidden="true" /> : <Clipboard size={14} aria-hidden="true" />}
                      {copied ? "Copied" : "Copy key"}
                    </button>
                    {secret.keyId ? <span>Key ID {secret.keyId.slice(0, 12)}…</span> : null}
                  </div>
                  <p className="share-note">
                    {revealBusy
                      ? "Matching this browser against the key issued from your network…"
                      : "This page shows your key again for this browser. Keep it out of shared devices."}
                  </p>
                </div>
              ) : (
                <div className="share-issue-controls">
                  {data.alreadyIssued || issueConflict ? (
                    <p role="status" className="share-warning">
                      {revealBusy
                        ? "Looking up the key issued to this device…"
                        : data.recoverable
                          ? "An active child key has already been issued from this IP. If you were the one who enrolled and lost the key, this browser can recover it automatically; otherwise ask the operator to reset the key."
                          : "An active child key has already been issued from this IP. This key was created before automatic recovery existed, so it cannot be shown again — ask the operator to reset the key."}
                    </p>
                  ) : issueError ? (
                    <p role="alert" className="share-warning">
                      {issueError}
                    </p>
                  ) : null}
                  {!data.canIssue && !data.alreadyIssued && !issueConflict ? (
                    <p role="status" className="share-warning">
                      This enrollment link is not currently accepting key requests.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="share-action-primary"
                    disabled={!data.canIssue || data.alreadyIssued || issueConflict || issueBusy}
                    onClick={() => void issue()}
                  >
                    {issueBusy
                      ? "Generating…"
                      : data.canIssue && !data.alreadyIssued && !issueConflict
                        ? "Generate my child key"
                        : "Enrollment unavailable"}
                  </button>
                  <p className="share-note">
                    One active child key per canonical IP. Your key is bound to this browser and can be
                    shown again here; it is never saved to browser storage.
                  </p>
                </div>
              )}
            </section>
            <ShareActivityPanel activity={data.activity} />

            {!data.policyConflict && data.models.length > 0 ? (
              <ModelAccessPanel models={data.models} />
            ) : null}
          </>
        ) : (
          <section className="share-panel">
            <h1>No enrollment data</h1>
          </section>
        )}

        <footer className="share-footer">
          <span className="share-footer-brand">
            <ShieldCheck size={12} aria-hidden="true" />
            LianRouter
          </span>
          <span>share-key enrollment</span>
        </footer>
      </main>
    </div>
  );
}

export default SharePage;
