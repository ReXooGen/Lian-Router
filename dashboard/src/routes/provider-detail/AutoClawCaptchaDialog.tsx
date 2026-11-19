import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { useAutoClawCaptchaConfig } from "../../lib/hooks/providers";

/**
 * Solves the Aliyun challenge the AutoClaw authorize step requires.
 *
 * Why this exists: `zai-oauth-url` refuses to mint an authorization URL until a
 * solved challenge is supplied, and it answers with an error code rather than
 * the challenge parameters. The dashboard therefore cannot just call the
 * authorize route and open whatever it returns — with the gate on, that call
 * always fails. This dialog reads the challenge first, runs it in the isolated
 * captcha document (the dashboard's own policy forbids the vendor script and
 * frames), and hands the solved token back so the login can start.
 *
 * The widget page is shared with the claim flow; the `channel` parameter keeps
 * the two apart so a message from one can never be read by the other.
 */

/** The message the isolated page posts back. */
interface CaptchaMessage {
  readonly type: "autoclaw-oauth-captcha";
  readonly param?: string;
  readonly error?: string;
}

const CHANNEL = "autoclaw-oauth-captcha";

function isCaptchaMessage(value: unknown): value is CaptchaMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["type"] !== CHANNEL) return false;
  return typeof record["param"] === "string" || typeof record["error"] === "string";
}

export function AutoClawCaptchaDialog({
  open,
  onSolved,
  onClose,
}: {
  readonly open: boolean;
  /** Called with the solved token; the caller starts the authorize request. */
  readonly onSolved: (captchaVerifyParam: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const configQuery = useAutoClawCaptchaConfig(open);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const popupRef = useRef<Window | null>(null);
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
      // Same-origin only: the challenge page is served by this dashboard.
      if (event.origin !== window.location.origin) return;
      if (!isCaptchaMessage(event.data)) return;
      const message = event.data;
      if (typeof message.param === "string" && message.param.length > 0) {
        setStatus("Challenge solved. Starting the login…");
        popupRef.current?.close();
        popupRef.current = null;
        solvedRef.current(message.param);
        return;
      }
      setFailed(true);
      setStatus(
        typeof message.error === "string" ? message.error : "The challenge was not solved.",
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open]);

  const openChallenge = useCallback(() => {
    const config = configQuery.data;
    if (config === undefined || !config.enabled) {
      // Gate disabled: nothing to solve, so start the login with an empty token
      // rather than making the operator click a button that cannot do anything.
      solvedRef.current("");
      return;
    }
    setFailed(false);
    setStatus("Waiting for the challenge window…");
    const query = new URLSearchParams({
      sceneId: config.sceneId,
      region: config.region,
      prefix: config.prefix,
      channel: CHANNEL,
      title: "Connect AutoClaw",
    });
    const popup = window.open(
      `/claim-captcha.html?${query.toString()}`,
      CHANNEL,
      "popup=yes,width=460,height=620,resizable=yes,scrollbars=yes",
    );
    if (popup === null) {
      setFailed(true);
      setStatus("The challenge window was blocked. Allow pop-ups for this site and try again.");
      return;
    }
    popupRef.current = popup;
    popup.focus();
  }, [configQuery.data]);

  const config = configQuery.data;
  const loading = configQuery.isPending;
  const configFailed = configQuery.isError;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Verify to connect AutoClaw"
      description="Z.ai requires a captcha before it will authorize an account."
      width={440}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "4px 0" }}>
        <p style={{ margin: 0, fontSize: "12.5px", color: "var(--text-secondary)" }}>
          The challenge opens in its own window. Solve it there and the login continues
          automatically — the token is passed straight to the authorize step and never stored.
        </p>
        {loading ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              color: "var(--text-secondary)",
            }}
          >
            <Loader2 size={13} className="animate-spin" /> Reading the challenge…
          </span>
        ) : null}
        {configFailed ? (
          <p style={{ margin: 0, fontSize: "12px", color: "var(--error)" }}>
            The challenge configuration could not be read. Retry, or add the account with a
            token from the desktop app instead.
          </p>
        ) : null}
        {config !== undefined && !config.enabled ? (
          <p style={{ margin: 0, fontSize: "12px", color: "var(--text-secondary)" }}>
            This deployment does not gate the login with a captcha. Continue to start it.
          </p>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          onClick={openChallenge}
          disabled={loading || configFailed}
        >
          {status === null ? "Open the challenge" : "Reopen the challenge"}
        </Button>
        {status !== null ? (
          <p
            style={{
              margin: 0,
              fontSize: "12px",
              color: failed ? "var(--error)" : "var(--text-secondary)",
            }}
          >
            {status}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
