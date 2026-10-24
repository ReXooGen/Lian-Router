import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
 * `REDIS_URL` is conditional: `src/persistence/redis.ts` requires it in the
 * default `REDIS_MODE=normal`, while `REDIS_MODE=single_instance_local` runs
 * without a Redis client at all. Listing it unconditionally would reject a
 * configuration the gateway accepts.
 */
const ALWAYS_REQUIRED: readonly string[] = ["DATABASE_URL", "LIANROUTER_ENCRYPTION_KEY"];

/** Parsed gateway configuration for one install root. */
export interface GatewayConfig {
  /** Absolute path of the config file, whether or not it exists. */
  readonly path: string;
  readonly present: boolean;
  /** File values to inject into the child; shell-set names are omitted. */
  readonly env: Readonly<Record<string, string>>;
  /** Required names resolvable from neither the shell nor the file. */
  readonly missing: readonly string[];
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

  const required = [...ALWAYS_REQUIRED];
  if ((effective("REDIS_MODE") ?? "normal") === "normal") {
    required.push("REDIS_URL");
  }

  const missing = required.filter((name) => effective(name) === undefined);

  return { path, present, env, missing };
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
  if (config.missing.includes("REDIS_URL")) {
    lines.push(
      "to run a single gateway process without Redis, set REDIS_MODE=single_instance_local instead of REDIS_URL",
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

/** Starter file body. The database line stays a comment: no invented URL. */
function starterConfigText(encryptionKey: string): string {
  return `# LianRouter gateway configuration.
# The launcher reads this file and passes its values to the gateway process.
# A variable already set in your shell wins over the value written here.
# Generated by \`lianrouter init\`.

# PostgreSQL connection string. Required.
# Replace the placeholder below and remove the leading "# ". The gateway never
# infers a Docker or Laragon connection.
# DATABASE_URL=postgres://user:password@localhost:5432/lianrouter

# 256-bit key for encrypting provider credentials and hashing API keys.
# Required. Base64 (44 characters) or hex (64 characters); it must decode to
# exactly 32 bytes. Keep it secret and keep it stable: a new key cannot decrypt
# credentials encrypted with the old one.
LIANROUTER_ENCRYPTION_KEY=${encryptionKey}

# Redis coordination. REDIS_URL is required in the default mode; set
# REDIS_MODE=single_instance_local to run a single gateway process without
# Redis at all.
REDIS_MODE=normal
# REDIS_URL=redis://localhost:6379
`;
}

/**
 * Writes a starter config, refusing to touch an existing one.
 *
 * `wx` makes the refusal atomic: two concurrent `init` runs cannot both pass an
 * existence check and then clobber each other.
 */
export function writeStarterConfig(installRoot: string): string {
  const path = resolveConfigFile(installRoot);
  mkdirSync(installRoot, { recursive: true });
  const encryptionKey = randomBytes(32).toString("base64");
  try {
    writeFileSync(path, starterConfigText(encryptionKey), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`refusing to overwrite the existing config file at ${path}`);
    }
    throw error;
  }
  return path;
}
