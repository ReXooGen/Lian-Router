/**
 * An embedded PostgreSQL cluster for a self-contained install.
 *
 * The gateway's persistence boundary names one source: `DATABASE_URL`
 * (`src/persistence/postgres.ts`). It has no in-memory mode and never infers a
 * server, which is the right contract — but it left an installed copy needing a
 * database before `lianrouter` would start at all. `DATABASE_MODE=embedded`
 * closes that gap from the launcher side rather than inside the gateway: this
 * module starts a real PostgreSQL from the platform's own server binaries and
 * hands the child a `DATABASE_URL` pointing at it. The gateway keeps consuming
 * `process.env` exactly as documented, and nothing downstream learns a second
 * connection source exists.
 *
 * Two lifecycle facts drive the shape here:
 *
 * 1. The cluster is a child of this process. `EmbeddedPostgres` spawns the
 *    postmaster itself, so one Ctrl-C unwinds both, and a launcher that dies
 *    hard leaves an orphan the next run reaps through `pg_ctl stop`.
 * 2. The binaries are optional dependencies of `embedded-postgres`, resolved by
 *    platform at runtime. That is why the import is dynamic and the failure is
 *    reported as advice instead of a stack trace: an unsupported platform, or a
 *    pruned `node_modules`, is an operator problem with an operator fix.
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type EmbeddedPostgresClient from "embedded-postgres";

/** Port the embedded cluster listens on. */
export const EMBEDDED_DATABASE_PORT = 55433;

/** Credentials for the embedded cluster. Local-only: it binds 127.0.0.1. */
const EMBEDDED_DATABASE_USER = "postgres";
const EMBEDDED_DATABASE_PASSWORD = "postgres";
const EMBEDDED_DATABASE_NAME = "lianrouter";

/** The connection string the embedded cluster serves. */
export function embeddedDatabaseUrl(port: number = EMBEDDED_DATABASE_PORT): string {
  return `postgres://${EMBEDDED_DATABASE_USER}:${EMBEDDED_DATABASE_PASSWORD}@127.0.0.1:${port}/${EMBEDDED_DATABASE_NAME}`;
}

/** Where the cluster keeps its data, under the install root. */
export function resolveEmbeddedDatabaseDir(installRoot: string): string {
  return join(installRoot, "pgdata");
}

/** A running cluster owned by this process. */
export interface EmbeddedDatabase {
  /** `DATABASE_URL` for the gateway child. */
  readonly url: string;
  readonly port: number;
  /** Stops the postmaster. Safe to call twice. */
  stop(): Promise<void>;
}

export interface StartEmbeddedDatabaseOptions {
  readonly installRoot: string;
  readonly port?: number;
  /** Relays server output; defaults to dropping it. */
  readonly onLog?: (message: string) => void;
}

/** Failure carrying advice an operator can act on. */
export class EmbeddedDatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddedDatabaseUnavailableError";
  }
}

/**
 * Absolute path of `pg_ctl` inside the platform binary package.
 *
 * Resolved through the package's own manifest rather than a hardcoded
 * `node_modules` walk, because the install root is not where the launcher's
 * dependencies live: an npm install puts them beside `dist/cli.js`.
 *
 * Returns `undefined` when the platform package is absent, which is the signal
 * to report an actionable message instead of letting `import()` fail on a path
 * the operator cannot see.
 */
async function resolvePlatformBinary(): Promise<{ dir: string } | undefined> {
  const platform = process.platform;
  const arch = process.arch;
  const packageName =
    platform === "win32" && arch === "x64"
      ? "@embedded-postgres/windows-x64"
      : platform === "darwin" && arch === "arm64"
        ? "@embedded-postgres/darwin-arm64"
        : platform === "darwin" && arch === "x64"
          ? "@embedded-postgres/darwin-x64"
          : platform === "linux" && arch === "x64"
            ? "@embedded-postgres/linux-x64"
            : platform === "linux" && arch === "arm64"
              ? "@embedded-postgres/linux-arm64"
              : platform === "linux" && arch === "arm"
                ? "@embedded-postgres/linux-arm"
                : undefined;
  if (packageName === undefined) {
    return undefined;
  }
  try {
    const resolved = import.meta.resolve(packageName);
    // The package root is the directory holding `native/`; `resolve` gives the
    // entry module, so walk up to the package directory that owns it.
    const entryPath = resolved.startsWith("file:") ? new URL(resolved).pathname : resolved;
    const index = entryPath.lastIndexOf(`${packageName.replace("/", "/")}`);
    if (index === -1) {
      return undefined;
    }
    const packageRoot = entryPath.slice(0, index + packageName.length);
    return { dir: packageRoot };
  } catch {
    return undefined;
  }
}

/**
 * Live postgres.exe pids, via `tasklist` (fast, no WMI dependency).
 *
 * Used only to distinguish a corpse lock — a `postmaster.pid` whose writer is
 * gone — from a live postmaster the caller must not bulldoze.
 */
async function listPostgresProcesses(): Promise<number[]> {
  try {
    const result = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq postgres.exe", "/FO", "CSV", "/NH"]);
    const text = result.stdout.toString();
    const pids: number[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^"postgres\.exe","(\d+)"/.exec(line.trim());
      if (match) pids.push(Number(match[1]!));
    }
    return pids;
  } catch {
    return [];
  }
}

/**
 * True while something still listens on the port.
 *
 * A connect probe rather than a bind probe: binding would race the postmaster
 * for the exact port this process is about to claim. A refused connection is
 * the free-port answer; a connected socket means wait.
 */
async function portIsBusy(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data() {},
        close() {},
      },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** Stops a postmaster this process did not start. Never throws. */
async function stopOrphanCluster(databaseDir: string): Promise<boolean> {
  const dataDirectory = databaseDir;
  if (!existsSync(join(dataDirectory, "PG_VERSION"))) {
    return false;
  }
  const binary = await resolvePlatformBinary();
  if (binary === undefined) {
    return false;
  }
  const pgCtl = join(
    binary.dir,
    "native",
    "bin",
    process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl",
  );
  if (!existsSync(pgCtl)) {
    return false;
  }
  const { promise, resolve: settle } = Promise.withResolvers<boolean>();
  const child = spawn(pgCtl, ["stop", "-D", dataDirectory, "-m", "fast", "-w"], {
    stdio: "ignore",
  });
  child.once("error", () => settle(false));
  child.once("exit", (code) => settle(code === 0));
  return await promise;
}

/**
 * Starts the embedded cluster, creating it on first run.
 *
 * A directory that already holds a `PG_VERSION` is reused rather than
 * re-initialised: `initdb` refuses a populated directory, and throwing away an
 * existing cluster would take the operator's providers and settings with it.
 */
export async function startEmbeddedDatabase(
  options: StartEmbeddedDatabaseOptions,
): Promise<EmbeddedDatabase> {
  const port = options.port ?? EMBEDDED_DATABASE_PORT;
  const databaseDir = resolveEmbeddedDatabaseDir(options.installRoot);

  let EmbeddedPostgres: typeof EmbeddedPostgresClient;
  try {
    ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EmbeddedDatabaseUnavailableError(
      "DATABASE_MODE=embedded needs the `embedded-postgres` package, which is not " +
        `installed here (${reason}). Reinstall the launcher, or set DATABASE_URL to ` +
        "a PostgreSQL server you already run.",
    );
  }

  const binary = await resolvePlatformBinary();
  if (binary === undefined) {
    throw new EmbeddedDatabaseUnavailableError(
      `DATABASE_MODE=embedded has no PostgreSQL binaries for ${process.platform}-${process.arch}. ` +
        "Set DATABASE_URL to a PostgreSQL server instead.",
    );
  }

  const log = options.onLog;
  const server = new EmbeddedPostgres({
    databaseDir,
    user: EMBEDDED_DATABASE_USER,
    password: EMBEDDED_DATABASE_PASSWORD,
    port,
    persistent: true,
    ...(log === undefined ? {} : { onLog: log, onError: (message: unknown) => log(String(message)) }),
  });

  if (!existsSync(join(databaseDir, "PG_VERSION"))) {
    await server.initialise();
  } else if (await stopOrphanCluster(databaseDir)) {
    log?.("[launcher] reaped an embedded PostgreSQL cluster left by a previous run");
  }

  // The hand-off successor reaches this point while the previous launcher is
  // still dying. Two lags bite here, and both read as "the database is
  // unreachable" to the operator when the boot fails on them:
  //
  // 1. The postmaster still holds the port after a `pg_ctl stop` reports
  //    success. Wait for a connect probe to fail before claiming the port.
  // 2. `postmaster.pid` lingers a few seconds after the process exits (Windows
  //    delete lag), and `initdb`-created locks make the next start FATAL on a
  //    file nobody owns. Wait for the file to go; if the wait expires while no
  //    postgres process is alive, the file is a corpse — remove it, which is
  //    exactly what a fresh boot needs.
  if (existsSync(join(databaseDir, "PG_VERSION"))) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await portIsBusy(port))) {
      await Bun.sleep(250);
    }
    const lockFile = join(databaseDir, "postmaster.pid");
    const lockDeadline = Date.now() + 15_000;
    while (Date.now() < lockDeadline && existsSync(lockFile)) {
      await Bun.sleep(250);
    }
    if (existsSync(lockFile)) {
      const postmasters = await listPostgresProcesses();
      if (postmasters.length === 0) {
        rmSync(lockFile, { force: true });
      }
    }
  }

  await server.start();
  try {
    await server.createDatabase(EMBEDDED_DATABASE_NAME);
  } catch {
    // Present on every run after the first.
  }

  const url = embeddedDatabaseUrl(port);
  let stopping: Promise<void> | undefined;
  return {
    url,
    port,
    stop(): Promise<void> {
      stopping ??= server
        .stop()
        // A postmaster already gone is the state this function exists to reach,
        // so an error here is not worth failing a launcher shutdown over.
        .catch(() => undefined);
      return stopping;
    },
  };
}
