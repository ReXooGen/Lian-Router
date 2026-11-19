import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { DEFAULT_CONSOLE_PASSWORD } from "../../src/console/auth/default-console-password";
import { resolveConfigFile } from "./paths";

/**
 * Configuration for an installed gateway copy.
 *
 * The launcher owns this seam on purpose. `src/config.ts` documents its
 * resolvers as "pure with respect to `process.env` at call time" and
 * `src/main.ts` bootstraps from that environment, so the gateway stays a plain
 * `process.env` consumer: nothing here changes its contract, and a compiled
 * binary needs no dotenv parser of its own. The launcher reads
 * `<installRoot>/.env` and injects the values into the child environment
 * before spawn.
 *
 * Precedence is one rule, applied in one place: a value already present in the
 * launcher's own environment wins, and only file entries with no shell
 * counterpart are injected. An operator's `DATABASE_URL=... lianrouter` stays
 * authoritative, and the file is never consulted to override it.
 *
 * A development checkout is deliberately out of scope: `resolveRuntime()` runs
 * the gateway from the repository root, where Bun loads the repository's
 * `.env` itself, and the install root is a state directory rather than the
 * gateway's working directory.
 */

/**
 * Values the gateway cannot boot without.
 *
 * `DATABASE_URL` is conditional in the same way `REDIS_URL` is: it is the only
 * source the gateway accepts, but the launcher can supply it itself when
 * `DATABASE_MODE=embedded` makes it start a cluster for the child. Requiring it
 * unconditionally would reject a configuration the launcher fulfils.
 *
 * `REDIS_URL` is conditional because `src/persistence/redis.ts` requires it in
 * the default `REDIS_MODE=normal`, while `REDIS_MODE=single_instance_local` runs
 * without a Redis client at all and `REDIS_MODE=embedded` supplies one
 * in-process.
 */
const ALWAYS_REQUIRED: readonly string[] = ["LIANROUTER_ENCRYPTION_KEY"];

/** Parsed gateway configuration for one install root. */
export interface GatewayConfig {
  /** Absolute path of the config file, whether or not it exists. */
  readonly path: string;
  readonly present: boolean;
  /** File values to inject into the child; shell-set names are omitted. */
  readonly env: Readonly<Record<string, string>>;
  /** Required names resolvable from neither the shell nor the file. */
  readonly missing: readonly string[];
  /**
   * Where the gateway's `DATABASE_URL` comes from.
   *
   * `url` means the operator supplies it; `embedded` means the launcher must
   * start a cluster and inject the connection string itself. Resolved here, with
   * the same precedence as every other name, so the check and the start cannot
   * disagree about which mode is in force.
   */
  readonly databaseMode: "url" | "embedded";
}

/**
 * Parses `KEY=value` lines.
 *
 * Comments are whole lines only: an unquoted value keeps everything after the
 * first `=`, so a password containing `#` survives. Surrounding single or
 * double quotes are stripped; malformed lines are skipped rather than failing
 * the launch, because a stray line must not keep a configured gateway down.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length >= 2 && value.endsWith(quote)) {
        value = value.slice(1, -1);
      }
    }
    values[key] = value;
  }
  return values;
}

/**
 * Resolves the config file for an installed copy.
 *
 * Reads only; a missing file is not an error here. The caller decides whether
 * that is fatal, because `status` and `stop` must still answer on a machine
 * that was never configured.
 */
export function resolveGatewayConfig(
  installRoot: string,
  shellEnv: Readonly<Record<string, string | undefined>> = process.env,
): GatewayConfig {
  const path = resolveConfigFile(installRoot);
  const present = existsSync(path);
  const fileValues = present ? parseEnvFile(readFileSync(path, "utf8")) : {};

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(fileValues)) {
    // The shell wins. Injecting here would let `Object.assign` in the
    // supervisor overwrite an operator's explicit export.
    if (shellEnv[key] !== undefined && shellEnv[key].trim() !== "") {
      continue;
    }
    if (value.trim() === "") {
      continue;
    }
    env[key] = value;
  }

  // Effective view after precedence, used to decide which names are required.
  const effective = (name: string): string | undefined => {
    const fromShell = shellEnv[name];
    if (fromShell !== undefined && fromShell.trim() !== "") {
      return fromShell.trim();
    }
    const fromFile = fileValues[name];
    return fromFile !== undefined && fromFile.trim() !== "" ? fromFile.trim() : undefined;
  };

  const databaseMode = (effective("DATABASE_MODE") ?? "url") === "embedded" ? "embedded" : "url";
  const required = [...ALWAYS_REQUIRED];
  if (databaseMode !== "embedded") {
    required.push("DATABASE_URL");
  }
  if ((effective("REDIS_MODE") ?? "normal") === "normal") {
    required.push("REDIS_URL");
  }

  const missing = required.filter((name) => effective(name) === undefined);

  return { path, present, env, missing, databaseMode };
}

/**
 * Explains what is missing before anything is spawned.
 *
 * The gateway's own error is accurate but arrives after a spawn and a health
 * wait, and it cannot name the file an installed copy is supposed to read. This
 * message names the path, the exact variables, and one next step.
 */
export function describeMissingConfig(config: GatewayConfig): string {
  const location = config.present
    ? `  config file: ${config.path}`
    : `  config file: ${config.path} (not found)`;
  const examples: Record<string, string> = {
    DATABASE_URL: "postgres://user:password@localhost:5432/lianrouter",
    LIANROUTER_ENCRYPTION_KEY: "<base64 or 64-character hex that decodes to exactly 32 bytes>",
    REDIS_URL: "redis://localhost:6379",
  };
  const lines = [
    "the gateway is not configured, so it cannot start",
    location,
    `  missing:     ${config.missing.join(", ")}`,
    "",
    "add these lines to that file:",
    ...config.missing.map((name) => `  ${name}=${examples[name] ?? "<value>"}`),
    "",
    "or set them in your shell before starting; a shell value wins over the file.",
    `run \`lianrouter init\` to write a starter file at ${config.path}`,
  ];
  if (config.missing.includes("DATABASE_URL")) {
    lines.push(
      "to have the launcher start a private PostgreSQL for you, set DATABASE_MODE=embedded instead of DATABASE_URL",
    );
  }
  if (config.missing.includes("REDIS_URL")) {
    lines.push(
      "to run without a Redis server, set REDIS_MODE=embedded (in-process) or REDIS_MODE=single_instance_local (no Redis at all, and no console)",
    );
  }
  return lines.join("\n");
}

/** Throws when the gateway could not boot from the resolved configuration. */
export function assertGatewayConfigured(config: GatewayConfig): void {
  if (config.missing.length > 0) {
    throw new Error(describeMissingConfig(config));
  }
}

/** Starter file body: a self-contained install that starts on the first run. */
function starterConfigText(encryptionKey: string): string {
  return `# LianRouter gateway configuration.
# The launcher reads this file and passes its values to the gateway process.
# A variable already set in your shell wins over the value written here.
# Generated by \`lianrouter init\`.

# Database. DATABASE_MODE=embedded has the launcher start a private PostgreSQL
# for this install and hand the gateway a DATABASE_URL pointing at it — nothing
# to install, nothing to configure. To use your own server instead, delete the
# DATABASE_MODE line and set DATABASE_URL:
# DATABASE_URL=postgres://user:password@localhost:5432/lianrouter
DATABASE_MODE=embedded

# Console password. When set, the console asks for this one password and
# nothing else — no username, no first-boot account wizard. This is the mode a
# single-operator local install wants. \`local-console-2026\` is the shipped
# default and the login screen prints it while it is still in use; set your own
# value and the hint disappears. Leave the line commented out to keep per-user
# accounts and the setup wizard.
#
# This is the INITIAL password: it can also be changed from the console
# (Settings -> Security Controls), which stores a hash and takes ownership.
LIANROUTER_CONSOLE_PASSWORD=local-console-2026

# 256-bit key for encrypting provider credentials and hashing API keys.
# Required. Base64 (44 characters) or hex (64 characters); it must decode to
# exactly 32 bytes. Keep it secret and keep it stable: a new key cannot decrypt
# credentials encrypted with the old one.
LIANROUTER_ENCRYPTION_KEY=${encryptionKey}

# Redis coordination. \`embedded\` runs a Redis client inside the gateway process,
# which is what a single-machine install wants; set REDIS_URL (with
# REDIS_MODE=normal) to share coordination state with another process.
REDIS_MODE=embedded
# REDIS_URL=redis://localhost:6379
`;
}

/**
 * Removes one active `KEY=` line, leaving comments untouched.
 *
 * The upgrade path replaces a value rather than appending a second line for the
 * same name: `parseEnvFile` keeps the last occurrence, so an appended line would
 * win by accident of ordering instead of by policy, and a reader of the file
 * would see two answers to one question.
 */
function withoutActiveKey(text: string, key: string): string {
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=`, "m");
  return text
    .split(/\r?\n/)
    .filter((line) => !pattern.test(line))
    .join("\n");
}

/** True when the text carries an active (non-comment) assignment for `key`. */
function hasActiveKey(text: string, key: string): boolean {
  return new RegExp(`^[ \\t]*${key}[ \\t]*=`, "m").test(text);
}

/** Appends one `KEY=value` line with a blank separator, preserving the tail newline. */
function appendEntry(text: string, key: string, value: string): string {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `${body}\n${key}=${value}\n`;
}

/**
 * Brings an existing config file up to what this launcher can start with.
 *
 * The failure this exists for is a version seam, not a typo. A launcher released
 * before `DATABASE_MODE=embedded` wrote a starter file whose only database line
 * was a *commented* `DATABASE_URL` placeholder, and `lianrouter init` refused to
 * touch it because the file already existed. The operator then upgraded, ran
 * `init` again as instructed, got `refusing to overwrite` on a file they never
 * edited, and the gateway stayed unstartable — the release that removed the
 * requirement could not reach the file that encoded it.
 *
 * Migrating is the correct answer because the file is the launcher's own
 * artifact: every line in it was generated here, so there is no operator prose
 * to lose. The rules are deliberately narrow:
 *
 * - An operator's own connection string is never replaced. If `DATABASE_URL` is
 *   set, that install talks to that server and `DATABASE_MODE=embedded` is not
 *   added on top of it.
 * - `REDIS_MODE=normal` with no usable `REDIS_URL` is the unstartable pair the
 *   old starter file produced, so it becomes `embedded`. A mode the operator
 *   cannot boot is not a preference worth preserving.
 * - A missing or unparsable encryption key is filled in, because nothing else
 *   can produce one and the gateway refuses to start without it.
 * - A missing console-password line is filled with the shipped default, because
 *   a local install with no gate renders a username form the operator never
 *   asked for and a setup wizard in front of a private machine. An operator who
 *   prefers per-user accounts deletes or comments the line; the ownership
 *   transfer means a console-changed password survives it.
 */
export function upgradeStarterConfig(text: string, encryptionKey: string): string {
  let next = text;

  const hasDatabaseUrl = hasActiveKey(next, "DATABASE_URL");
  if (!hasActiveKey(next, "DATABASE_MODE") && !hasDatabaseUrl) {
    next = appendEntry(next, "DATABASE_MODE", "embedded");
  }

  const redisMode = /^[ \t]*REDIS_MODE[ \t]*=[ \t]*(\S*)/m.exec(next)?.[1]?.replace(/^["']|["']$/g, "");
  const hasRedisUrl = hasActiveKey(next, "REDIS_URL");
  if (!hasActiveKey(next, "REDIS_MODE") && !hasRedisUrl) {
    next = appendEntry(next, "REDIS_MODE", "embedded");
  } else if (redisMode === "normal" && !hasRedisUrl) {
    next = withoutActiveKey(next, "REDIS_MODE");
    next = appendEntry(next, "REDIS_MODE", "embedded");
  }

  const existingKey = parseEnvFile(next).LIANROUTER_ENCRYPTION_KEY;
  if (existingKey === undefined || existingKey.trim() === "") {
    next = appendEntry(next, "LIANROUTER_ENCRYPTION_KEY", encryptionKey);
  }

  // A local install without a console password falls back to the multi-user
  // wizard, which is the wrong shape for a single-operator machine. The default
  // here matches the starter file; ownership transfer keeps a console-changed
  // password authoritative over this value on later boots.
  if (!hasActiveKey(next, "LIANROUTER_CONSOLE_PASSWORD")) {
    next = appendEntry(next, "LIANROUTER_CONSOLE_PASSWORD", DEFAULT_CONSOLE_PASSWORD);
  }

  return next;
}

/**
 * Outcome of {@link writeStarterConfig}: which file, and whether it was made or
 * repaired. The caller prints this, so the distinction has to survive the return.
 */
export interface StarterConfigResult {
  readonly path: string;
  readonly kind: "created" | "migrated" | "unchanged";
}

/**
 * Writes the starter config, or migrates the one that is already there.
 *
 * `init` used to refuse an existing file outright, which made it useless in
 * exactly the situation it is advertised for: an install that cannot start.
 * Refusing protects nothing — the file is generated, not authored — so an
 * existing file is backed up and rewritten in place, and an existing file that
 * already starts is left byte-identical.
 */
export function writeStarterConfig(installRoot: string): StarterConfigResult {
  const path = resolveConfigFile(installRoot);
  mkdirSync(installRoot, { recursive: true });
  const encryptionKey = randomBytes(32).toString("base64");

  if (existsSync(path)) {
    // Keep the operator's key stable across the migration: a fresh key cannot
    // decrypt credentials the old one encrypted, so regenerating it here would
    // silently invalidate every stored provider secret.
    const current = readFileSync(path, "utf8");
    const preserved = parseEnvFile(current).LIANROUTER_ENCRYPTION_KEY;
    const key = preserved !== undefined && preserved.trim() !== "" ? preserved : encryptionKey;
    const migrated = upgradeStarterConfig(current, key);
    if (migrated === current) {
      return { path, kind: "unchanged" };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(`${path}.bak-${stamp}`, current, { encoding: "utf8" });
    writeFileSync(path, migrated, { encoding: "utf8" });
    return { path, kind: "migrated" };
  }

  writeFileSync(path, starterConfigText(encryptionKey), { encoding: "utf8", flag: "wx" });
  return { path, kind: "created" };
}
