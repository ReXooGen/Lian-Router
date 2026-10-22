#!/usr/bin/env node
/**
 * Imports CodeBuddy (intl) OAuth accounts into lianrouter from a JSONL export.
 *
 * Emits SQL on stdout for `psql` to apply, rather than connecting to Postgres
 * itself — same reason as `ops-import-grok-oauth.mjs`: the gateway host has no
 * Bun and no checkout, and `psql` is already there. Emitting SQL also keeps the
 * credential encryption key on the host, because the script runs there and
 * nothing but ciphertext leaves it.
 *
 *   node ops-import-codebuddy-oauth.mjs <file.jsonl> [--tenant <uuid>] [--dry-run] \
 *     | sudo -u postgres psql -d lianrouter --single-transaction
 *
 * The crypto is imported from `ops-import-grok-oauth.mjs` rather than copied.
 * Two copies of AES-256-GCM layout would drift, and a drifted copy writes rows
 * the running gateway cannot decrypt — a failure that only surfaces as a
 * provider 401 at dispatch time. That file's contract test already pins its
 * primitives to `src/security/crypto.ts`, so reusing them keeps this script
 * covered by the same test instead of adding a second thing to verify.
 *
 * Input: one JSON object per line, as the registration tool writes it. The
 * fields this needs are `email`, `access_token` and `refresh_token`; the rest
 * (`uid`, `nickname`, `proxy_exit_ip`, …) is metadata the gateway does not
 * store. Expiry is read from the access token's own `exp` claim, because the
 * export has no separate expiry field — `provider_oauth_states.expires_at` is
 * the access token's deadline, which is what the refresh service compares
 * against before it renews.
 *
 * Two rows per account, because the OAuth path needs both: `provider_accounts`
 * (access token) and `provider_oauth_states` (refresh token + expiry). Writing
 * only the first is why an imported OAuth account dies when its access token
 * expires and can never be renewed.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeKey, encryptCredential, hashSecret } from "./ops-import-grok-oauth.mjs";

const PROVIDER_ID = "cb";
const DEFAULT_EXPIRY_SECONDS = 86_400;

/** Single-quoted SQL string with the quote character doubled. */
function sqlText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function option(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`);
  return value;
}

/** Decodes one JWT payload segment; `undefined` when the token is not a JWT. */
function jwtClaims(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads one JSONL line. Returns `{ error }` when the line cannot be used, so a
 * single malformed record is reported and skipped rather than aborting an
 * import of thousands.
 */
function readRecord(line, index) {
  const where = `line ${index}`;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: `${where}: not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: `${where}: not a JSON object` };
  if (parsed.platform !== "codebuddy") {
    return { error: `${where}: platform is "${parsed.platform ?? "(none)"}", not "codebuddy"` };
  }
  const access = typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
  const refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token.trim() : "";
  if (access.length === 0 || refresh.length === 0) {
    return { error: `${where}: missing access_token or refresh_token` };
  }
  const label = typeof parsed.email === "string" ? parsed.email.trim() : "";
  if (label.length === 0) return { error: `${where}: missing email` };

  // The access token's own deadline. A missing or unreadable `exp` falls back
  // to a day out rather than refusing the row: the refresh service renews on
  // any expiry it is given, and a wrong-by-a-day deadline still refreshes
  // correctly, while dropping the row would silently lose the credential.
  const claims = jwtClaims(access);
  const exp = typeof claims?.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : undefined;
  const expiresAt = new Date((exp ?? Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECONDS) * 1000);
  return { row: { label, access, refresh, expiresAt } };
}

export function loadCredentials(path) {
  const rows = [];
  const seen = new Set();
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [offset, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const result = readRecord(trimmed, offset + 1);
    if (result.error !== undefined) {
      console.error(`[skip] ${result.error}`);
      continue;
    }
    // Within-file duplicates would each pass the SQL guard (the first inserts,
    // the second's NOT EXISTS sees it only if the statements run in order), so
    // they are collapsed here where the intent is unambiguous.
    const key = result.row.label.toLowerCase();
    if (seen.has(key)) {
      console.error(`[skip] line ${offset + 1}: duplicate email ${result.row.label}`);
      continue;
    }
    seen.add(key);
    rows.push(result.row);
  }
  return rows;
}

/**
 * One statement per account.
 *
 * Guarded on the label (the account's email), not the credential fingerprint
 * the grok importer uses: this export is a re-registration of accounts the
 * gateway already holds, and those existing rows carry no refresh state at all.
 * Matching on the fingerprint would treat every re-registered token as a new
 * account and leave the old, unrenewable row in place — two rows for one email,
 * either of which dispatch could pick. Matching on the email means an account
 * that already exists is left exactly as it is, and only genuinely new emails
 * are inserted.
 *
 * The CTE makes the account row and its refresh state land together or not at
 * all — an account whose OAuth state is missing cannot refresh and would
 * silently become the next dead credential.
 */
export function accountStatement(key, row, tenantId) {
  const fingerprint = hashSecret(key, row.refresh);
  const access = `'\\x${encryptCredential(key, row.access).toString("hex")}'::bytea`;
  const refresh = `'\\x${encryptCredential(key, row.refresh).toString("hex")}'::bytea`;
  const tenant = tenantId === null ? "NULL" : `${sqlText(tenantId)}::uuid`;
  return [
    `WITH ins AS (`,
    `  INSERT INTO provider_accounts`,
    `    (provider_id, tenant_id, label, credential_ciphertext, credential_fingerprint, credential_kind, status)`,
    `  SELECT ${sqlText(PROVIDER_ID)}, ${tenant}, ${sqlText(row.label)}, ${access}, ${sqlText(fingerprint)}, 'oauth', 'active'`,
    `  WHERE NOT EXISTS (`,
    `    SELECT 1 FROM provider_accounts`,
    `    WHERE provider_id = ${sqlText(PROVIDER_ID)} AND lower(label) = lower(${sqlText(row.label)})`,
    `  )`,
    `  RETURNING id`,
    `)`,
    `INSERT INTO provider_oauth_states (provider_account_id, refresh_ciphertext, expires_at)`,
    `SELECT id, ${refresh}, ${sqlText(row.expiresAt.toISOString())}::timestamptz FROM ins;`,
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const sourceFile = argv.find((arg) => !arg.startsWith("--"));
  if (sourceFile === undefined) {
    throw new Error("usage: ops-import-codebuddy-oauth.mjs <file.jsonl> [--tenant <uuid>] [--dry-run]");
  }
  const tenantId = option(argv, "--tenant") ?? null;
  const dryRun = argv.includes("--dry-run");

  const key = decodeKey(process.env.LIANROUTER_ENCRYPTION_KEY ?? "");
  const rows = loadCredentials(sourceFile);
  console.error(`[import] ${rows.length} usable OAuth credential(s) from ${sourceFile}`);
  if (rows.length === 0) return;
  if (dryRun) {
    for (const row of rows.slice(0, 10)) {
      console.error(`  ${row.label}  expires ${row.expiresAt.toISOString()}`);
    }
    if (rows.length > 10) console.error(`  … and ${rows.length - 10} more`);
    console.error("[import] dry run: nothing written");
    return;
  }

  const out = ["\\set ON_ERROR_STOP on", "BEGIN;"];
  for (const row of rows) out.push(accountStatement(key, row, tenantId));
  out.push("COMMIT;");
  process.stdout.write(`${out.join("\n\n")}\n`);
  console.error(`[import] emitted ${rows.length} statement(s); pipe to psql to apply`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[import] failed:", error);
    process.exit(1);
  });
}
