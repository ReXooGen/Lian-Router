import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ChevronDown, ChevronRight, Copy, Eye, KeyRound, Link2, Pencil, Pause, Play, RefreshCw, ShieldBan, Trash2, Users,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { useApiKeys, useRevokeSharedKey, useShareApiKey, useSharedKeyActivity, useSharedKeys } from "../lib/hooks/api-keys";
import { readConsoleCsrfCookie } from "../lib/api";
import { copyToClipboard, getErrorMessage } from "../lib/helpers";
import type { SharedKeySummary } from "../lib/contracts";

const count = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const stamp = (s: string | null | undefined) => s ? new Date(s).toLocaleString() : "—";

/** One sidecar admin action. These sit outside `/console/api`, carrying the CSRF header directly. */
async function adminPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  const token = readConsoleCsrfCookie();
  if (token) headers["X-CSRF-Token"] = token;
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === "object" && "error" in payload
        ? (payload as { error?: { message?: unknown } }).error
        : undefined;
    const text =
      message !== null && typeof message === "object" && message !== undefined && "message" in message
        ? (message as { message?: unknown }).message
        : undefined;
    throw new Error(typeof text === "string" ? text : `HTTP ${response.status}`);
  }
  return payload;
}

interface TemplatePause {
  readonly parentKeyId: string;
  readonly pausedAt: string | null;
  readonly childKeyIds?: readonly string[];
}

function readPauses(payload: unknown): TemplatePause[] {
  if (payload === null || typeof payload !== "object" || !("pauses" in payload)) return [];
  const pauses = payload.pauses;
  if (!Array.isArray(pauses)) return [];
  return pauses.flatMap((row) => {
    if (row === null || typeof row !== "object" || !("parentKeyId" in row)) return [];
    const id = row.parentKeyId;
    if (typeof id !== "string") return [];
    const pausedAt = "pausedAt" in row && typeof row.pausedAt === "string" ? row.pausedAt : null;
    const rawChildren =
      "childKeyIds" in row && Array.isArray(row.childKeyIds) ? row.childKeyIds : [];
    const children = rawChildren.filter((c: unknown): c is string => typeof c === "string");
    return [{ parentKeyId: id, pausedAt, childKeyIds: children }];
  });
}

/** Loads the active template pauses for the signed-in tenant. */
function useTemplatePauses() {
  const [pauses, setPauses] = useState<TemplatePause[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/share-admin/pauses", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`Pause state request failed with HTTP ${response.status}`);
      setPauses(readPauses(payload));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load pause state.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { pauses, error, loading, load };
}

export function ChildDetail({ parentId, childId }: { parentId: string; childId: string }): ReactNode {
  const detail = useSharedKeyActivity(parentId, childId);
  if (detail.isPending) return <LoadingState label="Loading safe activity…" />;
  if (detail.isError) return <ErrorState message={getErrorMessage(detail.error, "Could not load child activity.")} onRetry={() => void detail.refetch()} />;
  const activity = detail.data;
  // Three distinct states, never collapsed: capture off is a different claim
  // from capture on but expired. `promptCaptureEnabled` is tenant-level and
  // cannot answer "does this row carry a prompt" — only the rows can. Keying
  // the subtitle off the tenant flag alone promised prompts that were never
  // captured or had already aged out of the retention window.
  const subtitle = activity?.requests.some((event) => event.prompt !== undefined)
    ? "Safe metadata plus the latest captured user prompt"
    : activity?.promptCaptureEnabled
      ? "Safe request metadata only — no prompt captured for these requests (retention window may have passed)"
      : "Safe request metadata only — payload capture is off, so prompts are not recorded";

  return <div className="share-child-detail">
    <section aria-labelledby="share-model-heading">
      <div className="share-detail-heading">
        <div><h3 id="share-model-heading">Top models</h3><p>Today and retained telemetry totals</p></div>
      </div>
      {activity?.models.length ? <div className="share-model-grid">{activity.models.map((model, i) => (
        <article className="share-model-card" key={`${model.providerId ?? ""}-${model.modelId}-${i}`}>
          <h4>{model.modelId}</h4>
          <div className="share-model-periods">
            <div className="share-model-period">
              <h5>Today</h5>
              <dl><div><dt>Hits</dt><dd>{count(model.todayRequests)}</dd></div><div><dt>Errors</dt><dd>{count(model.todayErrors)}</dd></div><div><dt>Tokens</dt><dd>{count(model.todayTokens)}</dd></div></dl>
            </div>
            <div className="share-model-period">
              <h5>Retained telemetry</h5>
              <dl><div><dt>Hits</dt><dd>{count(model.retainedRequests)}</dd></div><div><dt>Errors</dt><dd>{count(model.retainedErrors)}</dd></div><div><dt>Tokens</dt><dd>{count(model.retainedTokens)}</dd></div></dl>
            </div>
          </div>
        </article>
      ))}</div> : <p className="share-detail-empty">No model activity yet.</p>}
    </section>
    <section aria-labelledby="share-requests-heading">
      <div className="share-detail-heading">
        <div><h3 id="share-requests-heading">Recent requests</h3><p>{subtitle}</p></div>
      </div>
      {activity?.requests.length ? <div className="share-event-list">{activity.requests.map((event) => (
        <article className="share-event-card" key={event.requestId}>
          <header>
            <div className="share-event-model">{event.providerId ?? "Provider"} <span aria-hidden="true">/</span> {event.modelId ?? "Model"}</div>
            <span className="share-event-status">{event.status}{event.httpStatus ? ` · HTTP ${event.httpStatus}` : ""}</span>
          </header>
          <dl className="share-event-fields">
            <div><dt>Client IP</dt><dd>{event.clientIp ?? "—"}</dd></div>
            <div className="share-event-error"><dt>Error</dt><dd>{event.errorCategory ?? event.errorOrigin ?? "None"}</dd></div>
            <div><dt>Time</dt><dd>{stamp(event.startedAt)}</dd></div>
            <div><dt>Input tokens</dt><dd>{count(event.inputTokens)}</dd></div>
            <div><dt>Output tokens</dt><dd>{count(event.outputTokens)}</dd></div>
            <div><dt>Total tokens</dt><dd>{count(event.totalTokens)}</dd></div>
          </dl>
          {event.prompt !== undefined && <div className="share-event-prompt">
            <span className="share-event-prompt-label">Prompt</span>
            <p className="share-event-prompt-text">{event.prompt}{event.promptTruncated ? " …" : ""}</p>
          </div>}
        </article>
      ))}</div> : <p className="share-detail-empty">No recent requests.</p>}
    </section>
  </div>;
}

export default function ShareRoute(): ReactNode {
  const keys = useApiKeys();
  const parents = (keys.data ?? []).filter((key) => key.keyMode === "share");
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const share = useShareApiKey();
  const revoke = useRevokeSharedKey();
  const { pauses, error: pauseError, load: loadPauses } = useTemplatePauses();
  const [pauseDialog, setPauseDialog] = useState<{ parentKeyId: string; paused: boolean; label: string } | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SharedKeySummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [blockTarget, setBlockTarget] = useState<SharedKeySummary | null>(null);
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<SharedKeySummary | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<SharedKeySummary | null>(null);
  const activeParentId = selected ?? parents[0]?.id ?? null;
  const summary = useSharedKeys(activeParentId);
  const children = summary.data ?? [];
  const selectedPause = activeParentId ? pauses.find((p) => p.parentKeyId === activeParentId) ?? null : null;
  const selectedPausedChildIds = Array.isArray(selectedPause?.childKeyIds) ? selectedPause.childKeyIds : [];
  const createLink = (keyId: string) => share.mutate({ keyId }, { onSuccess: (result) => setLink(result.url) });

  const confirmPauseToggle = async () => {
    if (!pauseDialog) return;
    setPauseBusy(true);
    try {
      await adminPost(pauseDialog.paused ? "/share-admin/unpause" : "/share-admin/pause", {
        parentKeyId: pauseDialog.parentKeyId,
      });
      await loadPauses();
      await keys.refetch();
      if (activeParentId) await summary.refetch();
    } finally {
      setPauseBusy(false);
      setPauseDialog(null);
    }
  };

  const confirmRename = async () => {
    if (!renameTarget) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      await adminPost("/share-admin/rename-key", {
        childKeyId: renameTarget.id,
        label: renameValue.trim() || renameTarget.label,
      });
      await summary.refetch();
      setRenameTarget(null);
      setRenameBusy(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Rename failed.");
      setRenameBusy(false);
    }
  };

  const confirmBlock = async () => {
    if (!blockTarget) return;
    setActionBusy((s) => ({ ...s, [blockTarget.id]: true }));
    try {
      await adminPost("/share-admin/block", {
        ip: blockTarget.issuedClientIp,
        childKeyId: blockTarget.id,
        reason: "Blocked from Share page",
      });
      await summary.refetch();
      await keys.refetch();
    } finally {
      setActionBusy((s) => {
        const next = { ...s };
        delete next[blockTarget.id];
        return next;
      });
      setBlockTarget(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setActionBusy((s) => ({ ...s, [`d:${deleteTarget.id}`]: true }));
    try {
      await adminPost("/share-admin/delete-key", { childKeyId: deleteTarget.id });
      await summary.refetch();
    } finally {
      setActionBusy((s) => {
        const next = { ...s };
        delete next[`d:${deleteTarget.id}`];
        return next;
      });
      setDeleteTarget(null);
    }
  };

  return <div style={{ display: "grid", gap: 14 }}>
    <Card><CardHeader title="Shared access" subtitle="Enrollment links, recipient management, and privacy-safe usage" icon={<Users size={16} />} action={<Button variant="secondary" size="sm" onClick={() => void keys.refetch()} icon={<RefreshCw size={13} />}>Refresh</Button>} />
      <CardBody>
        {keys.isPending && !keys.data ? <LoadingState label="Loading share templates…" /> : keys.isError ? <ErrorState message={getErrorMessage(keys.error, "Could not load API keys.")} onRetry={() => void keys.refetch()} /> : parents.length === 0 ? <EmptyState title="No share templates" message="Create an API key in Share template mode to enroll recipients without revealing a parent credential." icon={<KeyRound size={20} />} /> : <div style={{ display: "grid", gap: 8 }}>
          {parents.map((parent) => {
            const paused = pauses.find((p) => p.parentKeyId === parent.id) !== undefined;
            return <div key={parent.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, padding: 12, border: "1px solid var(--inner-border)", borderRadius: 10, background: "var(--surface-2)" }}>
              <div>
                <strong>{parent.label || "Unnamed share template"}</strong>{" "}
                {paused ? <span title="Shared access is paused: new enrollments stop and issued keys are rejected" style={{ fontSize: 11, color: "var(--warning)", fontWeight: 600 }}>⏸ paused</span> : null}
                <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Parent ID {parent.id.slice(0, 10)}… · no bearer secret</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button variant="secondary" size="sm" onClick={() => { setSelected(parent.id); setExpanded(null); }}>View recipients</Button>
                <Button
                  variant={paused ? "primary" : "secondary"}
                  size="sm"
                  disabled={pauseBusy}
                  onClick={() => setPauseDialog({ parentKeyId: parent.id, paused, label: parent.label })}
                  icon={paused ? <Play size={13} /> : <Pause size={13} />}
                >
                  {paused ? "Resume access" : "Pause access"}
                </Button>
                <Button variant="primary" size="sm" disabled={share.isPending || Boolean(parent.revokedAt) || paused} onClick={() => createLink(parent.id)} icon={<Link2 size={13} />}>Create enrollment link</Button>
              </div>
            </div>;
          })}
        </div>}
        {pauseError ? <p role="alert" style={{ marginTop: 8, color: "var(--red)", fontSize: 12 }}>{pauseError}</p> : null}
        {share.isError && <p role="alert" style={{ marginTop: 10, color: "var(--red)" }}>{getErrorMessage(share.error, "Could not create enrollment link.")}</p>}
        {link && <div role="status" style={{ marginTop: 12, padding: 12, borderRadius: 10, border: "1px solid var(--accent-soft)", background: "var(--accent-soft)" }}><strong style={{ fontSize: 12 }}>Enrollment URL — copy now</strong><code style={{ display: "block", margin: "8px 0", overflowWrap: "anywhere", fontSize: 11 }}>{link}</code><Button variant="secondary" size="sm" icon={<Copy size={13} />} onClick={() => void copyToClipboard(link)}>Copy link</Button><Button variant="secondary" size="sm" onClick={() => window.open(link, "_blank", "noopener")}>Open</Button><Button variant="ghost" size="sm" onClick={() => setLink(null)}>Dismiss</Button></div>}
      </CardBody>
    </Card>
    {activeParentId && <Card><CardHeader title="Recipients" subtitle="Name first; the key prefix sits below. Live telemetry refreshes every five seconds." icon={<Users size={16} />} /><CardBody>
      {summary.isPending && !summary.data ? <LoadingState label="Loading recipients…" /> : summary.isError ? <ErrorState message={getErrorMessage(summary.error, "Could not load share activity.")} onRetry={() => void summary.refetch()} /> : children.length === 0 ? <EmptyState title="No recipients yet" message="Issued child keys will appear here with masked client IP and aggregate usage." /> : <div style={{ display: "grid", gap: 8 }}>{children.map((child: SharedKeySummary) => {
        const childPaused = selectedPausedChildIds.includes(child.id);
        return <section key={child.id} style={{ border: "1px solid var(--inner-border)", borderRadius: 10, overflow: "hidden" }}>
        <div className="share-recipient-main">
          <div className="share-recipient-identity">
            <div>
              <button type="button" className="share-recipient-key" aria-expanded={expanded === child.id} onClick={() => setExpanded(expanded === child.id ? null : child.id)}>
                {expanded === child.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{child.label || `${child.keyPrefix ?? "key"}…`}</span>
              </button>
              <div className="share-recipient-context">
                <Eye size={11} aria-hidden="true" style={{ display: "inline", verticalAlign: "-1px", marginRight: 4 }} />
                {child.keyPrefix ?? "key"}… <span aria-hidden="true">·</span> {child.issuedClientIp ?? "IP hidden"} <span aria-hidden="true">·</span> {childPaused ? "paused" : child.revokedAt ? "revoked" : "active"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => { setRenameTarget(child); setRenameValue(child.label ?? ""); setRenameError(null); }}>
                Edit
              </Button>
              <Button variant="danger" size="sm" disabled={revoke.isPending || Boolean(child.revokedAt)} onClick={() => setRevokeTarget(child)}>Revoke</Button>
              <Button variant="secondary" size="sm" icon={<ShieldBan size={13} />} disabled={!child.issuedClientIp || Boolean(actionBusy[child.id])} onClick={() => setBlockTarget(child)}>
                {actionBusy[child.id] ? "Blocking…" : "Block IP"}
              </Button>
              <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} disabled={!child.revokedAt || Boolean(actionBusy[`d:${child.id}`])} onClick={() => setDeleteTarget(child)}>
                {actionBusy[`d:${child.id}`] ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </div>
          <dl className="share-recipient-metrics">
            <div><dt>Today requests</dt><dd>{count(child.today.requests)}</dd></div>
            <div><dt>Today errors</dt><dd>{count(child.today.errors)}</dd></div>
            <div><dt>Today tokens</dt><dd>{count(child.today.totalTokens)}</dd></div>
            <div title="Earlier events already removed by telemetry retention cannot be reconstructed."><dt>Lifetime requests</dt><dd>{count(child.allTime.requests)}</dd></div>
            <div title="Earlier events already removed by telemetry retention cannot be reconstructed."><dt>Lifetime errors</dt><dd>{count(child.allTime.errors)}</dd></div>
            <div title="Earlier events already removed by telemetry retention cannot be reconstructed."><dt>Lifetime tokens</dt><dd>{count(child.allTime.totalTokens)}</dd></div>
          </dl>
          <p className="share-recipient-dates">Registered {stamp(child.createdAt)} <span aria-hidden="true">·</span> Last activity {stamp(child.lastUsedAt)}</p>
        </div>
        {expanded === child.id && <ChildDetail parentId={activeParentId} childId={child.id} />}
      </section>;
    })}</div>}
    </CardBody></Card>}

    <ConfirmDialog
      open={revokeTarget !== null}
      onClose={() => setRevokeTarget(null)}
      onConfirm={async () => {
        if (!revokeTarget || !activeParentId) return;
        await new Promise<void>((resolve, reject) => {
          revoke.mutate(
            { parentKeyId: activeParentId, childKeyId: revokeTarget.id },
            { onSuccess: () => resolve(), onError: (e) => reject(new Error(getErrorMessage(e, "Revoke failed."))) },
          );
        });
        setRevokeTarget(null);
      }}
      title="Revoke recipient?"
      message={
        revokeTarget
          ? `Revoke "${revokeTarget.label || `${revokeTarget.keyPrefix ?? "key"}…`}"? The recipient key stops working immediately and its enrollment link is disabled. Usage history stays visible.`
          : "Revoke this recipient?"
      }
      confirmLabel="Revoke"
      danger
    />
    <ConfirmDialog
      open={blockTarget !== null}
      onClose={() => setBlockTarget(null)}
      onConfirm={confirmBlock}
      title={blockTarget ? "Block this IP?" : "Block"}
      message={
        blockTarget
          ? `Block ${blockTarget.issuedClientIp} from shared access? Every live key issued to that address is revoked, and the address cannot enroll again until you unblock it in Blocked Users.`
          : ""
      }
      confirmLabel="Block IP"
      danger
    />
    <ConfirmDialog
      open={deleteTarget !== null}
      onClose={() => setDeleteTarget(null)}
      onConfirm={confirmDelete}
      title="Delete this key?"
      message={
        deleteTarget
          ? `Permanently delete "${deleteTarget.label || `${deleteTarget.keyPrefix ?? "key"}…`}"? The row disappears from this list and cannot be restored. Usage history stays in telemetry.`
          : "Delete this key?"
      }
      confirmLabel="Delete"
      danger
    />
    <ConfirmDialog
      open={pauseDialog !== null}
      onClose={() => setPauseDialog(null)}
      onConfirm={confirmPauseToggle}
      title={pauseDialog?.paused ? "Resume access?" : "Pause access?"}
      message={
        pauseDialog
          ? pauseDialog.paused
            ? `Resume shared access for "${pauseDialog.label || "this share template"}"? Enrollment can resume and issued recipient keys will work again.`
            : `Pause shared access for "${pauseDialog.label || "this share template"}"? New enrollments stop and every issued recipient key is rejected until you resume. Resuming restores the exact keys paused — nothing is revoked permanently.`
          : "Pause shared access?"
      }
      confirmLabel={pauseDialog?.paused ? "Resume access" : "Pause access"}
      danger={!pauseDialog?.paused}
    />
    <Dialog
      open={renameTarget !== null}
      onClose={() => { setRenameTarget(null); setRenameBusy(false); setRenameError(null); }}
      title="Edit recipient"
      description="Rename this recipient key. Enrollment links, usage history and revocation state stay unchanged."
      width={480}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="secondary" size="sm" onClick={() => { setRenameTarget(null); setRenameError(null); }} disabled={renameBusy}>
            Cancel
          </Button>
          <Button size="sm" disabled={renameBusy || !renameValue.trim()} onClick={() => void confirmRename()}>
            {renameBusy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        <Input
          id="share-recipient-name"
          label="Recipient name"
          hint="shown in the recipients list"
          value={renameValue}
          maxLength={40}
          onChange={(event) => setRenameValue(event.target.value)}
          placeholder="BANSOS #2"
        />
        {renameError ? <p role="alert" style={{ margin: 0, fontSize: 11.5, color: "var(--red)" }}>{renameError}</p> : null}
      </div>
    </Dialog>
  </div>;
}
