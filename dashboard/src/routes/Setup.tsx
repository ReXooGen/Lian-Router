import { ArrowRight, BadgeCheck, Lock, ShieldCheck, User } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { BrandMark } from "../components/BrandMark";
import { OrbitObject } from "../components/three/OrbitObject";
import { Button } from "../components/ui/button";
import { consoleRequest } from "../lib/api";
import { queryClient } from "../lib/query-client";
import { queryKeys } from "../lib/query-keys";

interface SetupResult {
  readonly status: "success" | "failed";
  readonly message?: string;
}

export default function Setup(): ReactNode {
  const navigate = useNavigate();
  const [username, setUsername] = useState("admin");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim()) {
      setError("Administrator username is required.");
      return;
    }
    if (password.length < 8) {
      setError("Administrator password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await consoleRequest<SetupResult>("/auth/setup", {
        method: "POST",
        body: JSON.stringify({
          username: username.trim(),
          password,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        }),
      });
      if (result.status !== "success") {
        setError(result.message ?? "Setup failed. Please try again.");
        return;
      }
      // Clear any cached session state so a previously primed unauthenticated
      // result cannot bounce the first sign-in back to the setup screen.
      queryClient.removeQueries({ queryKey: queryKeys.session.current });
      navigate("/login", { replace: true });
    } catch (reason: unknown) {
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

        <div className="auth-orbit">
          <OrbitObject
            variant="gate"
            label="Access gate. Press and hold to turn it."
            className="orbit-object--inline"
          />
        </div>

        <div className="auth-lead">
          <h1 className="auth-title">Create the administrator account</h1>
          <p className="auth-desc">
            This is the first boot. The account you create here owns this gateway.
          </p>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <div className="auth-field">
            <label className="auth-label" htmlFor="setup-username">
              Administrator username
            </label>
            <div className="auth-input">
              <User size={15} aria-hidden="true" />
              <input
                id="setup-username"
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

          <div className="auth-field">
            <label className="auth-label" htmlFor="display-name">
              Display name <span className="auth-label-hint">optional</span>
            </label>
            <div className="auth-input">
              <BadgeCheck size={15} aria-hidden="true" />
              <input
                id="display-name"
                name="display_name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                placeholder="Administrator"
              />
            </div>
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="setup-password">
              Master password <span className="auth-label-hint">min. 8 characters</span>
            </label>
            <div className="auth-input">
              <Lock size={15} aria-hidden="true" />
              <input
                id="setup-password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="••••••••"
              />
            </div>
          </div>

          <div className="auth-field">
            <label className="auth-label" htmlFor="setup-confirm">
              Confirm password
            </label>
            <div className="auth-input">
              <Lock size={15} aria-hidden="true" />
              <input
                id="setup-confirm"
                name="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="••••••••"
              />
            </div>
          </div>

          {error ? (
            <p className="auth-error" role="alert">
              {error}
            </p>
          ) : null}

          <Button
            variant="primary"
            type="submit"
            disabled={pending}
            className="auth-submit"
            icon={<ArrowRight size={15} />}
          >
            {pending ? "Creating account…" : "Create account"}
          </Button>
        </form>

        <p className="auth-foot">
          <ShieldCheck size={13} aria-hidden="true" />
          This form works once. The password is hashed with argon2id and cannot be recovered —
          store it somewhere safe.
        </p>
      </div>
    </main>
  );
}
