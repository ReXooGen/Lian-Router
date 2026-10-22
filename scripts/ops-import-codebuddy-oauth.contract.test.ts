import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountStatement, loadCredentials } from "./ops-import-codebuddy-oauth.mjs";
import { decodeKey } from "./ops-import-grok-oauth.mjs";

const KEY_HEX = "a".repeat(64);

/** One JSONL record as the registration tool writes it. */
interface SourceRecord {
  readonly platform: string;
  readonly base_url: string;
  readonly access_token: string;
  readonly refresh_token: string;
  readonly email: string;
  readonly uid: string;
}

/** Builds a JWT-shaped token whose payload carries `exp` (seconds). */
function token(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp, iss: "https://www.codebuddy.ai/auth/realms/copilot" })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

function writeJsonl(records: readonly (SourceRecord | string)[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cb-import-"));
  const path = join(dir, "accounts.jsonl");
  writeFileSync(path, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n"));
  return path;
}

function record(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    platform: "codebuddy",
    base_url: "https://www.codebuddy.ai",
    access_token: token(1_815_199_895),
    refresh_token: token(1_815_199_895),
    email: "chelsea82@ilustrosonic.com",
    uid: "92463a5e-1390-4591-a452-b3bce28d01c7",
    ...overrides,
  };
}

describe("codebuddy JSONL importer", () => {
  test("reads the fields the gateway stores and ignores the rest", () => {
    const rows = loadCredentials(writeJsonl([record()]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("chelsea82@ilustrosonic.com");
    expect(rows[0]?.access).toBe(token(1_815_199_895));
    expect(rows[0]?.refresh).toBe(token(1_815_199_895));
  });

  test("takes the expiry from the access token's own exp claim", () => {
    // The export has no separate expiry field, so a reader that assumed one
    // would silently write a wrong deadline and renew at the wrong time.
    const exp = 1_900_000_000;
    const rows = loadCredentials(writeJsonl([record({ access_token: token(exp), refresh_token: token(exp) })]));
    expect(rows[0]?.expiresAt.getTime()).toBe(exp * 1000);
  });

  test("a token without a readable exp still imports, dated a day out", () => {
    const before = Date.now() + 86_400_000;
    const rows = loadCredentials(writeJsonl([record({ access_token: "not-a-jwt", refresh_token: "not-a-jwt" })]));
    expect(rows).toHaveLength(1);
    const delta = Math.abs((rows[0]?.expiresAt.getTime() ?? 0) - before);
    expect(delta).toBeLessThan(5_000);
  });

  test("skips unusable records instead of aborting the import", () => {
    const rows = loadCredentials(
      writeJsonl([
        record(),
        "{ not json",
        record({ platform: "grok" }),
        record({ email: "" }),
        record({ access_token: "" }),
        record({ email: "second@example.com" }),
      ]),
    );
    // Two usable records survive; the four bad lines are reported and dropped.
    expect(rows.map((r) => r.label)).toEqual([
      "chelsea82@ilustrosonic.com",
      "second@example.com",
    ]);
  });

  test("collapses duplicate emails within one file", () => {
    const rows = loadCredentials(writeJsonl([record(), record({ access_token: token(1) })]));
    expect(rows).toHaveLength(1);
  });

  test("guards the insert on the email, so an existing account is left alone", () => {
    // The fingerprint guard the grok importer uses would treat this export as
    // all-new accounts, because these are re-registrations whose tokens the
    // gateway has never seen. The label is what identifies the account.
    const sql = accountStatement(decodeKey(KEY_HEX), {
      label: "chelsea82@ilustrosonic.com",
      access: token(1),
      refresh: token(1),
      expiresAt: new Date(1_815_199_895_000),
    }, null);
    expect(sql).toContain("lower(label) = lower('chelsea82@ilustrosonic.com')");
    expect(sql).not.toContain("credential_fingerprint =");
  });

  test("writes the account and its refresh state in one statement", () => {
    const sql = accountStatement(decodeKey(KEY_HEX), {
      label: "a@b.c",
      access: token(1),
      refresh: token(1),
      expiresAt: new Date(1_815_199_895_000),
    }, "2e2ade51-1830-46fe-aae2-35a961b1e05a");
    // Both rows or neither: an account without its OAuth state cannot refresh.
    expect(sql).toContain("INSERT INTO provider_accounts");
    expect(sql).toContain("INSERT INTO provider_oauth_states");
    expect(sql).toContain("'cb'");
    expect(sql).toContain("'oauth'");
    expect(sql).toContain("::uuid");
    expect(sql).toContain("::bytea");
  });

  test("escapes a label containing a quote rather than breaking the statement", () => {
    const sql = accountStatement(decodeKey(KEY_HEX), {
      label: "o'brien@example.com",
      access: token(1),
      refresh: token(1),
      expiresAt: new Date(1_815_199_895_000),
    }, null);
    expect(sql).toContain("'o''brien@example.com'");
  });
});
