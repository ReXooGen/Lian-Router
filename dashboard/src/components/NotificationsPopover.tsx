import { Bell, Check, CheckCircle2, CircleHelp, Gift, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { ProviderNotificationKind } from "../../../src/console/notifications/contracts";
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

function notificationIcon(kind: ProviderNotificationKind): ReactNode {
  if (kind === "checkin_completed") return <CheckCircle2 size={16} />;
  if (kind === "status_unknown") return <CircleHelp size={16} />;
  if (kind === "plan_claimable") return <Gift size={16} />;
  return <Bell size={16} />;
}

function checkedLabel(checkedAt: string | undefined): string | null {
  if (!checkedAt) return null;
  const date = new Date(checkedAt);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
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
            width: "min(380px, calc(100vw - 32px))", maxHeight: "calc(100dvh - 80px)",
            overflowY: "auto", borderRadius: "20px", padding: "16px",
            boxShadow: "var(--shadow-popout)", border: "1px solid var(--inner-border)",
            background: "var(--popover-bg)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <h2 style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 700, fontSize: "14px" }}>
              <Bell size={16} style={{ color: "var(--accent)" }} /> Notifications
            </h2>
            <div style={{ display: "flex", gap: "4px" }}>
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
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", margin: "8px 0 12px", fontSize: "11px" }}>
            <span style={{ color: "var(--text-secondary)" }}>{unreadCount} unread</span>
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
          {query.isError ? (
            <p role="alert" style={{ fontSize: "12px", marginBottom: "12px", color: "var(--text-secondary)" }}>
              Could not refresh notifications. {query.data ? "Showing the last saved snapshot. " : ""}
              {query.error.message || "Try refreshing again."}
            </p>
          ) : null}
          <div role="status" aria-live="polite" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
            {query.isPending && !query.isError ? <p style={{ marginBottom: "12px" }}>Loading provider notifications…</p> : null}
            {query.data?.pending ? <p style={{ marginBottom: "12px" }}>Checking provider status… Results are not yet fully verified.</p> : null}
            {query.isFetching && query.data && !query.data.pending ? <p style={{ marginBottom: "12px" }}>Refreshing notifications…</p> : null}
          </div>
          {items.length === 0 && query.data ? (
            <p style={{ padding: "16px 0", fontSize: "12px", color: "var(--text-secondary)" }}>
              {query.data.pending ? "No notifications yet. Provider checks are still in progress." : "No provider notifications at the last check."}
            </p>
          ) : null}
          <ul style={{ display: "flex", flexDirection: "column", gap: "10px", listStyle: "none", padding: 0, margin: 0 }}>
            {items.map((item) => {
              const unread = !readSet.has(item.id);
              return (
                <li
                  key={item.id}
                  style={{ border: "1px solid var(--inner-border)", borderRadius: "14px", padding: "12px", background: unread ? "var(--accent-soft)" : "var(--surface-2)" }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                    <span aria-hidden="true" style={{ color: item.kind === "status_unknown" ? "var(--text-secondary)" : "var(--accent)", marginTop: "2px", flexShrink: 0 }}>
                      {notificationIcon(item.kind)}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Link
                        to={item.href}
                        onClick={() => { markRead([item.id]); setOpen(false); }}
                        style={{ display: "block", color: "inherit", textDecoration: "none", overflowWrap: "anywhere" }}
                      >
                        <span style={{ display: "block", fontSize: "10px", color: "var(--text-secondary)", marginBottom: "3px" }}>
                          {kindLabels[item.kind]}{unread ? " · Unread" : ""}
                        </span>
                        <span style={{ display: "block", fontWeight: 600, fontSize: "12.5px" }}>{item.title}</span>
                        <span style={{ display: "block", fontSize: "11px", color: "var(--text-secondary)", marginTop: "3px" }}>{item.message}</span>
                        <span style={{ display: "block", fontSize: "10px", color: "var(--text-tertiary)", marginTop: "6px" }}>
                          {providerDisplayName(item.providerId)} · {item.accountLabel}
                        </span>
                      </Link>
                      {unread ? (
                        <button
                          type="button"
                          className="topbar-button"
                          style={{ marginTop: "8px", fontSize: "10px" }}
                          aria-label={`Mark ${item.title} for ${item.accountLabel} as read`}
                          onClick={() => markRead([item.id])}
                        >
                          <Check size={11} /> Mark read
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {lastChecked ? <p style={{ marginTop: "12px", fontSize: "10px", color: "var(--text-tertiary)" }}>Last checked: {lastChecked}</p> : null}
          {storageUnavailable ? (
            <p role="status" style={{ marginTop: "8px", fontSize: "11px", color: "var(--text-secondary)" }}>Read state is kept for this session only because browser storage is unavailable.</p>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
