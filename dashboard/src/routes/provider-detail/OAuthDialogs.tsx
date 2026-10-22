import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import {
  useCompleteOAuthBrowserLogin,
  usePollOAuthDevice,
  useProviderAccounts,
  useStartOAuthDevice,
} from "../../lib/hooks/providers";
import { queryKeys } from "../../lib/query-keys";
import { toast } from "../../lib/toast";
import { useTrackedTimeout } from "../../lib/use-timeout";

function extractOAuthCode(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    if (code) return code;
  } catch {
    // Not a full URL — fall through to query-string / raw-code parsing.
  }
  try {
    const params = new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
    const code = params.get("code");
    if (code) return code;
  } catch {
    // Ignored — falls back to the raw trimmed value below.
  }
  return trimmed;
}

export function OAuthBrowserDialog({
  providerId,
  authorizeUrl,
  state,
  popup,
  onClose,
}: {
  readonly providerId: string;
  readonly authorizeUrl: string;
  readonly state: string;
  readonly popup: Window;
  readonly onClose: (completed: boolean) => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const [callbackValue, setCallbackValue] = useState("");
  const complete = useCompleteOAuthBrowserLogin();
  const scheduleCopyReset = useTrackedTimeout();
  const queryClient = useQueryClient();
  // The popup navigates through the hosted `/oauth/callback` route, so the
  // server completes the exchange and persists the account without the
  // dashboard ever relaying the code back. Poll the account list to detect
  // that completion and auto-close; the single-use manual-paste state
  // otherwise reads as "unknown or expired" after the popup already consumed
  // it. The manual field below stays available for redirects that landed on
  // an address the browser could not deliver back to the server.
  const accountsQuery = useProviderAccounts(providerId);
  const baselineAccountIdsRef = useRef<ReadonlySet<string> | null>(null);
  const completionDetectedRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.providers.accounts(providerId),
      });
    }, 1500);
    return () => clearInterval(interval);
  }, [queryClient, providerId]);

  useEffect(() => {
    const ids = accountsQuery.data?.map((account) => account.id) ?? null;
    if (ids === null) return;
    if (baselineAccountIdsRef.current === null) {
      baselineAccountIdsRef.current = new Set(ids);
      return;
    }
    if (completionDetectedRef.current) return;
    const added = ids.find((id) => !baselineAccountIdsRef.current!.has(id));
    if (added === undefined) return;
    completionDetectedRef.current = true;
    popup.close();
    toast.success("Account connected", "OAuth login completed successfully");
    onClose(true);
  }, [accountsQuery.data, popup, onClose]);

  const cancel = () => {
    popup.close();
    onClose(false);
  };

  const handlePasteCallback = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        toast.error("Clipboard is empty");
        return;
      }
      setCallbackValue(text);
      toast.success("Pasted redirect URL");
    } catch {
      toast.error("Clipboard unavailable on this origin");
    }
  };

  const handleConnect = () => {
    const code = extractOAuthCode(callbackValue);
    if (!code) return;
    complete.mutate(
      { providerId, code, state },
      {
        onSuccess: () => {
          popup.close();
          toast.success("Account connected", "OAuth login completed successfully");
          onClose(true);
        },
        onError: (err) =>
          toast.error(
            "OAuth callback failed",
            (err as { message?: string }).message ?? "Invalid or expired authorization code",
          ),
      },
    );
  };

  return (
    <Dialog
      open={true}
      onClose={cancel}
      title="Connect via OAuth"
      width={420}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={cancel} disabled={complete.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={complete.isPending || callbackValue.trim().length === 0}
            onClick={handleConnect}
          >
            {complete.isPending ? "Connecting…" : "Connect"}
          </Button>
        </>
      }
    >
      <Stack gap="14px">
        <div className="oauth-status">
          <Loader2
            size={16}
            className="animate-spin"
            style={{ color: "var(--accent)", flexShrink: 0 }}
          />
          <span className="oauth-status-text">Waiting for popup authorization…</span>
        </div>

        <div className="oauth-step">
          <div className="oauth-step-title">Step 1: Open this URL in your browser</div>
          <Inline gap="8px">
            <a
              className="oauth-url"
              href={authorizeUrl}
              target="_blank"
              rel="noreferrer"
              title={authorizeUrl}
            >
              {authorizeUrl}
            </a>
            <Button
              variant="secondary"
              size="sm"
              icon={copied ? <Check size={12} /> : <Copy size={12} />}
              onClick={() => {
                void navigator.clipboard?.writeText(authorizeUrl);
                setCopied(true);
                scheduleCopyReset(() => setCopied(false), 1500);
              }}
              style={{ flexShrink: 0 }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </Inline>
          <p className="oauth-hint">
            A popup should open automatically. If it was blocked, open the URL above manually.
          </p>
        </div>

        <div className="oauth-divider">Or complete manually</div>

        <div className="oauth-step">
          <div className="oauth-step-title">Step 2: Paste the redirect URL here</div>
          <p className="oauth-hint">
            If the redirect lands on an unreachable address, copy that page&apos;s full URL from
            your browser and paste it below — this works from any machine, not just localhost.
          </p>
          <Inline gap="8px" align="flex-start">
            <textarea
              className="oauth-textarea"
              value={callbackValue}
              onChange={(event) => setCallbackValue(event.target.value)}
              placeholder="http://127.0.0.1:59653/callback?code=…&state=…  (or just the code)"
              rows={2}
              spellCheck={false}
              style={{ flex: 1 }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handlePasteCallback()}
              style={{ flexShrink: 0 }}
            >
              Paste
            </Button>
          </Inline>
        </div>
      </Stack>
    </Dialog>
  );
}

function verificationHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export function DeviceCodeDialog({
  providerId,
  onClose,
}: {
  readonly providerId: string;
  readonly onClose: () => void;
}): ReactNode {
  const startDevice = useStartOAuthDevice();
  const pollDevice = usePollOAuthDevice();
  const [session, setSession] = useState<{
    verificationUri: string;
    userCode: string;
    deviceAuthId: string;
    intervalSeconds: number;
    expiresInSeconds: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const scheduleCopyReset = useTrackedTimeout();
  useEffect(() => {
    startDevice.mutate(
      { providerId },
      {
        onSuccess: (result) => setSession(result),
        onError: (err) => {
          toast.error(
            "Failed to start device login",
            (err as { message?: string }).message ?? "Unable to start device authorization",
          );
          onClose();
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!session) return;
    const startedAt = Date.now();
    const expiresInMs = Math.max(1, session.expiresInSeconds) * 1000;
    let pollInFlight = false;
    let timer = 0;
    const poll = () => {
      if (Date.now() - startedAt > expiresInMs) {
        window.clearInterval(timer);
        toast.error("Device login expired", "Please try again.");
        onClose();
        return;
      }
      if (pollInFlight) return;
      pollInFlight = true;
      pollDevice.mutate(
        { providerId, deviceAuthId: session.deviceAuthId },
        {
          onSuccess: (result) => {
            pollInFlight = false;
            if (result.status === "complete") {
              window.clearInterval(timer);
              toast.success("OAuth account connected", "Device authorization complete");
              onClose();
            } else if (result.status === "failed") {
              window.clearInterval(timer);
              toast.error("Device login failed", result.reason);
              onClose();
            }
          },
          onError: () => {
            pollInFlight = false;
          },
        },
      );
    };
    poll();
    timer = window.setInterval(poll, Math.max(1, session.intervalSeconds) * 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (!session?.verificationUri) return;
    window.open(session.verificationUri, "_blank", "noopener");
  }, [session?.verificationUri]);

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="Login with OAuth (device code)"
      width={420}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <Stack gap="14px">
        {!session ? (
          <div className="oauth-status">
            <Loader2
              size={16}
              className="animate-spin"
              style={{ color: "var(--accent)", flexShrink: 0 }}
            />
            <span className="oauth-status-text">Starting device authorization…</span>
          </div>
        ) : (
          <>
            <div className="oauth-status">
              <Loader2
                size={16}
                className="animate-spin"
                style={{ color: "var(--accent)", flexShrink: 0 }}
              />
              <span className="oauth-status-text">Waiting for authorization…</span>
            </div>

            {session.userCode ? (
              <div className="oauth-step">
                <div className="oauth-step-title">Step 1: Enter this code</div>
                <div className="oauth-code-card">
                  <div className="oauth-code-label">Device code</div>
                  <div className="oauth-code-value">{session.userCode}</div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={copiedCode ? <Check size={12} /> : <Copy size={12} />}
                    onClick={() => {
                      void navigator.clipboard?.writeText(session.userCode);
                      setCopiedCode(true);
                      scheduleCopyReset(() => setCopiedCode(false), 1500);
                    }}
                  >
                    {copiedCode ? "Copied" : "Copy code"}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="oauth-step">
              <div className="oauth-step-title">
                {session.userCode
                  ? "Step 2: Open the verification page"
                  : "Open the verification page to authorize"}
              </div>
              <Inline gap="8px">
                <a
                  className="oauth-url"
                  href={session.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  title={session.verificationUri}
                >
                  {verificationHost(session.verificationUri)}
                </a>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<ExternalLink size={12} />}
                  onClick={() => window.open(session.verificationUri, "_blank", "noopener")}
                  style={{ flexShrink: 0 }}
                >
                  Open
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={copied ? <Check size={12} /> : <Copy size={12} />}
                  onClick={() => {
                    void navigator.clipboard?.writeText(session.verificationUri);
                    setCopied(true);
                    scheduleCopyReset(() => setCopied(false), 1500);
                  }}
                  style={{ flexShrink: 0 }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </Inline>
              <p className="oauth-hint">
                The page opened in a new tab. Finish signing in there — this dialog closes
                automatically once the account connects.
              </p>
            </div>
          </>
        )}
      </Stack>
    </Dialog>
  );
}

/**
 * Antigravity-only loopback OAuth dialog.
 *
 * Google's Desktop OAuth client type (which Antigravity uses) only accepts
 * `http://127.0.0.1:*` redirect URIs — the hosted dashboard cannot serve
 * that redirect itself. The operator runs a shell snippet on their own
 * machine; the snippet starts a tiny local HTTP server, opens Google's
 * authorize URL in their browser, catches the callback, and POSTs the
 * resulting code back to the server's `/oauth/loopback/complete` endpoint.
 *
 * This dialog shows the snippet to copy, polls the account list to detect
 * the completion the local script triggers, and closes itself when it sees
 * the new account appear.
 */
export function OAuthLoopbackDialog({
  providerId,
  shellSnippet,
  helperScriptUrl,
  ttlSeconds,
  onClose,
}: {
  readonly providerId: string;
  readonly shellSnippet: string;
  readonly helperScriptUrl: string;
  readonly ttlSeconds: number;
  readonly onClose: (completed: boolean) => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const scheduleCopyReset = useTrackedTimeout();
  const queryClient = useQueryClient();
  const accountsQuery = useProviderAccounts(providerId);
  const baselineAccountIdsRef = useRef<ReadonlySet<string> | null>(null);
  const completionDetectedRef = useRef(false);
  // The snippet is valid only while the Redis flow entry survives; show a
  // visible countdown so an operator who paused mid-paste notices before
  // Google's authorize URL rejects the state as expired.
  const [secondsLeft, setSecondsLeft] = useState(ttlSeconds);

  useEffect(() => {
    const interval = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.providers.accounts(providerId),
      });
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1_500);
    return () => clearInterval(interval);
  }, [queryClient, providerId]);

  useEffect(() => {
    const ids = accountsQuery.data?.map((account) => account.id) ?? null;
    if (ids === null) return;
    if (baselineAccountIdsRef.current === null) {
      baselineAccountIdsRef.current = new Set(ids);
      return;
    }
    if (completionDetectedRef.current) return;
    const added = ids.find((id) => !baselineAccountIdsRef.current!.has(id));
    if (added !== undefined) {
      completionDetectedRef.current = true;
      toast.success("Account connected", `New ${providerId} account registered successfully`);
      onClose(true);
    }
  }, [accountsQuery.data, providerId, onClose]);

  return (
    <Dialog open={true} onClose={() => onClose(false)} title="Antigravity loopback login" width={720}>
      <Stack gap="12px">
        <p className="oauth-hint">
          Google's Antigravity OAuth client only accepts redirects to{" "}
          <code>http://127.0.0.1:*</code>. Copy the command below and paste it
          into a terminal on your own machine — it opens Google's sign-in page,
          catches the callback, and finalises the login back to this console.
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "8px",
            padding: "12px",
            background: "var(--surface-raised)",
            borderRadius: "8px",
            border: "1px solid var(--inner-border)",
          }}
        >
          <pre
            style={{
              flex: 1,
              margin: 0,
              maxHeight: "240px",
              overflow: "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              whiteSpace: "pre",
              overflowWrap: "normal",
              wordBreak: "normal",
            }}
          >
            {shellSnippet}
          </pre>
          <Button
            size="sm"
            icon={copied ? <Check size={12} /> : <Copy size={12} />}
            onClick={() => {
              void navigator.clipboard?.writeText(shellSnippet);
              setCopied(true);
              scheduleCopyReset(() => setCopied(false), 1500);
            }}
            style={{ flexShrink: 0 }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="oauth-hint" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
          Requires <code>python3</code> and <code>curl</code>. Script source:{" "}
          <a href={helperScriptUrl} target="_blank" rel="noopener noreferrer">
            {helperScriptUrl}
          </a>
        </p>
        <p className="oauth-hint">
          Expires in <strong>{secondsLeft}s</strong>. This dialog closes
          automatically once the local script finishes and the account appears.
        </p>
      </Stack>
    </Dialog>
  );
}
