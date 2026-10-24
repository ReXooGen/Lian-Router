import { useEffect, useRef, useState, type ReactElement } from "react";

import type { UpdateProgress, UpdateStatus } from "../lib/contracts";
import { formatBytes } from "../lib/format";
import { useStartUpdate, useUpdateStatus } from "../lib/hooks/update";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

/** Version string the operator dismissed, so a newer release opens the modal again. */
const DISMISSED_VERSION_KEY = "lianrouter.update.dismissed";

/** The launcher kills and restarts the gateway; `/health` is the first route
 * back, so it is the only reliable liveness probe during that window. */
const RECOVERY_POLL_MS = 2_000;
const RECOVERY_TIMEOUT_MS = 90_000;

/** Phase names the launcher's update engine emits (`cli/update/engine.ts`). */
const PHASE_LABELS: Readonly<Record<string, string>> = {
  checking: "Checking for updates",
  downloading: "Downloading",
  verifying: "Verifying download",
  extracting: "Extracting archive",
  installing: "Installing",
  restarting: "Restarting gateway",
  done: "Update complete",
};

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase.replaceAll("_", " ");
}

function formatPublished(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * `12.4 / 58.1 MB` while both counters share a unit; `512 B / 58.1 MB` when
 * they do not, because the shared unit would be a lie at a different scale.
 */
function transferLabel(received: number, total: number): string {
  const receivedLabel = formatBytes(received);
  const totalLabel = formatBytes(total);
  const unitOf = (label: string): string => label.slice(label.indexOf(" ") + 1);
  if (unitOf(receivedLabel) !== unitOf(totalLabel)) return `${receivedLabel} / ${totalLabel}`;
  return `${receivedLabel.slice(0, receivedLabel.indexOf(" "))} / ${totalLabel}`;
}

function ProgressView({ progress }: { readonly progress: UpdateProgress }): ReactElement {
  const percent = Math.min(100, Math.max(0, progress.percent));
  const hasBytes =
    typeof progress.bytesReceived === "number" && typeof progress.bytesTotal === "number";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
          {phaseLabel(progress.phase)}
        </span>
        <span
          style={{
            fontSize: "12px",
            fontFamily: "var(--font-mono)",
            color: "var(--text-secondary)",
          }}
        >
          {percent}%
        </span>
      </div>
      <div
        className="overview-bar"
        role="progressbar"
        aria-label="Update progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className="overview-bar-fill overview-bar-fill--accent"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
        {progress.message}
      </p>
      {hasBytes ? (
        <p
          style={{
            fontSize: "11px",
            fontFamily: "var(--font-mono)",
            color: "var(--text-tertiary)",
          }}
        >
          {transferLabel(progress.bytesReceived as number, progress.bytesTotal as number)}
        </p>
      ) : null}
    </div>
  );
}

function VersionRows({ status }: { readonly status: UpdateStatus }): ReactElement {
  const published = status.publishedAt === null ? null : formatPublished(status.publishedAt);
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: "6px 16px",
        margin: 0,
        fontSize: "12px",
      }}
    >
      <dt style={{ color: "var(--text-tertiary)" }}>Current version</dt>
      <dd style={{ margin: 0, fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>
        {status.current}
      </dd>
      <dt style={{ color: "var(--text-tertiary)" }}>New version</dt>
      <dd style={{ margin: 0, fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>
        {status.latest ?? status.current}
      </dd>
      {published === null ? null : (
        <>
          <dt style={{ color: "var(--text-tertiary)" }}>Published</dt>
          <dd style={{ margin: 0, color: "var(--text-secondary)" }}>{published}</dd>
        </>
      )}
    </dl>
  );
}

/**
 * Offers the release the launcher reported and drives the install.
 *
 * The modal owns no update state of its own: `GET /console/api/update` is the
 * only source of truth for availability and progress, and `POST /update/start`
 * is the only action. Once the install stops running the launcher is restarting
 * the gateway, so the modal switches to a `/health` wait and reloads the page
 * when the gateway answers — every console request fails until then.
 */
export function UpdateModal(): ReactElement | null {
  const statusQuery = useUpdateStatus();
  const startUpdate = useStartUpdate();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(DISMISSED_VERSION_KEY),
  );
  const [closed, setClosed] = useState(false);
  const [recovery, setRecovery] = useState<"none" | "waiting" | "timeout">("none");
  const sawRunning = useRef(false);

  const status = statusQuery.data;
  const running = status?.running === true;
  const progress = status?.progress ?? null;
  const failed = progress?.phase === "error";

  useEffect(() => {
    if (running) sawRunning.current = true;
  }, [running]);

  // A newer release re-opens a modal the operator closed for the previous one.
  useEffect(() => {
    setClosed(false);
  }, [status?.latest]);

  useEffect(() => {
    if (failed) return;
    if (!sawRunning.current && !startUpdate.isSuccess) return;
    // `running` going false after we watched it true means the launcher finished
    // and is bouncing the gateway; a failing poll after an install means the
    // gateway is already gone. A failing poll alone is just a transient error.
    const gatewayGone = statusQuery.isError && (startUpdate.isSuccess || sawRunning.current);
    const installFinished = sawRunning.current && status !== undefined && !running;
    if (gatewayGone || installFinished) {
      setRecovery((current) => (current === "none" ? "waiting" : current));
    }
  }, [failed, running, startUpdate.isSuccess, status, statusQuery.isError]);

  useEffect(() => {
    if (recovery !== "waiting") return;
    let cancelled = false;
    const deadline = Date.now() + RECOVERY_TIMEOUT_MS;

    const poll = async (): Promise<void> => {
      while (!cancelled) {
        if (Date.now() >= deadline) {
          setRecovery("timeout");
          return;
        }
        try {
          const response = await fetch("/health", { cache: "no-store" });
          if (response.ok) {
            window.location.reload();
            return;
          }
        } catch {
          // Still down; the next poll decides.
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, RECOVERY_POLL_MS);
        });
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [recovery]);

  const target = status?.latest ?? status?.current ?? null;

  const dismiss = (): void => {
    if (status?.latest != null) {
      setDismissedVersion(status.latest);
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(DISMISSED_VERSION_KEY, status.latest);
      }
    }
    setClosed(true);
  };

  if (recovery !== "none") {
    const waiting = recovery === "waiting";
    // Dismissing the wait hides the dialog but keeps the `/health` poll and the
    // reload alive; the timeout state is actionable, so it always shows.
    if (waiting && closed) return null;
    return (
      <Dialog
        open
        onClose={dismiss}
        title={waiting ? "Gateway restarting" : "Gateway did not return"}
        width={440}
        footer={
          waiting ? undefined : (
            <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
          )
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <p style={{ fontSize: "13px", color: "var(--text-primary)" }}>
            {waiting
              ? "Gateway restarting…"
              : "The gateway did not come back; check the launcher window."}
          </p>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            {waiting
              ? "The install finished. The console reloads itself as soon as the gateway answers."
              : `LianRouter ${target ?? "the new release"} was installed. Start the gateway from the launcher, then reload.`}
          </p>
        </div>
      </Dialog>
    );
  }

  if (!status || !status.available || closed) return null;
  if (status.latest !== null && dismissedVersion === status.latest) return null;

  const label = target ?? status.current;

  if (failed && progress !== null) {
    return (
      <Dialog
        open
        onClose={dismiss}
        title="Update failed"
        width={440}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={dismiss}>
              Close
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={startUpdate.isPending}
              onClick={() => startUpdate.mutate()}
            >
              Retry
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Installing LianRouter {label} did not finish.
          </p>
          <p role="alert" style={{ fontSize: "12px", color: "var(--red)", lineHeight: 1.5 }}>
            {progress.error ?? "The launcher reported an error without a message."}
          </p>
        </div>
      </Dialog>
    );
  }

  if (running) {
    return (
      <Dialog open onClose={dismiss} title="Installing update" width={440}>
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Installing LianRouter {label}. The gateway restarts when the install finishes.
          </p>
          {progress === null ? null : <ProgressView progress={progress} />}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={dismiss}
      title="Update available"
      width={440}
      footer={
        status.launcher ? (
          <>
            <Button variant="secondary" size="sm" onClick={dismiss}>
              Later
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={startUpdate.isPending}
              onClick={() => startUpdate.mutate()}
            >
              Install update
            </Button>
          </>
        ) : undefined
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
          LianRouter {label} is available for this install.
        </p>
        <VersionRows status={status} />
        {status.notesUrl === null ? null : (
          <a
            href={status.notesUrl}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: "12px", color: "var(--status-info)" }}
          >
            Release notes
          </a>
        )}
        {status.launcher ? (
          <p style={{ fontSize: "12px", color: "var(--text-tertiary)", lineHeight: 1.5 }}>
            The launcher installs the release and restarts the gateway.
          </p>
        ) : (
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            This gateway was not started by the lianrouter launcher. Run{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>lianrouter update</code> in the
            terminal.
          </p>
        )}
      </div>
    </Dialog>
  );
}
