import { Bell, Check, CheckCircle2, CircleHelp, Gift, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { ProviderNotification, ProviderNotificationKind } from "../../../src/console/notifications/contracts";
import { useNotificationReadState, useProviderNotifications } from "../lib/hooks/notifications";
import { useModalFocus } from "../lib/hooks/use-modal-focus";
import { uniqueNotifications, unreadNotificationCount } from "../lib/notification-state";
import { providerDisplayName } from "../lib/provider-names";

const kindLabels: Record<ProviderNotificationKind, string> = {
  checkin_due: "Check-in available",
  checkin_completed: "Check-in confirmed",
  plan_claimable: "Plan available",
  status_unknown: "Status unverified",
};

const kindRank: Record<ProviderNotificationKind, number> = {
  checkin_due: 0,
  plan_claimable: 1,
  checkin_completed: 2,
  status_unknown: 3,
};

function notificationIcon(kind: ProviderNotificationKind, size = 14): ReactNode {
  if (kind === "checkin_completed") return <CheckCircle2 size={size} />;
  if (kind === "status_unknown") return <CircleHelp size={size} />;
  if (kind === "plan_claimable") return <Gift size={size} />;
  return <Bell size={size} />;
}

function checkedLabel(checkedAt: string | undefined): string | null {
  if (!checkedAt) return null;
  const date = new Date(checkedAt);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface NotificationGroup {
  readonly key: string;
  readonly kind: ProviderNotificationKind;
  readonly providerId: string;
  readonly items: readonly ProviderNotification[];
}

/**
 * Seven AutoClaw accounts reporting the same unverified state used to render as
 * seven near-identical cards that pushed everything else out of view. Rows are
 * grouped by provider and kind: one row per state, accounts listed inside it.
 * Claimable plans keep their own row because each plan carries its own name.
 */
function groupNotifications(items: readonly ProviderNotification[]): NotificationGroup[] {
  const groups = new Map<string, ProviderNotification[]>();
  for (const item of items) {
    const key = item.kind === "plan_claimable"
      ? `${item.providerId}:${item.kind}:${item.planId ?? item.id}`
      : `${item.providerId}:${item.kind}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return Array.from(groups, ([key, groupItems]) => {
    const first = groupItems[0] as ProviderNotification;
    return { key, kind: first.kind, providerId: first.providerId, items: groupItems };
  }).sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.providerId.localeCompare(b.providerId));
}

export function NotificationsPopover({ userId }: { readonly userId: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const query = useProviderNotifications(userId);
  const { readIds, markRead, storageUnavailable } = useNotificationReadState(userId);
  const items = useMemo(() => uniqueNotifications(query.data?.items ?? []), [query.data?.items]);
  const readSet = useMemo(() => new Set(readIds), [readIds]);
  const unreadCount = unreadNotificationCount(items, readIds);
  const groups = useMemo(() => groupNotifications(items), [items]);
  const lastChecked = checkedLabel(query.data?.checkedAt);
  useModalFocus({ open, mounted: open, panelRef: contentRef, onClose: () => setOpen(false) });

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!contentRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        className="topbar-icon-button"
        style={{ position: "relative" }}
        aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={17} />
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            style={{
              position: "absolute", top: "-3px", right: "-4px", minWidth: "16px", height: "16px",
              padding: "0 4px", borderRadius: "999px", background: "var(--accent)",
              color: "var(--surface-1)", fontSize: "9px", fontWeight: 700, lineHeight: "16px",
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>
      {open ? createPortal(
        <div
          ref={contentRef}
          role="dialog"
          aria-modal="true"
          aria-label="Notifications"
          className="popout-enter glass"
          style={{
            position: "fixed", zIndex: 60, top: "64px", right: "16px",
            width: "min(360px, calc(100vw - 32px))", maxHeight: "calc(100dvh - 80px)",
            display: "flex", flexDirection: "column", borderRadius: "16px",
            boxShadow: "var(--shadow-popout)", border: "1px solid var(--inner-border)",
            background: "var(--popover-bg)", overflow: "hidden",
          }}
        >
          <header
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px",
              padding: "12px 14px", borderBottom: "1px solid var(--inner-border)",
            }}
          >
            <h2 style={{ display: "flex", alignItems: "center", gap: "7px", fontWeight: 650, fontSize: "13px" }}>
              Notifications
              {unreadCount > 0 ? (
                <span
                  style={{
                    fontSize: "10px", fontWeight: 600, padding: "1px 6px", borderRadius: "999px",
                    background: "var(--accent-soft)", color: "var(--accent)",
                  }}
                >
                  {unreadCount} new
                </span>
              ) : null}
            </h2>
            <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
              <button
                type="button"
                className="topbar-icon-button"
                aria-label="Refresh notifications"
                title="Refresh notifications"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                <RefreshCw size={14} />
              </button>
              <button
                type="button"
                className="topbar-icon-button"
                aria-label="Close notifications"
                onClick={() => setOpen(false)}
              >
                <X size={14} />
              </button>
            </div>
          </header>

          <div
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px",
              padding: "8px 14px", borderBottom: "1px solid var(--inner-border)",
              fontSize: "11px", color: "var(--text-tertiary)",
            }}
          >
            <span>{lastChecked ? `Checked ${lastChecked}` : "Not checked yet"}</span>
            <button
              type="button"
              className="topbar-button"
              style={{ fontSize: "11px" }}
              disabled={unreadCount === 0}
              onClick={() => markRead(items.map((item) => item.id))}
            >
              <Check size={12} /> Mark all read
            </button>
          </div>

          <div style={{ overflowY: "auto", padding: "10px 14px 14px" }}>
            {query.isError ? (
              <p role="alert" style={{ fontSize: "11.5px", margin: "4px 0 10px", color: "var(--text-secondary)" }}>
                Could not refresh. {query.data ? "Showing the last snapshot. " : ""}
                {query.error.message || "Try again."}
              </p>
            ) : null}
            <div role="status" aria-live="polite" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              {query.isPending && !query.isError ? <p style={{ margin: "2px 0 10px" }}>Loading…</p> : null}
              {query.data?.pending ? <p style={{ margin: "2px 0 10px" }}>Checking providers…</p> : null}
            </div>

            {items.length === 0 && query.data ? (
              <p style={{ padding: "18px 0", fontSize: "12px", color: "var(--text-secondary)" }}>
                {query.data.pending ? "No results yet — provider checks are running." : "Nothing needs attention."}
              </p>
            ) : null}

            {groups.map((group) => {
              const unreadItems = group.items.filter((item) => !readSet.has(item.id));
              const first = group.items[0] as ProviderNotification;
              const provider = providerDisplayName(group.providerId);
              const accountLabel = group.items.length === 1
                ? first.accountLabel
                : `${group.items.length} accounts`;
              return (
                <section key={group.key} style={{ padding: "10px 0", borderBottom: "1px solid var(--inner-border)" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <span
                      aria-hidden="true"
                      style={{
                        marginTop: "1px", flexShrink: 0,
                        color: group.kind === "status_unknown" ? "var(--text-tertiary)" : "var(--accent)",
                      }}
                    >
                      {notificationIcon(group.kind)}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: "6px", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "12px", fontWeight: 600 }}>{provider}</span>
                        <span style={{ fontSize: "10px", color: "var(--text-tertiary)" }}>
                          {kindLabels[group.kind]} · {accountLabel}
                        </span>
                        {unreadItems.length > 0 ? (
                          <span style={{ fontSize: "10px", fontWeight: 600, color: "var(--accent)" }}>
                            {unreadItems.length} unread
                          </span>
                        ) : null}
                      </div>
                      <p style={{ fontSize: "11.5px", color: "var(--text-secondary)", marginTop: "3px", lineHeight: 1.45 }}>
                        {first.message}
                      </p>
                      {group.items.length > 1 ? (
                        <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0", display: "grid", gap: "2px" }}>
                          {group.items.map((item) => (
                            <li key={item.id} style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                              <Link
                                to={item.href}
                                onClick={() => { markRead([item.id]); setOpen(false); }}
                                style={{
                                  flex: 1, minWidth: 0, fontSize: "11px", color: "var(--text-secondary)",
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                }}
                              >
                                {item.accountLabel}
                              </Link>
                              {readSet.has(item.id) ? null : (
                                <button
                                  type="button"
                                  className="topbar-button"
                                  style={{ fontSize: "10px", padding: "0 4px" }}
                                  aria-label={`Mark ${item.accountLabel} as read`}
                                  onClick={() => markRead([item.id])}
                                >
                                  Read
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "5px" }}>
                          <Link
                            to={first.href}
                            onClick={() => { markRead([first.id]); setOpen(false); }}
                            style={{ fontSize: "11px", fontWeight: 600, color: "var(--accent)" }}
                          >
                            Open account
                          </Link>
                          {readSet.has(first.id) ? null : (
                            <button
                              type="button"
                              className="topbar-button"
                              style={{ fontSize: "10px" }}
                              onClick={() => markRead([first.id])}
                            >
                              <Check size={11} /> Mark read
                            </button>
                          )}
                        </div>
                      )}
                      {group.items.length > 1 ? (
                        <button
                          type="button"
                          className="topbar-button"
                          style={{ fontSize: "10px", marginTop: "6px" }}
                          onClick={() => markRead(group.items.map((item) => item.id))}
                        >
                          <Check size={11} /> Mark these read
                        </button>
                      ) : null}
                    </div>
                  </div>
                </section>
              );
            })}

            {storageUnavailable ? (
              <p role="status" style={{ marginTop: "8px", fontSize: "10.5px", color: "var(--text-tertiary)" }}>
                Read state is session-only: browser storage is unavailable.
              </p>
            ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
