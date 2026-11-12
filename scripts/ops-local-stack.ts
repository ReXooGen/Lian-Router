#!/usr/bin/env bun
/**
 * `bun run dev:local` — the whole stack with no Docker and no Redis server.
 *
 * This script is the parent of everything: it starts a real PostgreSQL cluster
 * in this process, then spawns the backend and the dashboard as children with
 * `DATABASE_URL` and `REDIS_MODE=embedded` in their environment.
 *
 * Why the parent owns the cluster rather than a sibling process: the cluster is
 * a child of whoever started it and stops when that process exits. Making the
 * orchestrator the owner means one Ctrl-C unwinds both — the children die, then
 * the postmaster — instead of leaving an orphan server holding the port.
 *
 * Why the environment is passed down instead of written to `.env`: the gateway
 * keeps `DATABASE_URL` as the single source of its connection string, and this
 * script is a *caller* supplying it. Nothing below the boot path learns that
 * the cluster happens to be local, and an operator who later points
 * `DATABASE_URL` at a real server changes no code.
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
 * child handle — the situation after a previous run was hard-killed on Windows,
 * where a child outlives its parent. `pg_ctl stop` works from a fresh handle
 * against a running cluster, which is the only way to reap that orphan instead
 * of leaving it owning the port and the data directory.
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
  const { promise, resolve: settle } = Promise.withResolvers<boolean>();
  const child = spawn(pgCtl, ["stop", "-D", databaseDir, "-m", "fast", "-w"], {
    stdio: "ignore",
  });
  child.on("error", () => settle(false));
  child.on("exit", (code) => settle(code === 0));
  return promise;
}

const server = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
});

// `initdb` refuses a populated directory; the guard is what makes the second
// run reuse the cluster the first one created instead of failing on it.
if (!existsSync(join(databaseDir, "PG_VERSION"))) {
  mkdirSync(databaseDir, { recursive: true });
  await server.initialise();
} else if (await stopOrphanCluster()) {
  console.log(`[dev:local] reaped a cluster left behind by a previous run`);
}

await server.start();
try {
  await server.createDatabase(database);
} catch {
  // Already present on every run after the first.
}

const databaseUrl = `postgres://${user}:${password}@127.0.0.1:${port}/${database}`;
console.log(`[dev:local] postgres ready on 127.0.0.1:${port} (no Docker)`);
console.log(`[dev:local] REDIS_MODE=embedded (in-process, single-instance)`);

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  REDIS_MODE: "embedded",
};

const children = [
  spawn("bun", ["run", "--hot", "src/main.ts"], {
    cwd: projectRoot,
    env: childEnv,
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
  spawn("bun", ["run", "dashboard:dev"], {
    cwd: projectRoot,
    env: childEnv,
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
];

/**
 * Ends one child and everything it spawned.
 *
 * `shell: true` means the pid is the shell, not the runtime: `child.kill()`
 * would end `cmd.exe` and leave the backend listening on 12800 with nothing
 * holding its handle — the same orphan problem as the cluster, one layer up.
 * `taskkill /T` walks the tree instead.
 */
function killTree(child: (typeof children)[number]): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill();
}

let stopping = false;
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[dev:local] ${reason} — stopping`);
  for (const child of children) killTree(child);
  try {
    await server.stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// A child exiting on its own is a real failure of the stack, not a normal end:
// the backend crashing must not leave a dashboard and a database running.
for (const child of children) {
  child.on("exit", (code, signal) => {
    if (stopping) return;
    void shutdown(`child exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
  });
}

await new Promise<void>(() => {});
