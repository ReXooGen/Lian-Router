import { ArrowRight, Info, Lock, ShieldCheck, User } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BrandMark } from "../components/BrandMark";
import { OrbitObject } from "../components/three/OrbitObject";
import { Button } from "../components/ui/button";
import { consoleRequest } from "../lib/api";
import { queryClient } from "../lib/query-client";
import { queryKeys } from "../lib/query-keys";

interface LoginResult {
  readonly status: "success" | "failed";
  readonly message?: string;
  readonly requires_setup?: boolean;
  /** Seconds until a lockout expires; drives the live countdown. */
  readonly retry_after_seconds?: number;
}

/**
 * `m:ss` for a wait, or a plain seconds count under a minute.
 *
 * A lockout is a fixed window measured in minutes, so a raw second count reads
 * as noise ("842 seconds"); one unit above a minute is what an operator
 * actually plans around.
 */
function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function safeReturnPath(value: string | null): string {
  if (value?.startsWith("/") && !value.startsWith("//")) return value;
  return "/";
}

export default function Login(): ReactNode {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);
  // Single-password mode (`LIANROUTER_CONSOLE_PASSWORD`): the server owns the
  // only credential, so the form asks for a password and nothing else.
  const [passwordOnly, setPasswordOnly] = useState(false);
  // True only while the instance still uses the password it shipped with, so
  // the hint disappears the moment the operator changes it.
  const [showDefaultHint, setShowDefaultHint] = useState(false);
  // Remaining lockout, counted down locally from the server's `retry-after`.
  // The server stays authoritative: the countdown only decides when to retry,
  // and a still-locked request simply returns a fresh value.
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (lockedUntil === null) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        setLockedUntil(null);
        setError(null);
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  const applyLockout = (seconds: number | undefined): boolean => {
    if (seconds === undefined || seconds <= 0) return false;
    setLockedUntil(Date.now() + seconds * 1000);
    setSecondsLeft(seconds);
    return true;
  };

  useEffect(() => {
    let active = true;
    void consoleRequest<{
      requires_setup: boolean;
      password_gate?: boolean;
      default_password_hint?: boolean;
    }>("/auth/first-boot")
      .then((result) => {
        if (!active) return;
        if (result.password_gate === true) setPasswordOnly(true);
        if (result.default_password_hint === true) setShowDefaultHint(true);
        if (result.requires_setup) {
          navigate("/setup", { replace: true });
          return;
        }
        setCheckingSetup(false);
      })
      .catch(() => {
        if (active) setCheckingSetup(false);
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await consoleRequest<LoginResult>("/auth/login", {
        method: "POST",
        body: JSON.stringify(
          passwordOnly ? { password } : { username: username.trim(), password },
        ),
      });
      if (result.status !== "success") {
        if (result.requires_setup) {
          navigate("/setup", { replace: true });
          return;
        }
        if (!applyLockout(result.retry_after_seconds)) {
          setError(result.message ?? "Authentication failed. Please check your credentials.");
        }
        return;
      }
      // Drop any cached session state (including a stale unauthenticated
      // `null`) so the protected-route guard refetches the now-authenticated
      // session instead of replaying the null and bouncing back to /login.
      queryClient.removeQueries({ queryKey: queryKeys.session.current });
      navigate(result.requires_setup ? "/setup" : safeReturnPath(params.get("returnTo")), {
        replace: true,
      });
    } catch (reason: unknown) {
      // A 429 throws rather than returning a body, so the wait comes from the
      // response headers (`retry-after`) or the error details, whichever the
      // transport preserved.
      const fromError =
        reason && typeof reason === "object" && "retryAfterSeconds" in reason
          ? (reason as { retryAfterSeconds?: number }).retryAfterSeconds
          : undefined;
      if (applyLockout(fromError)) return;
      if (reason && typeof reason === "object" && "message" in reason) {
        const msg = (reason as { message: unknown }).message;
        if (typeof msg === "string") {
          setError(msg);
          return;
        }
      }
      setError("An unexpected network error occurred.");
    } finally {
      setPending(false);
    }
  };

  if (checkingSetup) {
    return (
      <main className="auth-viewport auth-viewport--brand">
        <div className="auth-window auth-window--glass">
          <div className="auth-brandline">
            <span className="auth-mark">
              <BrandMark />
            </span>
            <span className="auth-brandtext">
              <strong>LianRouter</strong>
              <small>AI PROXY ROUTER</small>
            </span>
          </div>
          <h1 className="auth-title">Checking console setup…</h1>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-viewport auth-viewport--brand">
      <div className="auth-stack">
        <div className="auth-window auth-window--glass">
          <div className="auth-brandline">
            <span className="auth-mark">
              <BrandMark />
            </span>
            <span className="auth-brandtext">
              <strong>LianRouter</strong>
              <small>AI PROXY ROUTER</small>
            </span>
          </div>

          <div className="auth-orbit">
            <OrbitObject
              variant="shell"
              label="Routing shell. Press and hold to turn it."
              className="orbit-object--inline"
            />
          </div>

          <div className="auth-lead">
            <h1 className="auth-title">{passwordOnly ? "Console password" : "Sign in"}</h1>
            <p className="auth-desc">
              {passwordOnly
                ? "Enter the console password to manage routing, providers, and keys."
                : "Manage routing, provider accounts, and keys."}
            </p>
          </div>

          <form className="auth-form" onSubmit={submit}>
            {passwordOnly ? null : (
              <div className="auth-field">
                <label className="auth-label" htmlFor="login-username">
                  Username
                </label>
                <div className="auth-input">
                  <User size={15} aria-hidden="true" />
                  <input
                    id="login-username"
                    name="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoComplete="username"
                    placeholder="admin"
                    spellCheck={false}
                  />
                </div>
              </div>
            )}

            <div className="auth-field">
              <label className="auth-label" htmlFor="login-password">
                Password
              </label>
              <div className="auth-input">
                <Lock size={15} aria-hidden="true" />
                <input
                  id="login-password"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="••••••••"
                />
              </div>
            </div>

            {lockedUntil !== null ? (
              // The wait is the whole point of the message: without a number
              // the operator cannot tell a five-second pause from a fifteen
              // minute lock, and retrying blindly only extends it.
              <p className="auth-error" role="alert" aria-live="polite">
                This login is temporarily blocked due to repeated authentication failures.
                {" "}Try again in <strong>{formatWait(secondsLeft)}</strong>.
              </p>
            ) : error ? (
              <p className="auth-error" role="alert">
                {error}
              </p>
            ) : null}

            <Button
              variant="primary"
              type="submit"
              disabled={pending || lockedUntil !== null}
              className="auth-submit"
              icon={<ArrowRight size={15} />}
            >
              {pending
                ? "Signing in…"
                : lockedUntil !== null
                  ? `Locked — ${formatWait(secondsLeft)}`
                  : passwordOnly
                    ? "Unlock console"
                    : "Sign in"}
            </Button>
          </form>

          {showDefaultHint ? (
            <p className="auth-default-hint">
              <Info size={13} aria-hidden="true" />
              <span>
                Default password: <code>local-console-2026</code> — change it in
                Settings → Security Controls, or with
                <code> LIANROUTER_CONSOLE_PASSWORD</code>. A password changed in the
                console stays in effect after a restart.
              </span>
            </p>
          ) : null}

          <p className="auth-foot">
            <ShieldCheck size={13} aria-hidden="true" />
            Sessions are scoped to this browser. Credentials never leave the gateway.
          </p>
        </div>
      </div>
    </main>
  );
}
