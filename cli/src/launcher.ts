import { existsSync } from "node:fs";
import { join } from "node:path";

import { CLI_VERSION } from "./version";
import { ensureGatewayInstalled } from "./bootstrap";
import { createProgressReporter } from "./progress";
import { ControlServer, type ControlHandshake, type UpdateSnapshot } from "./control-server";
import { promptMenu, type MenuAction } from "./menu";
import {
  DEFAULT_PORT,
  consoleUrl,
  ensureStateDirs,
  resolveDevRepoRoot,
  resolveInstallRoot,
  resolveLogFile,
  resolveBinaryName,
  resolveBinaryPath,
} from "./paths";
import { startEmbeddedDatabase } from "./embedded-database";
import type { EmbeddedDatabase } from "./embedded-database";
import { installShutdownHandlers, shutdownSessionFiles } from "./shutdown";
import { GatewaySupervisor, type ServerStatus } from "./supervisor";
import { assertGatewayConfigured, resolveGatewayConfig, writeStarterConfig } from "./install-config";
import { resolveGatewayVersion, runUpdateSequence } from "./update-flow";
import { renderUpdateNotices } from "./update-notice";
import { checkLauncherVersion, updateCheckDisabled } from "../update/npm-source";
import { hideConsoleWindow, isTrayRunning, startTray, stopTray } from "./tray-launcher";
import type { TrayStartResult } from "./tray-launcher";
import { isProcessAlive } from "../tray/connection";

/**
 * Wiring: argv → supervisor → control server → menu → action.
 *
 * This module holds no policy of its own. The decisions live where they are
 * enforced: process lifecycle in `supervisor.ts`, access control in
 * `control-server.ts`, rendering in `menu.ts`.
 */

export interface CliOptions {
  readonly port: number;
  /** Host used in printed and opened URLs; the gateway itself binds all interfaces. */
  readonly host: string;
  readonly noOpen: boolean;
  readonly background: boolean;
  /** Stay resident with the control server up, but print no menu and open nothing. */
  readonly headless: boolean;
  readonly help: boolean;
  readonly version: boolean;
  /** Bare subcommand, when one was given. */
  readonly command: string | undefined;
}

const USAGE = `lianrouter v${CLI_VERSION}

Usage: lianrouter [command] [options]

Commands:
  start            Start the gateway and show the menu
  stop             Stop a running gateway
  status           Print the gateway status and exit
  update           Check for and install an update
  tray             Run the gateway in the background with a tray icon
  tui              Open the terminal UI
  init             Write a starter config file into the install root

Options:
  --port <n>       Gateway port (default ${DEFAULT_PORT}, or $PORT)
  --host <addr>    Host used in URLs (default localhost)
  --no-open        Never open the browser
  --background     Start detached and return
  --headless       Stay resident with the control server up, without a menu
  --version        Print the version and exit
  --help           Print this help and exit

Environment:
  LIANROUTER_HOME  Override the install/state root
  PORT             Default gateway port`;

const KNOWN_COMMANDS: readonly string[] = [
  "start",
  "stop",
  "status",
  "update",
  "tray",
  "tui",
  "init",
];

/**
 * Parses argv. Unknown flags and commands are errors rather than silent
 * no-ops: a typo that quietly starts nothing is worse than a usage line.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  let port: number | undefined;
  let host = "localhost";
  let noOpen = false;
  let background = false;
  let headless = false;
  let help = false;
  let version = false;
  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (arg === "--no-open") {
      noOpen = true;
      continue;
    }
    if (arg === "--background") {
      background = true;
      continue;
    }
    if (arg === "--headless") {
      headless = true;
      continue;
    }
    if (arg === "--port" || arg === "--host") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      if (arg === "--port") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
          throw new Error(`--port must be an integer between 1 and 65535, got "${value}"`);
        }
        port = parsed;
      } else {
        host = value;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    }
    if (command !== undefined) {
      throw new Error(`unexpected argument ${arg}`);
    }
    if (!KNOWN_COMMANDS.includes(arg)) {
      throw new Error(`unknown command ${arg}\n\n${USAGE}`);
    }
    command = arg;
  }

  return {
    port: port ?? readPortEnv(),
    host,
    noOpen,
    background,
    headless,
    help,
    version,
    command,
  };
}

/** `PORT` from the environment, matching the gateway's own default. */
function readPortEnv(): number {
  const raw = process.env["PORT"];
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : DEFAULT_PORT;
}

/** Where this run's gateway comes from. */
interface Runtime {
  readonly installRoot: string;
  readonly cwd: string;
  /** `undefined` means "the compiled binary in the install root". */
  readonly command: readonly string[] | undefined;
  /** Repository root when running from a checkout; undefined for an install. */
  readonly devRepoRoot: string | undefined;
}

/**
 * Chooses what to spawn. From a source checkout the gateway runs through Bun
 * against `src/main.ts`; from an install it is the compiled binary. Getting this
 * wrong is a confusing "file not found" at the first start, so the decision is
 * made once, here.
 *
 * The root is re-checked for `src/app.ts` before the Bun command is chosen. A
 * root that is not a gateway tree must degrade to "no gateway binary here" — an
 * install that cannot start and says so — rather than spawning whatever entry
 * happens to live there as the supervised child.
 */
function resolveRuntime(): Runtime {
  const repoRoot = resolveDevRepoRoot();
  if (repoRoot !== undefined && existsSync(join(repoRoot, "src", "app.ts"))) {
    return {
      installRoot: resolveInstallRoot(),
      cwd: repoRoot,
      command: [process.execPath, "run", `${repoRoot}/src/main.ts`],
      devRepoRoot: repoRoot,
    };
  }
  const installRoot = resolveInstallRoot();
  return { installRoot, cwd: installRoot, command: undefined, devRepoRoot: undefined };
}

/**
 * Installs the gateway on first run, before any supervisor exists.
 *
 * The supervisor's fallback command is `<installRoot>/lianrouter.exe`, so a
 * published package on a clean machine would otherwise fail at `uv_spawn` with
 * `ENOENT`. The binary's absence is checked here rather than inside the
 * bootstrap because the path is what the operator needs printed: a first run
 * that silently downloads ~50 MB and then opens a browser leaves them with no
 * idea where the install went.
 */
async function ensureInstalledGateway(installRoot: string): Promise<void> {
  const present = existsSync(resolveBinaryPath(installRoot));
  if (present) {
    // Hot path: no reporter, no source, no output. Every later run lands here.
    await ensureGatewayInstalled({ installRoot, currentVersion: CLI_VERSION });
    return;
  }
  const reporter = createProgressReporter({
    write: (chunk) => {
      process.stdout.write(chunk);
    },
    isTTY: process.stdout.isTTY === true,
  });
  try {
    const result = await ensureGatewayInstalled({
      installRoot,
      currentVersion: CLI_VERSION,
      onProgress: reporter.update,
    });
    // Close the in-place line first: on a TTY the cursor is still mid-row and
    // the success message would otherwise be appended to a stale percentage.
    reporter.finish();
    console.log(`Gateway ${result.version} installed at ${result.binaryPath}`);
  } finally {
    // Idempotent, and it also covers the failure path, where the thrown message
    // follows immediately.
    reporter.finish();
  }
}

export async function run(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.version) {
    console.log(CLI_VERSION);
    return 0;
  }

  const runtime = resolveRuntime();
  if (options.command === "init") {
    // No install and no gateway: the point of this command is to make the
    // first start possible, so it must work on a root with nothing in it — and
    // on a root whose file was written by an older launcher, which is the case
    // that made this command look broken. `writeStarterConfig` reports which of
    // the two it did so the message can stop claiming a fresh write.
    const config = writeStarterConfig(runtime.installRoot);
    console.log(
      config.kind === "created" ? `Wrote ${config.path}` : `Updated ${config.path} (previous file kept beside it)`,
    );
    console.log(
      "It starts a private PostgreSQL for this install (DATABASE_MODE=embedded) and an " +
        "in-process Redis, so `lianrouter` works as-is. Point DATABASE_URL at your own " +
        "server instead if you prefer.",
    );
    return 0;
  }

  // A checkout lets Bun load the repository's `.env` for the gateway child; an
  // install has no such file in its working directory, so the launcher supplies
  // one. The check runs before anything is installed or spawned: a ~50 MB
  // download followed by a 30-second health wait is a bad way to learn that two
  // variables were never set.
  //
  // Only commands that start the gateway are checked. `update` must be able to
  // replace a binary on a machine that was never configured, and `status`/`stop`
  // answer a question about the current machine.
  const startsGateway =
    options.command === undefined ||
    options.command === "start" ||
    options.command === "tray" ||
    options.command === "tui";
  //
  // A start also repairs: an install that cannot boot is exactly the state this
  // check exists to catch, and refusing to start is not a better answer than
  // making it start. `writeStarterConfig` migrates a file written by an older
  // launcher — the released `2.3.3` wrote a config whose database line was a
  // comment, so `init` and the run then disagreed forever — and never replaces
  // an operator's own connection string. That is why the file is corrected
  // before the assertion instead of the assertion being relaxed.
  let gatewayConfig =
    runtime.command === undefined && startsGateway
      ? resolveGatewayConfig(runtime.installRoot)
      : undefined;
  if (gatewayConfig !== undefined && gatewayConfig.missing.length > 0) {
    const prepared = writeStarterConfig(runtime.installRoot);
    if (prepared.kind !== "unchanged") {
      console.log(
        prepared.kind === "created"
          ? `Wrote ${prepared.path}`
          : `Updated ${prepared.path} so the gateway can start (previous file kept beside it)`,
      );
    }
    gatewayConfig = resolveGatewayConfig(runtime.installRoot);
  }
  if (gatewayConfig !== undefined) {
    assertGatewayConfigured(gatewayConfig);
  }

  // `DATABASE_MODE=embedded` means this process owns the database too, not just
  // the gateway: the cluster it starts is a child of this launcher, so the
  // connection string only exists while the launcher does. Started before the
  // supervisor so the child inherits a URL that already answers.
  const embeddedDatabase =
    gatewayConfig?.databaseMode === "embedded" && startsGateway
      ? await startEmbeddedDatabase({ installRoot: runtime.installRoot })
      : undefined;
  // `--background` unrefs the gateway child and returns, which is the shape a
  // launcher that supervises a pre-existing database can offer. It cannot offer
  // it here: the embedded cluster is a child of this process, so returning would
  // take the database down with the launcher and leave a gateway that cannot
  // reach its own `DATABASE_URL`. Refusing says that plainly instead of letting
  // the first `/health` fail with `ECONNREFUSED`.
  if (embeddedDatabase !== undefined && options.background) {
    await embeddedDatabase.stop();
    throw new Error(
      "DATABASE_MODE=embedded keeps PostgreSQL inside this process, so --background " +
        "cannot return and leave it running. Use `lianrouter tray` for a background " +
        "install with an icon, or set DATABASE_URL to a server that outlives the launcher.",
    );
  }

  // Commands that answer a question must not install anything: `status` and
  // `stop` on a machine that never ran the gateway have to report that fact
  // offline, not reach for the release feed.
  if (runtime.command === undefined && options.command !== "status" && options.command !== "stop") {
    await ensureInstalledGateway(runtime.installRoot);
  }

  const supervisor = new GatewaySupervisor({
    port: options.port,
    installRoot: runtime.installRoot,
    logFile: resolveLogFile(runtime.installRoot),
    cwd: runtime.cwd,
    // The console reaches the update flow through the launcher's control plane,
    // and the launcher is the only process allowed to install. The child needs
    // the install root to find `run/control.json`; without it the console has no
    // launcher to talk to and reports updates as unavailable.
    env: {
      LIANROUTER_LAUNCHER_HOME: runtime.installRoot,
      ...(gatewayConfig?.env ?? {}),
      // Last so a cluster this launcher started wins over a stale value in the
      // file: the URL it names is the only one that answers.
      ...(embeddedDatabase === undefined ? {} : { DATABASE_URL: embeddedDatabase.url }),
    },
    ...(runtime.command === undefined ? {} : { command: runtime.command }),
  });

  switch (options.command) {
    case "status":
      return await printStatus(supervisor);
    case "stop":
      return await stopServer(supervisor, runtime.installRoot);
    case "start":
      return await withShutdownHandlers(
        supervisor,
        runtime,
        () => runInteractive(supervisor, options, runtime),
        embeddedDatabase,
      );
    case "tray":
      return await withShutdownHandlers(
        supervisor,
        runtime,
        () => enterTrayMode(supervisor, options, runtime),
        embeddedDatabase,
      );
    case "tui":
      return await withShutdownHandlers(
        supervisor,
        runtime,
        () => runTui(supervisor, options, runtime),
        embeddedDatabase,
      );
    case "update":
      return await runUpdateFlow(supervisor, runtime);
    case undefined:
      return await withShutdownHandlers(
        supervisor,
        runtime,
        () => runInteractive(supervisor, options, runtime),
        embeddedDatabase,
      );
    default:
      // `parseArgs` rejects anything outside KNOWN_COMMANDS, so no argv reaches
      // this arm; it exists because `command` is a plain `string | undefined`.
      throw new Error(`unknown command ${options.command}`);
  }
}

/**
 * The control server of the session currently running, if any.
 *
 * Signal handlers are process-scoped while sessions are command-scoped, so the
 * handler needs a way to reach the server the active command created. A
 * module-level holder is the honest shape for that: there is exactly one
 * session per process, and it is set in `openSession` and cleared when the
 * session shuts down.
 */
let activeControl: ControlServer | undefined;

/**
 * Runs a command with `SIGINT`/`SIGTERM` wired to a graceful shutdown.
 *
 * The stop calls are the same ones the menu's Exit uses, so the post-condition
 * is identical: the gateway child is terminated, the control server closes and
 * removes `run/control.json`, and `run/lianrouter.pid` is gone. Without this, a
 * killed launcher leaves both files naming a dead pid and the next tray reads
 * them.
 *
 * `status` and `stop` are excluded because they own no session: there is
 * nothing to tear down beyond what they already dispose themselves.
 */
async function withShutdownHandlers(
  supervisor: GatewaySupervisor,
  runtime: Runtime,
  command: () => Promise<number>,
  embeddedDatabase?: EmbeddedDatabase,
): Promise<number> {
  const registration = installShutdownHandlers(
    () =>
      shutdownSessionFiles({
        installRoot: runtime.installRoot,
        stopControl: async () => {
          const control = activeControl;
          activeControl = undefined;
          await control?.stop();
        },
        stopGateway: async () => {
          await supervisor.stop();
          await supervisor.dispose();
          // After the gateway: the child is the only reader of this cluster, so
          // stopping the postmaster first would make every in-flight pool
          // checkout fail during a shutdown the operator did not ask to be loud.
          await embeddedDatabase?.stop();
        },
      }),
    (code) => process.exit(code),
  );
  try {
    return await command();
  } finally {
    registration.dispose();
  }
}

async function printStatus(supervisor: GatewaySupervisor): Promise<number> {
  const adopted = await supervisor.adoptExisting();
  if (!adopted) {
    console.log("LianRouter is not running.");
    console.log(`  port:   ${supervisor.status.port}`);
    console.log(`  binary: ${resolveBinaryName()}`);
    await supervisor.dispose();
    return 0;
  }
  const status = supervisor.status;
  console.log(`LianRouter is running (pid ${status.pid ?? "unknown"}).`);
  console.log(`  url:   ${status.url}`);
  console.log(`  port:  ${status.port}`);
  await supervisor.dispose();
  return 0;
}

async function stopServer(supervisor: GatewaySupervisor, installRoot: string): Promise<number> {
  // The tray first, and for a reason that is not obvious from the call: a live
  // tray watches the control port, and a control port that disappears is its
  // resurrection trigger. Stopping the gateway alone therefore reported
  // "LianRouter stopped" and then had the tray start it right back up — the
  // operator's stop was undone by the icon they forgot was still there.
  // Stopping the tray first removes the watcher, so the gate the operator asked
  // for actually holds.
  const trayWasRunning = await isTrayRunning(installRoot);
  if (trayWasRunning) {
    await stopTray(installRoot);
  }

  const adopted = await supervisor.adoptExisting();
  if (!adopted) {
    console.log("LianRouter is not running.");
    return 0;
  }
  const status = await supervisor.stop();
  console.log(
    status.state === "stopped"
      ? `LianRouter stopped${trayWasRunning ? " (tray closed)" : ""}.`
      : `Stop failed: ${status.lastError ?? status.state}`,
  );
  await supervisor.dispose();
  return 0;
}

/** The supervisor plus the control server wrapped around it. */
interface Session {
  readonly supervisor: GatewaySupervisor;
  readonly control: ControlServer;
  readonly handshake: ControlHandshake;
  readonly installRoot: string;
}

/**
 * Starts the control server around a supervisor with the update hooks wired.
 *
 * `./update/engine` is imported dynamically because another tree owns that file
 * and it does not exist in every build; a static import would make the whole
 * launcher fail to compile against an install that omitted it.
 */
async function openSession(
  supervisor: GatewaySupervisor,
  runtime: Runtime,
  host: string,
  /** Fire one release check at boot; the interactive menu checks for itself. */
  bootCheck: boolean,
): Promise<Session> {
  ensureStateDirs(runtime.installRoot);
  const control: ControlServer = new ControlServer({
    installRoot: runtime.installRoot,
    supervisor,
    consoleUrl: consoleUrl(supervisor.status.port, host),
    onShutdown: () => {
      void shutdownAndExit(supervisor, control);
    },
    onTrayHide: () => {
      // Hiding the console without stopping the host would leave a tray icon
      // with no window behind it and no way to bring the CLI back.
      hideConsoleWindow();
      void stopTray(runtime.installRoot);
    },
    onCheckUpdate: () => checkUpdateNow(runtime.installRoot),
    startUpdate: async () => {
      control.setUpdateRunning(true);
      try {
        const engine = await import("../update/engine");
        await runUpdateSequence({
          launcherVersion: CLI_VERSION,
          installRoot: runtime.installRoot,
          checkForUpdate: (options) => engine.checkForUpdate(options),
          runUpdate: (options) => engine.runUpdate(options),
          stopGateway: async () => {
            await supervisor.stop();
          },
          startGateway: async () => {
            await supervisor.start();
          },
          publish: (snapshot) => control.publishUpdate(snapshot),
          publishProgress: (progress) => control.publishProgress(progress),
        });
      } finally {
        control.setUpdateRunning(false);
      }
    },
  });
  const handshake = await control.start();
  activeControl = control;
  if (bootCheck && !updateCheckDisabled()) {
    // Deliberately not awaited. The console's first paint must not wait on a
    // release feed: a slow or unreachable network would hold the control
    // handshake open and the operator would see a dead tray. The check
    // publishes when it lands, and a failure publishes nothing — the snapshot
    // stays null and "Check again" is the recovery path.
    void control.checkUpdate().catch(() => undefined);
  }
  return { supervisor, control, handshake, installRoot: runtime.installRoot };
}

/** Starts the gateway if needed and opens the console. */
async function openWeb(supervisor: GatewaySupervisor, options: CliOptions): Promise<void> {
  await ensureStarted(supervisor);
  const url = consoleUrl(supervisor.status.port, options.host);
  if (!options.noOpen) {
    openBrowser(url);
  }
  console.log(`Console: ${url}`);
}

function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  try {
    const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    void child.exited;
  } catch {
    console.log(`Could not open a browser; visit ${url}`);
  }
}

/**
 * Brings the gateway up when it is not already serving. Adoption is tried
 * first so a second `lianrouter` from another terminal never races the port.
 */
async function ensureStarted(supervisor: GatewaySupervisor): Promise<ServerStatus> {
  if (await supervisor.adoptExisting()) {
    return supervisor.status;
  }
  const status = await supervisor.start();
  if (status.state === "crashed") {
    throw new Error(status.lastError ?? "gateway failed to start");
  }
  if (!(await supervisor.waitForHealthy())) {
    // A health timeout on its own says nothing: a missing DATABASE_URL, a
    // missing migrations folder, and a refused Postgres all look the same from
    // outside. The child already wrote the reason, so name it instead of leaving
    // the operator to find the log.
    const cause = await supervisor.describeFailure();
    throw new Error(`gateway did not answer /health on port ${status.port}\n${cause}`);
  }
  return supervisor.status;
}

/** Menu-driven path: the default `lianrouter` invocation. */
async function runInteractive(
  supervisor: GatewaySupervisor,
  options: CliOptions,
  runtime: Runtime,
): Promise<number> {
  // One authority decides whether startup talks to the network at all: the
  // registry check and the release-feed check are skipped together, so a
  // disabled environment cannot half-report.
  const checkDisabled = updateCheckDisabled();
  // `--background` and `--headless` print no notice because no menu follows
  // them: the tray spawns `--headless` to resurrect a launcher, and that spawn
  // must not sit on a registry deadline before it can hand over the control
  // port. Skipping the request is the only way to guarantee that.
  const noticesApply = !options.background && !options.headless;
  // The registry check is started before the gateway boot and awaited after it,
  // so its deadline overlaps the seconds the boot already costs instead of
  // being added to them. `.catch` is belt and braces: the source already
  // returns `unavailable` rather than throwing, and a notice must never be the
  // reason a start fails.
  const launcherCheck =
    checkDisabled || !noticesApply
      ? undefined
      : checkLauncherVersion({ currentVersion: CLI_VERSION }).catch(() => undefined);

  await ensureStarted(supervisor);

  const launcher = await launcherCheck;
  const launcherNotice =
    launcher?.status === "outdated"
      ? { launcher: { current: launcher.current, latest: launcher.latest } }
      : {};

  const session = await openSession(supervisor, runtime, options.host, options.headless);
  if (options.background) {
    supervisor.detach();
    await session.control.stop();
    console.log(
      `LianRouter running at ${supervisor.status.url} (pid ${supervisor.status.pid ?? "?"})`,
    );
    return 0;
  }

  if (options.headless) {
    // Stay resident with the control server up and no menu. This is what the
    // tray spawns when it has to resurrect a launcher: the tray needs a control
    // port to talk to, so `--background` (which stops the server and returns)
    // is the wrong shape. The gateway is already started or adopted above.
    return await blockUntilTrayExit(supervisor, session, runtime);
  }

  const update = checkDisabled ? null : await readUpdateInfo(runtime.installRoot).catch(() => null);
  // The interactive path already paid for this check; handing the result to the
  // control server means the console's badge agrees with the menu row instead
  // of waiting for its own boot check (which this path skips).
  if (update !== null) {
    session.control.publishUpdate(update);
  }
  // Printed after the gateway answered and before the menu, so an invocation
  // that goes on to open the menu first states what is out of date. The notice
  // and the menu row are different surfaces on purpose: the line is the
  // notification, the row is the action.
  for (const line of renderUpdateNotices({
    ...launcherNotice,
    ...(update !== null && update.available
      ? { gateway: { current: update.current, latest: update.latest } }
      : {}),
  })) {
    console.log(line);
  }

  const action = await promptMenu({
    version: CLI_VERSION,
    port: supervisor.status.port,
    // `current` is the gateway's recorded version, not `CLI_VERSION`: the row
    // offers a gateway archive, so it must name the gateway that is installed.
    update:
      update !== null && update.available
        ? { latest: update.latest, current: update.current }
        : undefined,
  });

  return await dispatch(action, supervisor, session, options, runtime);
}

async function dispatch(
  action: MenuAction,
  supervisor: GatewaySupervisor,
  session: Session,
  options: CliOptions,
  runtime: Runtime,
): Promise<number> {
  switch (action) {
    case "web":
      await openWeb(supervisor, options);
      await shutdownSession(session, supervisor);
      return 0;
    case "tui": {
      await launchTui(supervisor, session);
      await shutdownSession(session, supervisor);
      return 0;
    }
    case "tray": {
      const started = await startTrayHost(supervisor, session, runtime);
      if (!started.ok) {
        console.error(started.error);
        await shutdownSession(session, supervisor);
        return 1;
      }
      return await blockUntilTrayExit(supervisor, session, runtime);
    }
    case "update": {
      await runUpdateWithProgress(supervisor, session, runtime);
      return 0;
    }
    case "exit":
      return await exitSession(supervisor, session, runtime);
  }
}

/**
 * `./tui/app` belongs to another tree and may be absent from a given build, so
 * the import is dynamic; a static one would break compilation of this module.
 */
async function launchTui(supervisor: GatewaySupervisor, session: Session): Promise<void> {
  const mod = await import("../tui/app");
  await mod.default({
    port: supervisor.status.port,
    controlUrl: `http://127.0.0.1:${session.control.port}`,
    controlToken: session.control.controlToken,
    version: CLI_VERSION,
    logFile: resolveLogFile(session.installRoot),
  });
}

async function runUpdateWithProgress(
  supervisor: GatewaySupervisor,
  session: Session,
  runtime: Runtime,
): Promise<void> {
  // Same reason as `launchTui`: the update engine is a separate, optionally
  // present tree.
  const engine = await import("../update/engine");
  session.control.setUpdateRunning(true);
  try {
    await runUpdateSequence({
      launcherVersion: CLI_VERSION,
      installRoot: runtime.installRoot,
      checkForUpdate: (options) => engine.checkForUpdate(options),
      runUpdate: (options) => engine.runUpdate(options),
      stopGateway: async () => {
        await supervisor.stop();
      },
      startGateway: async () => {
        await supervisor.start();
      },
      publish: (snapshot) => {
        session.control.publishUpdate(snapshot);
        console.log(
          snapshot.available
            ? `Updating ${snapshot.current} → ${snapshot.latest}`
            : `LianRouter ${snapshot.current} is up to date.`,
        );
      },
      publishProgress: (progress) => {
        session.control.publishProgress(progress);
        console.log(
          `  [${progress.percent.toString().padStart(3)}%] ${progress.phase}: ${progress.message}`,
        );
      },
    });
  } finally {
    // The menu flow has no `/update/start` acceptor to clear the flag, so it
    // owns both ends: a console polling `GET /update` must stop reading
    // "running" once the install settles.
    session.control.setUpdateRunning(false);
  }
}

/**
 * Starts the tray host and hides the console.
 *
 * Returns the spawn outcome instead of swallowing it: the caller must not hide
 * the console or block on a pid file that was never written, because that is a
 * silent hang with no icon and no way to reach the gateway.
 *
 * A successful spawn is not a successful tray. `startTray` only reports that a
 * process was created; the host can still die a moment later — a dead or
 * unreadable handshake, a pid file naming a live rival, or a failed pump — and
 * that failure happens *after* the console would have been hidden. The operator
 * then sees a window that vanished and no icon to bring it back, which is
 * indistinguishable from a crash. So the console is hidden only once the tray
 * has survived its own startup, and a tray that dies in that window is reported
 * as the failure it is.
 */
async function startTrayHost(
  supervisor: GatewaySupervisor,
  session: Session,
  runtime: Runtime,
): Promise<TrayStartResult> {
  await ensureStarted(supervisor);
  const result = await startTray(
    runtime.devRepoRoot === undefined
      ? { installRoot: runtime.installRoot, control: session.handshake }
      : { installRoot: runtime.installRoot, control: session.handshake, devRepoRoot: runtime.devRepoRoot },
  );
  if (!result.ok) {
    return result;
  }
  if (!(await traySurvivedStartup(result.pid))) {
    return {
      ok: false,
      error:
        "The tray host exited while starting, so the console was left visible. " +
        "Run `lianrouter tray` from a terminal to see why.",
    };
  }
  hideConsoleWindow();
  return result;
}

/** How long a spawned tray must stay alive before the console is hidden. */
export const TRAY_STARTUP_GRACE_MS = 3_000;
/** Poll interval inside the grace window. */
const TRAY_STARTUP_POLL_MS = 150;

/**
 * True when the tray process is still alive after its startup window.
 *
 * Polls rather than sleeps once, so a tray that dies fast is caught fast: the
 * common failure (bad handshake, rival pid) exits in well under a second, and
 * waiting the full grace period before reporting it would just delay the same
 * message.
 *
 * Exported, and with an injectable window, because the decision it makes is the
 * one that used to be missing: `startTray` reports a *spawn*, and a test that
 * cannot call this cannot tell "the tray is up" from "the tray was created".
 */
export async function traySurvivedStartup(
  pid: number,
  graceMs: number = TRAY_STARTUP_GRACE_MS,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return false;
    }
    await Bun.sleep(TRAY_STARTUP_POLL_MS);
  }
  return isProcessAlive(pid);
}

/**
 * Blocks until the tray host is gone or the gateway dies.
 *
 * The control server lives in this process, so exiting here would orphan the
 * tray's only command channel; hiding the console is the point, not quitting.
 */
async function blockUntilTrayExit(
  supervisor: GatewaySupervisor,
  session: Session,
  runtime: Runtime,
): Promise<number> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poll);
      unsubscribe();
      resolve();
    };
    const unsubscribe = supervisor.subscribe((status) => {
      if (status.state === "crashed") {
        finish();
      }
    });
    const poll = setInterval(() => {
      void isTrayRunning(runtime.installRoot).then((running) => {
        if (!running) {
          finish();
        }
      });
    }, 2_000);
    poll.unref();
  });
  await shutdownSession(session, supervisor);
  return 0;
}

/** Exit: keep the gateway alive when the tray owns it, otherwise stop it. */
async function exitSession(
  supervisor: GatewaySupervisor,
  session: Session,
  runtime: Runtime,
): Promise<number> {
  if (await isTrayRunning(runtime.installRoot)) {
    // "Exit" from the menu means the launcher goes away and the tray keeps
    // serving — that is the whole point of the tray. The gateway therefore has
    // to be detached rather than stopped, or exiting the menu would take the
    // gateway with it and leave a tray with nothing behind it.
    supervisor.detach();
    console.log(`Gateway left running at ${supervisor.status.url}.`);
  } else {
    await supervisor.stop();
  }
  await session.control.stop();
  await supervisor.dispose();
  return 0;
}

async function shutdownSession(session: Session, supervisor: GatewaySupervisor): Promise<void> {
  activeControl = undefined;
  await session.control.stop();
  await supervisor.dispose();
}

/** Control-server-initiated shutdown. */
async function shutdownAndExit(supervisor: GatewaySupervisor, control: ControlServer): Promise<void> {
  await control.stop();
  await supervisor.stop();
  await supervisor.dispose();
  process.exit(0);
}

async function enterTrayMode(
  supervisor: GatewaySupervisor,
  options: CliOptions,
  runtime: Runtime,
): Promise<number> {
  await ensureStarted(supervisor);
  const session = await openSession(supervisor, runtime, options.host, true);
  const started = await startTrayHost(supervisor, session, runtime);
  if (!started.ok) {
    console.error(started.error);
    await shutdownSession(session, supervisor);
    return 1;
  }
  // Hand the gateway to the tray before blocking. From this point the tray is
  // the thing that owns the session, so the launcher must stop treating itself
  // as the owner: `detach()` sets the flag the exit hook reads, and without it a
  // launcher that ends for *any* reason — a closed console window, a lost
  // terminal, a crash — kills the gateway on its way out and the operator sees
  // "hiding it stopped everything". The control server keeps running so the tray
  // still has its command channel; only the child's lifetime changes hands.
  supervisor.detach();
  if (options.noOpen) {
    console.log(`Tray host started; control port ${session.control.port}`);
  }
  return await blockUntilTrayExit(supervisor, session, runtime);
}

async function runTui(
  supervisor: GatewaySupervisor,
  options: CliOptions,
  runtime: Runtime,
): Promise<number> {
  await ensureStarted(supervisor);
  // The TUI's banner reads `update` off `/status`, so it has the same gap the
  // tray had: nothing would ever fill the snapshot. Same single boot check.
  const session = await openSession(supervisor, runtime, options.host, true);
  await launchTui(supervisor, session);
  await shutdownSession(session, supervisor);
  return 0;
}

async function runUpdateFlow(supervisor: GatewaySupervisor, runtime: Runtime): Promise<number> {
  const engine = await import("../update/engine");
  // Adopt first so a gateway started by an earlier launcher is stopped at the
  // install boundary rather than left holding the executable open; the install
  // would fail on Windows with a rename error otherwise. `wasRunning` decides
  // whether the new binary is left serving after this command exits —
  // `lianrouter update` is not a supervisor, so it must not start a gateway
  // nobody asked for.
  const wasRunning = await supervisor.adoptExisting();
  try {
    await runUpdateSequence({
      launcherVersion: CLI_VERSION,
      installRoot: runtime.installRoot,
      checkForUpdate: (options) => engine.checkForUpdate(options),
      runUpdate: (options) => engine.runUpdate(options),
      stopGateway: async () => {
        await supervisor.stop();
      },
      startGateway: async () => {
        // A one-shot `lianrouter update` must not leave a gateway running that
        // nobody started: only a gateway that was already serving comes back.
        if (wasRunning) {
          await supervisor.start();
        }
      },
      publish: (snapshot) => {
        console.log(
          snapshot.available
            ? `Updating ${snapshot.current} → ${snapshot.latest}`
            : `LianRouter ${snapshot.current} is up to date.`,
        );
      },
      publishProgress: (progress) => {
        console.log(
          `  [${progress.percent.toString().padStart(3)}%] ${progress.phase}: ${progress.message}`,
        );
      },
    });
  } finally {
    if (wasRunning && supervisor.status.state === "running") {
      // Hand the child to the OS: the exit hook would otherwise kill a gateway
      // the operator expects to keep serving.
      supervisor.detach();
    }
    await supervisor.dispose();
  }
  console.log("Update complete.");
  return 0;
}

/**
 * Runs the release check, throwing when it cannot run.
 *
 * This is the single engine call site: the menu, the boot hook, and
 * `POST /update/check` all reach the feed through here, so the version they
 * compare against can never drift apart.
 *
 * `./update/engine` is imported dynamically because another tree owns that file
 * and it does not exist in every build; a static import would make the whole
 * launcher fail to compile against an install that omitted it. A missing module
 * rejects with that import error rather than an invented "no update", because
 * "this build cannot check" is a failure the console must report, not a fact
 * about the installed release.
 */
async function checkUpdateNow(installRoot: string): Promise<UpdateSnapshot> {
  const engine = await import("../update/engine");
  const info = await engine.checkForUpdate({
    currentVersion: await resolveGatewayVersion(installRoot, CLI_VERSION),
  });
  return { current: info.current, latest: info.latest, available: info.available };
}

/**
 * Reads the update snapshot without failing the launcher when the update
 * module is absent (an isolated build, or a stripped install). A missing module
 * means "no update known", which is exactly the menu's no-row case.
 *
 * Only the menu's notice and row want that degraded shape — they must render
 * either way. The control plane calls {@link checkUpdateNow} directly so a
 * failed check reaches the console as an error instead of a silent null.
 */
async function readUpdateInfo(installRoot: string): Promise<UpdateSnapshot | null> {
  try {
    return await checkUpdateNow(installRoot);
  } catch {
    return null;
  }
}
