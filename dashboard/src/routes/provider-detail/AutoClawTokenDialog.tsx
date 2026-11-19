import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { useImportAutoClawToken } from "../../lib/hooks/providers";

/**
 * Adds an AutoClaw account by pasting a token the desktop app already holds.
 *
 * Why this exists next to the OAuth button: AutoClaw's authorize step is gated
 * by an Aliyun captcha whose token is bound to the browser's own IP. A
 * deployment on a server cannot mint one for an operator sitting elsewhere, so
 * the browser flow can only be completed from a machine that also reaches the
 * callback port. The desktop app has already done that work and holds a valid
 * token, which makes a pasted token the path that always works.
 *
 * The server verifies the value against the gateway before storing it, so a
 * stale or foreign token is rejected here instead of becoming an account that
 * fails on its first real request.
 */
export function AutoClawTokenDialog({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: (completed: boolean) => void;
}): ReactNode {
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const importToken = useImportAutoClawToken();

  const submit = () => {
    setError(null);
    importToken.mutate(
      { token: token.trim(), ...(label.trim() ? { accountLabel: label.trim() } : {}) },
      {
        onSuccess: () => {
          setToken("");
          setLabel("");
          onClose(true);
        },
        onError: (err) => {
          setError(
            err && typeof err === "object" && "message" in err && typeof err.message === "string"
              ? err.message
              : "The token was rejected",
          );
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      title="Add AutoClaw account with a token"
      onClose={() => onClose(false)}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={importToken.isPending || token.trim().length === 0}
            onClick={submit}
          >
            {importToken.isPending ? "Verifying..." : "Add account"}
          </Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: "10px" }}>
        <p style={{ margin: 0, fontSize: "12.5px", color: "var(--text-secondary)" }}>
          Sign in with the AutoClaw desktop app on any machine, then paste the
          account token here. It is checked against the gateway before it is
          stored, so an expired or unrelated token is refused rather than saved.
        </p>
        <label style={{ display: "grid", gap: "4px", fontSize: "12.5px" }}>
          Token
          <textarea
            value={token}
            onChange={(event) => setToken(event.target.value)}
            rows={4}
            spellCheck={false}
            placeholder="Paste the account token"
            style={{
              width: "100%",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "12px",
              padding: "8px",
              border: "1px solid var(--inner-border)",
              borderRadius: "6px",
              background: "var(--surface-2)",
              color: "var(--text-primary)",
              resize: "vertical",
            }}
          />
        </label>
        <label style={{ display: "grid", gap: "4px", fontSize: "12.5px" }}>
          Label (optional)
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="AutoClaw"
            style={{
              padding: "8px",
              border: "1px solid var(--inner-border)",
              borderRadius: "6px",
              background: "var(--surface-2)",
              color: "var(--text-primary)",
            }}
          />
        </label>
        {error !== null && (
          <p style={{ margin: 0, fontSize: "12.5px", color: "var(--error)" }}>{error}</p>
        )}
      </div>
    </Dialog>
  );
}
