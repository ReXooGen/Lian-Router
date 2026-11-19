/**
 * Which shape the login screen takes, and what it sends.
 *
 * The screen has four states, and the order matters. `checking` is the boot
 * probe in flight; `redirect` is an instance with no console user yet;
 * `form` is a known shape; `unavailable` is the probe having *failed*.
 *
 * That last state exists because collapsing it into `form` was a real defect:
 * when the gateway's database was down, `/auth/first-boot` answered 500, the
 * probe fell through to the default, and the screen rendered a username field
 * the server never asked for. The operator typed a username into a
 * password-only console and read the rejection as a wrong credential rather
 * than a dead database.
 *
 * The rule the module encodes: a failed probe is never silently a known shape.
 * One function decides the state from a successful answer, so a caller cannot
 * forget to check the redirect before asking for a form.
 */

/** The `GET /auth/first-boot` body, as far as this screen cares. */
export interface SetupProbeResult {
  readonly requires_setup: boolean;
  readonly password_gate?: boolean;
  readonly default_password_hint?: boolean;
}

export type LoginScreen =
  | { readonly kind: "checking" }
  | { readonly kind: "redirect"; readonly to: "/setup" }
  | {
      readonly kind: "form";
      /** Single-password mode: the server owns the only credential. */
      readonly passwordOnly: boolean;
      /** True only while the instance still ships its default password. */
      readonly showDefaultHint: boolean;
    }
  | { readonly kind: "unavailable"; readonly message: string };

export interface LoginRequestBody {
  readonly username?: string;
  readonly password: string;
}

/**
 * Resolves a successful probe into the screen to render.
 *
 * `requires_setup` wins over everything: an instance with no console user has
 * nothing to sign in to, so the wizard is the only correct destination even in
 * password-gate mode. Returning it from here — rather than from a second
 * function the caller must remember to call first — is what keeps the two
 * decisions in one place.
 */
export function resolveLoginScreen(result: SetupProbeResult): LoginScreen {
  if (result.requires_setup) {
    return { kind: "redirect", to: "/setup" };
  }
  return {
    kind: "form",
    passwordOnly: result.password_gate === true,
    showDefaultHint: result.default_password_hint === true,
  };
}

/**
 * Turns a probe rejection into the unavailable screen.
 *
 * The transport's message is preferred because it names the actual condition
 * ("lianrouter Error: Internal server error" for a dead database); the fallback
 * exists for a thrown value that carries no message at all.
 */
export function loginScreenFromProbeFailure(reason: unknown): LoginScreen {
  return { kind: "unavailable", message: describeProbeFailure(reason) };
}

function describeProbeFailure(reason: unknown): string {
  if (reason !== null && typeof reason === "object" && "message" in reason) {
    const message = (reason as { message: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return "The gateway did not answer the console setup check.";
}

/**
 * Builds the login body for the current screen.
 *
 * The username is included only when the form actually asked for one. Sending a
 * blank username in password-gate mode is not harmful — the server ignores it —
 * but sending one at all implies the screen asked, and a wrong body here is how
 * the password-only console starts rejecting valid passwords after a future
 * change to the route.
 */
export function loginBody(screen: LoginScreen, username: string, password: string): LoginRequestBody {
  if (screen.kind !== "form" || screen.passwordOnly) {
    return { password };
  }
  return { username: username.trim(), password };
}
