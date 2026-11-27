import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../../components/ui/dialog";
import type { ProviderClaimVerificationConfig } from "../../lib/hooks/providers";

/**
 * Opens the claim challenge in the isolated captcha page and waits for its token.
 *
 * The widget cannot run inline. The dashboard document is served with a policy
 * that allows only its own bundle, and the vendor widget needs a remote script,
 * remote frames and region-specific challenge hosts. Widening the dashboard
 * policy would weaken every screen to buy one dialog, and fighting that policy
 * from inside the document is what produced a widget that reported its own
 * "Network Err" panel while every request was refused. The challenge therefore
 * runs in `claim-captcha.html`, which carries the wider policy, holds no
 * credential of its own, and returns exactly one value: the solved token.
 *
 * The token arrives by `postMessage` from that page, so the listener checks both
 * the message shape and the sending origin before accepting it.
 */

/** The message the isolated page posts back. */
interface CaptchaMessage {
  readonly type: "zcode-claim-captcha";
  readonly param?: string;
  readonly region?: string;
  readonly error?: string;
}

function isCaptchaMessage(value: unknown): value is CaptchaMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["type"] !== "zcode-claim-captcha") return false;
  // At least one payload field must be a string; an empty object would otherwise
  // pass and hand the caller a token of `undefined`.
  return ["param", "region", "error"].some((key) => typeof record[key] === "string");
}

export function ClaimCaptchaDialog({
  open,
  planName,
  config,
  submitting,
  error,
  onSolved,
  onClose,
}: {
  readonly open: boolean;
  readonly planName: string;
  readonly config: ProviderClaimVerificationConfig | null;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onSolved: (verification: { param: string; region: string }) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const popupRef = useRef<Window | null>(null);
  // The solved callback is stored in a ref so the message listener does not have
  // to be torn down and re-registered on every parent render: a re-subscription
  // mid-challenge could drop the message the page sends immediately after.
  const solvedRef = useRef(onSolved);
  solvedRef.current = onSolved;

  useEffect(() => {
    if (!open) {
      setStatus(null);
      setFailed(false);
      popupRef.current?.close();
      popupRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMessage = (event: MessageEvent) => {
      // Same-origin only: the page is served by this dashboard, so any other
      // origin is either a mistake or an attempt to inject a token.
      if (event.origin !== window.location.origin) return;
      if (!isCaptchaMessage(event.data)) return;
      const message = event.data;
      if (typeof message.param === "string" && message.param.length > 0) {
        setStatus("Challenge solved. Sending it with the claim…");
        solvedRef.current({ param: message.param, region: message.region ?? "" });
        return;
      }
      setFailed(true);
      setStatus(typeof message.error === "string" ? message.error : "The challenge was not solved.");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open]);

  const openChallenge = useCallback(() => {
    if (config === null || !config.enabled) return;
    setFailed(false);
    setStatus("Waiting for the challenge window…");
    const query = new URLSearchParams({
      sceneId: config.sceneId,
      region: config.region,
      prefix: config.prefix,
    });
    const features = "popup=yes,width=460,height=620,resizable=yes,scrollbars=yes";
    // `/claim-captcha.html` is the real document. A `/console/...` path is not a
    // route, so the SPA fallback served the console shell inside the popup.
    const popup = window.open(`/claim-captcha.html?${query.toString()}`, "zcode-claim-captcha", features);
    if (popup === null) {
      // A blocked popup is the one failure the operator can fix themselves, so
      // it gets its own message rather than a generic "challenge failed".
      setFailed(true);
      setStatus("The challenge window was blocked. Allow pop-ups for this site and try again.");
      return;
    }
    popupRef.current = popup;
    popup.focus();
  }, [config]);

  const blocked = config === null || !config.enabled;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Solve the claim challenge"
      description={`The vendor requires its captcha before granting ${planName}.`}
      width={440}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "4px 0" }}>
        {blocked ? (
          <p style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
            {config === null
              ? "Reading the challenge configuration…"
              : "This account's claim gate is disabled — retry the claim directly."}
          </p>
        ) : (
          <p style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
            The challenge opens in its own window. Solve it there and the claim continues automatically.
          </p>
        )}
        {!blocked ? (
          <button
            type="button"
            onClick={openChallenge}
            disabled={submitting}
            style={{
              alignSelf: "flex-start",
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid var(--inner-border)",
              background: "var(--surface-2)",
              color: "var(--text-primary)",
              fontSize: "12.5px",
              fontWeight: 600,
              cursor: submitting ? "default" : "pointer",
            }}
          >
            {status === null ? "Open the challenge" : "Reopen the challenge"}
          </button>
        ) : null}
        {submitting ? (
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary)" }}
          >
            <Loader2 size={13} className="animate-spin" /> Sending the solved challenge…
          </span>
        ) : null}
        {status !== null ? (
          <p style={{ fontSize: "12px", color: failed ? "var(--error)" : "var(--text-secondary)" }}>{status}</p>
        ) : null}
        {error !== null ? (
          <p style={{ fontSize: "12px", color: "var(--error)" }}>
            {error} — a solved token expires, so close this dialog and claim again.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
