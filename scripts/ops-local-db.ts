#!/usr/bin/env bun
/**
 * Long-lived local PostgreSQL for a Docker-free install.
 *
 * Why a separate process instead of booting the cluster inside the gateway: the
 * cluster is a child process of whoever started it and stops when that process
 * exits. Booting it inside the gateway would mean mutating `DATABASE_URL` in
 * memory before `getPool()` reads it, and `DATABASE_URL` being the single source
 * of the connection string is a contract this repository does not bend. So this
 * process owns the cluster, prints the URL, and stays alive; the gateway reads
 * the same variable it always reads.
 *
 * `bun run dev` starts it beside the backend, which is the whole point: no
 * Docker, no service install, no manual `initdb`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const projectRoot = resolve(import.meta.dir, "..");
const databaseDir = join(projectRoot, "pgdata");
const port = Number(process.env.LIANROUTER_LOCAL_DB_PORT ?? "55433");
const user = "postgres";
const password = "postgres";
const database = "lianrouter";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(
    `LIANROUTER_LOCAL_DB_PORT must be a valid port (got "${process.env.LIANROUTER_LOCAL_DB_PORT}")`,
  );
}

/**
 * Absolute path of `pg_ctl` from the platform binary package.
 *
 * Needed because `EmbeddedPostgres.stop()` is a no-op when the instance holds no
 * child handle — the exact situation after a previous run was hard-killed on
 * Windows, where a child outlives its parent. `pg_ctl stop` works from a fresh
 * handle against a running cluster, so it is the only way to reap that orphan
 * instead of leaving it owning the port and the data directory.
 */
function resolvePgCtl(): string | undefined {
  const require = createRequire(import.meta.url);
  const binary = process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl";
  try {
    const platformPkg = `@embedded-postgres/${process.platform}-${process.arch}`;
    const pkgJson = require.resolve(`${platformPkg}/package.json`);
    const candidate = join(dirname(pkgJson), "native", "bin", binary);
    if (existsSync(candidate)) return candidate;
  } catch {
    // Platform package not installed; fall through.
  }
  return undefined;
}

/** Stops a cluster this process does not own. Never throws. */
async function stopOrphanCluster(): Promise<boolean> {
  const pgCtl = resolvePgCtl();
  if (!pgCtl) return false;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const child = spawn(pgCtl, ["stop", "-D", databaseDir, "-m", "fast", "-w"], {
    stdio: "ignore",
  });
  child.on("error", () => resolve(false));
  child.on("exit", (code) => resolve(code === 0));
  return promise;
}

const server = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
});

// `initdb` refuses a populated directory, so the guard is what makes a second
// run reuse the cluster the first one created instead of failing on it.
if (!existsSync(join(databaseDir, "PG_VERSION"))) {
  mkdirSync(databaseDir, { recursive: true });
  await server.initialise();
} else if (await stopOrphanCluster()) {
  console.log("[local-db] reaped a cluster left behind by a previous run");
}

await server.start();

try {
  await server.createDatabase(database);
} catch {
  // Already present on every run after the first.
}

const url = `postgres://${user}:${password}@127.0.0.1:${port}/${database}`;
console.log(`[local-db] cluster ready on 127.0.0.1:${port}`);
console.log(`[local-db] DATABASE_URL=${url}`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[local-db] ${signal} — stopping cluster`);
  try {
    await server.stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// The postmaster is a child process, but nothing guarantees Bun keeps this
// process' event loop alive on that alone. A pending promise is explicit about
// the intent: this script runs until a signal arrives.
await new Promise<void>(() => {});
