import { describe, expect, test } from "bun:test";
import {
  loginBody,
  loginScreenFromProbeFailure,
  resolveLoginScreen,
  type LoginScreen,
} from "./login-state";

/**
 * The defect these pin: a failed `/auth/first-boot` probe used to fall through
 * to the username form. The console was in password-gate mode, the server asked
 * for a password alone, and the operator read the rejection as a bad credential
 * while the real cause was an unreachable database.
 */

const FORM_PASSWORD_ONLY: LoginScreen = {
  kind: "form",
  passwordOnly: true,
  showDefaultHint: false,
};

describe("resolveLoginScreen", () => {
  test("password-gate mode renders the password-only form", () => {
    const screen = resolveLoginScreen({ requires_setup: false, password_gate: true });
    if (screen.kind !== "form") throw new Error("expected the form");
    expect(screen.passwordOnly).toBe(true);
  });

  test("a multi-user console keeps the username field", () => {
    const screen = resolveLoginScreen({ requires_setup: false });
    if (screen.kind !== "form") throw new Error("expected the form");
    expect(screen.passwordOnly).toBe(false);
  });

  test("the default-password hint follows the server, not the mode", () => {
    const hinted = resolveLoginScreen({
      requires_setup: false,
      password_gate: true,
      default_password_hint: true,
    });
    if (hinted.kind !== "form") throw new Error("expected the form");
    expect(hinted.showDefaultHint).toBe(true);

    const silent = resolveLoginScreen({ requires_setup: false, password_gate: true });
    if (silent.kind !== "form") throw new Error("expected the form");
    expect(silent.showDefaultHint).toBe(false);
  });

  test("requires_setup redirects before any form is offered", () => {
    // The redirect comes out of the same call that would build a form, so a
    // caller cannot check one and forget the other.
    const screen = resolveLoginScreen({ requires_setup: true, password_gate: true });
    expect(screen.kind).toBe("redirect");
    if (screen.kind !== "redirect") throw new Error("expected a redirect");
    expect(screen.to).toBe("/setup");
  });
});

describe("loginScreenFromProbeFailure", () => {
  test("a failed probe never becomes a form", () => {
    const screen = loginScreenFromProbeFailure(new Error("lianrouter Error: Internal server error"));
    expect(screen.kind).toBe("unavailable");
  });

  test("the transport message is carried through verbatim", () => {
    const screen = loginScreenFromProbeFailure({ message: "database unreachable" });
    if (screen.kind !== "unavailable") throw new Error("expected unavailable");
    expect(screen.message).toBe("database unreachable");
  });

  test("a thrown value without a message still names the condition", () => {
    const screen = loginScreenFromProbeFailure(undefined);
    if (screen.kind !== "unavailable") throw new Error("expected unavailable");
    expect(screen.message).toContain("did not answer");
  });

  test("an empty message is not rendered as an empty alert", () => {
    const screen = loginScreenFromProbeFailure({ message: "   " });
    if (screen.kind !== "unavailable") throw new Error("expected unavailable");
    expect(screen.message.trim()).not.toBe("");
  });
});

describe("loginBody", () => {
  test("password-gate mode sends the password alone", () => {
    expect(loginBody(FORM_PASSWORD_ONLY, "typed-but-ignored", "s3cret")).toEqual({
      password: "s3cret",
    });
  });

  test("multi-user mode trims the username", () => {
    const screen: LoginScreen = { kind: "form", passwordOnly: false, showDefaultHint: false };
    expect(loginBody(screen, "  admin  ", "s3cret")).toEqual({
      username: "admin",
      password: "s3cret",
    });
  });

  test("no body is built for a screen that cannot submit", () => {
    const checking: LoginScreen = { kind: "checking" };
    const unavailable: LoginScreen = { kind: "unavailable", message: "boom" };
    const redirect: LoginScreen = { kind: "redirect", to: "/setup" };
    expect(loginBody(checking, "admin", "s3cret")).toEqual({ password: "s3cret" });
    expect(loginBody(unavailable, "admin", "s3cret")).toEqual({ password: "s3cret" });
    expect(loginBody(redirect, "admin", "s3cret")).toEqual({ password: "s3cret" });
  });
});
