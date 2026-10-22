#!/usr/bin/env node
/**
 * Imports xAI Grok Build OAuth accounts into lianrouter.
 *
 * Emits SQL on stdout for `psql` to apply, rather than connecting to Postgres
 * itself. The gateway host has neither Bun nor a repository checkout, and
 * installing `node_modules` there for a one-time import would add supply-chain
 * surface to a production machine to save nothing: `psql` is already present.
 * Emitting SQL also keeps the credential encryption key on the host, because
 * the script runs there and nothing but ciphertext leaves it.
 *
 *   node ops-import-grok-oauth.mjs <dir> [--tenant <uuid>] [--dry-run] \
 *     | sudo -u postgres psql -d lianrouter --single-transaction
 *
 * The crypto must stay byte-compatible with `src/security/crypto.ts`:
 *   - AES-256-GCM, buffer layout `iv(12) || authTag(16) || ciphertext`
 *   - key = `LIANROUTER_ENCRYPTION_KEY`, hex(64 chars) or base64, 32 bytes
 *   - `credential_fingerprint` = HMAC-SHA256(refresh) under that same key
 * `scripts/ops-import-grok-oauth.contract.test.ts` asserts this file and
 * `src/security/crypto.ts` agree, so a change to one that is not mirrored in
 * the other fails the suite rather than silently writing unreadable rows.
 *
 * Two rows per account, because the OAuth path needs both:
 * `provider_accounts` (access token) and `provider_oauth_states` (refresh
 * token + expiry). Writing only the first is why an imported OAuth account dies
 * when its access token expires and can never be renewed.
 */
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** Mirrors `decodeEncryptionKey` in `src/config.ts`. */
export function decodeKey(raw) {
  const candidate = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(candidate)
    ? Buffer.from(candidate, "hex")
    : Buffer.from(candidate, "base64");
  if (buf.length !== KEY_LENGTH) {
    throw new Error(
      `LIANROUTER_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${buf.length})`,
    );
  }
  return buf;
}

/** Mirrors `encryptCredential` in `src/security/crypto.ts`. */
export function encryptCredential(key, plaintext) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Mirrors `hashSecret` in `src/security/crypto.ts`. */
export function hashSecret(key, secret) {
  return createHmac("sha256", key).update(secret, "utf8").digest("hex");
}

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

/** Reads one credential file; returns `{ error }` when it cannot be used. */
function readCredential(path, name) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { error: `${name}: not valid JSON` };
  }
  if (parsed.auth_kind !== "oauth") {
    return { error: `${name}: auth_kind is "${parsed.auth_kind ?? "(none)"}", not "oauth"` };
  }
  const access = (parsed.access_token ?? "").trim();
  const refresh = (parsed.refresh_token ?? "").trim();
  if (access.length === 0 || refresh.length === 0) {
    return { error: `${name}: missing access_token or refresh_token` };
  }
  const expiresAt = parsed.expired ? new Date(parsed.expired) : null;
  if (expiresAt === null || Number.isNaN(expiresAt.getTime())) {
    return { error: `${name}: missing or unparseable "expired"` };
  }
  return {
    row: {
      label: (parsed.email ?? "").trim() || name.replace(/\.json$/, ""),
      access,
      refresh,
      expiresAt,
    },
  };
}

function loadCredentials(dir) {
  const rows = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const result = readCredential(join(dir, name), name);
    if (result.error !== undefined) console.error(`[skip] ${result.error}`);
    else rows.push(result.row);
  }
  return rows;
}

/**
 * One statement per account, guarded by the credential fingerprint so re-running
 * the import adds nothing. The CTE makes the account row and its refresh state
 * land together or not at all — an account whose OAuth state is missing cannot
 * refresh and would silently become the next dead credential.
 */
function accountStatement(key, row, providerId, tenantId) {
  const fingerprint = hashSecret(key, row.refresh);
  const access = `'\\x${encryptCredential(key, row.access).toString("hex")}'::bytea`;
  const refresh = `'\\x${encryptCredential(key, row.refresh).toString("hex")}'::bytea`;
  const tenant = tenantId === null ? "NULL" : `${sqlText(tenantId)}::uuid`;
  return [
    `WITH ins AS (`,
    `  INSERT INTO provider_accounts`,
    `    (provider_id, tenant_id, label, credential_ciphertext, credential_fingerprint, credential_kind, status)`,
    `  SELECT ${sqlText(providerId)}, ${tenant}, ${sqlText(row.label)}, ${access}, ${sqlText(fingerprint)}, 'oauth', 'active'`,
    `  WHERE NOT EXISTS (`,
    `    SELECT 1 FROM provider_accounts`,
    `    WHERE provider_id = ${sqlText(providerId)} AND credential_fingerprint = ${sqlText(fingerprint)}`,
    `  )`,
    `  RETURNING id`,
    `)`,
    `INSERT INTO provider_oauth_states (provider_account_id, refresh_ciphertext, expires_at)`,
    `SELECT id, ${refresh}, ${sqlText(row.expiresAt.toISOString())}::timestamptz FROM ins;`,
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const sourceDir = argv.find((arg) => !arg.startsWith("--"));
  if (sourceDir === undefined) {
    throw new Error("usage: ops-import-grok-oauth.mjs <dir> [--tenant <uuid>] [--dry-run]");
  }
  const tenantId = option(argv, "--tenant") ?? null;
  const providerId = option(argv, "--provider") ?? "grok";
  const dryRun = argv.includes("--dry-run");

  const key = decodeKey(process.env.LIANROUTER_ENCRYPTION_KEY ?? "");
  const rows = loadCredentials(sourceDir);
  console.error(`[import] ${rows.length} usable OAuth credential(s) from ${sourceDir}`);
  if (rows.length === 0) return;
  if (dryRun) {
    for (const row of rows) console.error(`  ${row.label}  expires ${row.expiresAt.toISOString()}`);
    console.error("[import] dry run: nothing written");
    return;
  }

  const out = ["\\set ON_ERROR_STOP on", "BEGIN;"];
  for (const row of rows) out.push(accountStatement(key, row, providerId, tenantId));
  out.push("COMMIT;");
  process.stdout.write(`${out.join("\n\n")}\n`);
  console.error(`[import] emitted ${rows.length} statement(s); pipe to psql to apply`);
}

// `pathToFileURL` rather than a hand-built `file://${argv[1]}`: on Windows the
// argument is a `C:\...` path, and the string comparison silently never matched,
// so the script printed nothing and exited 0 instead of importing.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("[import] failed:", error);
    process.exit(1);
  });
}
