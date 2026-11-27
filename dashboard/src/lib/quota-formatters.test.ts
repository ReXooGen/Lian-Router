import { describe, expect, test } from "bun:test";
import {
  formatQuotaWindowLabel,
  formatResetDistance,
  friendlyQuotaError,
  quotaBarTone,
  accountIdentity,
  pendingGrantLabel,
} from "./quota-formatters";

describe("quota display formatters", () => {
  test("uses named windows and converts hour labels to days", () => {
    expect(formatQuotaWindowLabel("168 Hour")).toBe("Weekly");
    expect(formatQuotaWindowLabel("167 hour")).toBe("6d 23h");
    expect(formatQuotaWindowLabel("720 hour")).toBe("Monthly");
    expect(formatQuotaWindowLabel("24 hour")).toBe("Daily");
    expect(formatQuotaWindowLabel("5 hour")).toBe("5h");
  });

  test("does not render placeholder punctuation for missing reset times", () => {
    expect(formatResetDistance(null)).toBe("");
  });

  test("formats future reset distance correctly", () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    expect(formatResetDistance(future)).toBe("Resets in 2mins");
  });

  test("labels non-recurring CodeBuddy bonus windows as expirations", () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    expect(formatResetDistance(future, false)).toBe("Expires in 2mins");
  });

  test("prioritizes OAuth invalidation over quota wording", () => {
    expect(friendlyQuotaError("OAuth account invalidated; reauthorization required")).toBe(
      "OAuth account invalidated — re-login required",
    );
  });

  /**
   * Every rejection the quota collector raises opens with "Quota endpoint
   * rejected request", so a generic `quota` match swallowed the 429 that
   * followed it and told the operator the account's quota was exhausted when
   * the vendor had only rate-limited the read.
   */
  test("names a rate limit instead of calling it an exhausted quota", () => {
    expect(friendlyQuotaError("Quota endpoint rejected request: rate limited (HTTP 429)")).toBe(
      "Vendor rate limit — retry shortly, the account is fine",
    );
    expect(friendlyQuotaError("Quota endpoint rejected request: HTTP 429")).toBe(
      "Vendor rate limit — retry shortly, the account is fine",
    );
  });

  test("shows an answered empty account as a state, not a provider error", () => {
    expect(friendlyQuotaError("This account has no plan grants (device mid 7a002dff…).")).toBe(
      "No plan on this account yet — claim a campaign or wait for one",
    );
  });

  /**
   * A buddy-family `api_key` row holds an offline-session token, so a 401 means
   * the vendor ended that session. The OAuth wording ("refresh token") names a
   * flow the account does not have, and the previous copy told the operator to
   * replace a key they never entered.
   */
  test("points an api_key rejection at signing in again, not at refreshing a token", () => {
    const raw = "CodeBuddy CN credential invalid or expired.";
    expect(friendlyQuotaError(raw, "api_key")).toBe(
      "Credential rejected — sign in again for this account",
    );
    expect(friendlyQuotaError(raw, "oauth")).toBe(
      "Credential expired — re-login or refresh token",
    );
  });

  /**
   * The credential branch used to match the bare word `invalid`, so a malformed
   * quota body ("returned invalid JSON") was reported as an expired credential.
   * That sends the operator to re-authenticate an account that is fine.
   */
  test("does not read a malformed quota body as a rejected credential", () => {
    expect(friendlyQuotaError("CodeBuddy CN quota response returned invalid JSON")).toBe(
      "Provider returned an unreadable quota response — retry shortly",
    );
  });

  test("assigns bar tones based on remaining percent thresholds", () => {
    expect(quotaBarTone(10).bar).toBe("var(--red)");
    expect(quotaBarTone(40).bar).toBe("var(--orange)");
    expect(quotaBarTone(80).bar).toBe("var(--green)");
    expect(quotaBarTone(null).bar).toBe("var(--text-tertiary)");
  });

  test("resolves account identity prioritizing email and cleaning tokens", () => {
    const emailIdent = accountIdentity("user@example.com", "My Account");
    expect(emailIdent.primary).toBe("user@example.com");
    expect(emailIdent.secondary).toBe("My Account");

    const nonEmailIdent = accountIdentity("team-pro", "Account 1");
    expect(nonEmailIdent.primary).toBe("Account 1");
    expect(nonEmailIdent.secondary).toBe("team-pro");
  });

  test("hides credential-kind hints from account identity", () => {
    for (const kind of ["oauth", "api_key", "none"]) {
      const ident = accountIdentity(kind, "My Account");
      expect(ident.primary).toBe("My Account");
      expect(ident.secondary).toBeNull();
    }
  });

  /**
   * A campaign is issued hours before its units unlock: the plan is `active`
   * and its size is known, but the vendor refuses every request until a
   * scheduled instant (measured: `effective_at` 22:00 for a 19:00 claim). The
   * window must report the schedule, because rendering it as a balance says
   * "300M available" while nothing works, and rendering it as empty says the
   * grant is missing.
   */
  describe("pendingGrantLabel", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");

    test("names the scheduled instant for a grant that is not live yet", () => {
      const label = pendingGrantLabel("2026-11-10T14:00:00Z", now);
      expect(label).not.toBeNull();
      expect(label).toContain("Pending");
      expect(label).not.toContain("Expires in");
    });

    test("returns null once the grant is spendable", () => {
      expect(pendingGrantLabel("2026-11-10T11:00:00Z", now)).toBeNull();
      // Exactly now is already spendable; a boundary that reported "pending"
      // would strand the grant for the whole request that unlocks it.
      expect(pendingGrantLabel("2026-11-10T12:00:00Z", now)).toBeNull();
    });

    test("returns null when nothing is scheduled", () => {
      expect(pendingGrantLabel(null, now)).toBeNull();
      expect(pendingGrantLabel(undefined, now)).toBeNull();
      expect(pendingGrantLabel("not-a-date", now)).toBeNull();
    });
  });
});
