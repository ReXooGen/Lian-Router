import { createWriteStream, type WriteStream } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { Subprocess } from "bun";
import {
  ensureStateDirs,
  healthUrl,
  resolveBinaryPath,
  resolvePidFile,
} from "./paths";

/**
 * Owns the gateway child process for the lifetime of one CLI invocation.
 *
 * The invariants that matter, and why each one exists:
 *
 * - **One gateway per install root.** The pid file is the lock. A second
 *   `lianrouter` started from another terminal adopts the running child
 *   instead of binding the same port and failing with `EADDRINUSE`.
 * - **No silent respawn loops.** A crash restarts at most three times inside a
 *   rolling minute, backing off 500ms → 1s → 2s. Past that the state is
 *   `crashed` and the operator is told, rather than the launcher burning CPU on
 *   a binary that cannot start.
 * - **A deliberate stop never looks like a crash.** `stop()` sets a flag before
 *   signalling, so the exit handler does not schedule a restart.
 * - **No orphans.** The process exit hook kills the child synchronously; a CLI
 *   that dies must not leave a gateway holding the port with nobody watching.
 */

export type SupervisorState = "stopped" | "starting" | "running" | "stopping" | "crashed";

export interface ServerStatus {
  readonly state: SupervisorState;
  readonly port: number;
  readonly pid: number | undefined;
  readonly startedAt: number | undefined;
  readonly lastExitCode: number | undefined;
  readonly lastError: string | undefined;
  readonly url: string;
}

export interface SupervisorOptions {
  readonly port: number;
  readonly installRoot: string;
  readonly logFile: string;
  readonly cwd: string;
  /** Extra env merged over process.env for the child. */
  readonly env?: Readonly<Record<string, string>>;
  /** Command + args; defaults to the compiled binary in installRoot. */
  readonly command?: readonly string[];
  readonly onLogLine?: (line: string) => void;
}

/** Restart budget: attempts allowed inside the rolling window. */
const RESTART_MAX_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 60_000;
const RESTART_BASE_DELAY_MS = 500;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 150;

/**
 * Accumulates decoded chunks into whole lines. Child output arrives in
 * arbitrary boundaries, and a half-line forwarded to the log file would make
 * the log unreadable exactly when it matters.
 */
class LineSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r?\n/);
    const tail = parts.pop() ?? "";
    this.buffer = tail;
    return parts.filter((line) => line.length > 0);
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.length > 0 ? [rest] : [];
  }
}

/** True when the pid is alive and visible to this user. */
function isProcessAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** How many trailing log lines a failure report will scan when nothing was captured live. */
const FAILURE_TAIL_LINES = 40;

/**
 * Extracts the child's own fatal message from one log line.
 *
 * Three shapes reach this log, and all three matter:
 *
 * - **pino JSON** — the compiled binary runs with `NODE_ENV=production`, so its
 *   own `log.error(...)` calls are `{"level":"error","msg":"..."}`.
 * - **pino-pretty** — a development run prints `[12:00:00.000] ERROR: ...`.
 * - **Bun's uncaught-error handler** — a boot failure that escapes the logger
 *   (`DATABASE_URL is required ...`, `Migrations folder not found`) is printed by
 *   the runtime as `error: <message>` followed by a stack.
 *
 * Only the message is returned, never the stack: the launcher prints one line and
 * a stack would read as a launcher bug.
 */
function fatalMessageOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const { level, msg } = parsed as { readonly level?: unknown; readonly msg?: unknown };
    if (typeof level !== "string") {
      return undefined;
    }
    const normalized = level.toLowerCase();
    if (normalized !== "error" && normalized !== "fatal") {
      return undefined;
    }
    return typeof msg === "string" && msg.length > 0 ? msg : trimmed;
  }
  const match = /^(?:\[[^\]]*\]\s*)?(error|fatal)\s*:?\s+(.+)$/i.exec(trimmed);
  return match?.[2];
}

export class GatewaySupervisor {
  private readonly options: SupervisorOptions;
  private readonly listeners = new Set<(status: ServerStatus) => void>();
  private readonly restartHistory: number[] = [];

  private state: SupervisorState = "stopped";
  private child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  private childPid: number | undefined;
  private startedAt: number | undefined;
  private lastExitCode: number | undefined;
  private lastError: string | undefined;
  /**
   * Last fatal line the child printed. Kept live as well as in the log file:
   * a failure can be diagnosed before the log write is flushed.
   */
  private lastFatalLine: string | undefined;
  /** Set by `stop()` so the exit handler does not treat it as a crash. */
  private deliberateStop = false;
  /** Set by `detach()`: the child outlives this CLI on purpose. */
  private detached = false;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingStart: Promise<ServerStatus> | undefined;
  private logStream: WriteStream | undefined;
  private exitHookInstalled = false;

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  get status(): ServerStatus {
    return {
      state: this.state,
      port: this.options.port,
      pid: this.childPid,
      startedAt: this.startedAt,
      lastExitCode: this.lastExitCode,
      lastError: this.lastError,
      url: `http://localhost:${this.options.port}`,
    };
  }

  /**
   * Spawns the child. Idempotent: a second call while starting or running
   * returns the live status rather than creating a competing gateway.
   */
  async start(): Promise<ServerStatus> {
    if (this.state === "running" || this.state === "starting") {
      return this.status;
    }
    if (this.pendingStart !== undefined) {
      return await this.pendingStart;
    }
    this.pendingStart = this.spawnChild();
    try {
      return await this.pendingStart;
    } finally {
      this.pendingStart = undefined;
    }
  }

  /**
   * Graceful stop: signal, wait, then force. Resolves with the final status
   * even when the child ignored the first signal.
   */
  async stop(timeoutMs: number = DEFAULT_STOP_TIMEOUT_MS): Promise<ServerStatus> {
    this.clearRestartTimer();
    this.deliberateStop = true;

    const pid = this.childPid;
    if (pid === undefined) {
      this.state = "stopped";
      this.childPid = undefined;
      this.startedAt = undefined;
      this.emit();
      return this.status;
    }

    this.state = "stopping";
    this.emit();

    await this.terminate(pid, timeoutMs);

    this.child = undefined;
    this.childPid = undefined;
    this.startedAt = undefined;
    this.state = "stopped";
    this.emit();
    await this.removePidFile();
    this.closeLogStream();
    return this.status;
  }

  /** `stop()` then `start()`; the update flow's restart hook. */
  async restart(): Promise<ServerStatus> {
    await this.stop();
    this.restartHistory.length = 0;
    this.deliberateStop = false;
    return await this.start();
  }

  /**
   * Polls `/health` until it answers 200. A crashed or stopped child ends the
   * wait early — polling a port nobody owns for the full timeout only makes
   * the failure feel slower.
   */
  async waitForHealthy(timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const url = healthUrl(this.options.port);
    while (Date.now() < deadline) {
      if (this.state === "crashed" || this.state === "stopped") {
        return false;
      }
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(1_000),
          headers: { accept: "application/json" },
        });
        if (response.status === 200) {
          await response.body?.cancel();
          return true;
        }
        await response.body?.cancel();
      } catch {
        // Connection refused while the listener binds is the expected state;
        // keep polling until the deadline.
      }
      await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
    }
    return false;
  }

  /**
   * Explains why the gateway is not answering.
   *
   * A health timeout says nothing about the cause: the child can be missing
   * `DATABASE_URL`, unable to find `migrations/`, or refused by Postgres, and all
   * three look identical from outside. The child writes its own fatal line before
   * dying, so this returns that line when one was seen (live, or in the log tail)
   * and otherwise names the log path. It never invents a cause.
   */
  async describeFailure(): Promise<string> {
    if (this.lastFatalLine !== undefined) {
      return `The gateway logged: ${this.lastFatalLine}`;
    }
    let tail: string;
    try {
      tail = await readFile(this.options.logFile, "utf8");
    } catch {
      return `No gateway log was written; expected it at ${this.options.logFile}`;
    }
    const lines = tail.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines.slice(-FAILURE_TAIL_LINES).reverse()) {
      const message = fatalMessageOf(line);
      if (message !== undefined) {
        return `The gateway logged: ${message}`;
      }
    }
    return `The gateway log is at ${this.options.logFile}`;
  }

  /** Registers a status listener; the returned function unsubscribes. */
  subscribe(listener: (status: ServerStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Takes over a gateway left running by a previous CLI process.
   *
   * Without this, the tray/menu path would spawn a second child that dies on
   * the port bind and then look like a crash loop to the operator.
   */
  async adoptExisting(): Promise<boolean> {
    if (this.childPid !== undefined) {
      return true;
    }
    const pidFile = resolvePidFile(this.options.installRoot);
    let raw: string;
    try {
      raw = await readFile(pidFile, "utf8");
    } catch {
      return false;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || !isProcessAlive(pid)) {
      // A stale file from a killed process: remove it so the next spawn can
      // claim the root without the operator cleaning up by hand.
      await this.removePidFile();
      return false;
    }
    this.childPid = pid;
    // The real start time belongs to a process this CLI did not observe;
    // reporting `now` would be a fabrication, so it stays unknown.
    this.startedAt = undefined;
    this.state = "running";
    this.emit();
    return true;
  }

  /** Releases timers and log handles without signalling the child. */
  async dispose(): Promise<void> {
    this.clearRestartTimer();
    this.closeLogStream();
  }

  /**
   * Hands the child over to the OS.
   *
   * The tray path needs this: the CLI exits, the gateway keeps serving, and a
   * later invocation finds it through the pid file. Without it the exit hook
   * would kill a child the operator explicitly asked to keep running.
   */
  detach(): void {
    this.detached = true;
    this.child?.unref();
    this.child = undefined;
    this.closeLogStream();
  }

  private async spawnChild(): Promise<ServerStatus> {
    this.state = "starting";
    this.lastError = undefined;
    this.emit();

    ensureStateDirs(this.options.installRoot);

    const command = this.options.command ?? [resolveBinaryPath(this.options.installRoot)];
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    Object.assign(env, this.options.env ?? {});
    env["PORT"] = String(this.options.port);

    let child: Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn([...command], {
        cwd: this.options.cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `failed to spawn ${command.join(" ")}: ${message}`;
      this.state = "crashed";
      this.emit();
      return this.status;
    }

    this.child = child;
    this.childPid = child.pid;
    this.startedAt = Date.now();
    this.state = "running";
    this.deliberateStop = false;
    this.installExitHook();
    await this.writePidFile(child.pid);
    this.emit();

    void this.pump(child.stdout, false);
    void this.pump(child.stderr, true);

    void child.exited.then((code) => {
      void this.handleExit(child, code);
    });

    return this.status;
  }

  /**
   * Drains one child stream. `stderr` additionally feeds the failure detector
   * so a bind conflict becomes a readable message instead of a wall of stack
   * trace in a log the operator has to find.
   */
  private async pump(
    stream: ReadableStream<Uint8Array>,
    isStderr: boolean,
  ): Promise<void> {
    const decoder = new TextDecoder();
    const splitter = new LineSplitter();
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        for (const line of splitter.push(decoder.decode(value, { stream: true }))) {
          this.recordLine(line, isStderr);
        }
      }
      for (const line of splitter.push(decoder.decode())) {
        this.recordLine(line, isStderr);
      }
      for (const line of splitter.flush()) {
        this.recordLine(line, isStderr);
      }
    } catch {
      // The pipe closes abruptly when the child is killed; the exit handler
      // owns the state transition, so a read error is not news.
    } finally {
      reader.releaseLock();
    }
  }

  private recordLine(line: string, isStderr: boolean): void {
    this.appendLog(line);
    this.options.onLogLine?.(line);
    // Captured regardless of stream: pino writes to stdout, and Bun's uncaught
    // handler writes to stderr.
    const fatal = fatalMessageOf(line);
    if (fatal !== undefined) {
      this.lastFatalLine = fatal;
    }
    if (isStderr && this.lastError === undefined && /EADDRINUSE/.test(line)) {
      this.lastError = `port ${this.options.port} is already in use; stop the other process or pass --port`;
      this.emit();
    }
  }

  private appendLog(line: string): void {
    try {
      if (this.logStream === undefined) {
        this.logStream = createWriteStream(this.options.logFile, { flags: "a" });
        // A log write failure must not take down the supervisor; the child is
        // still serving and the operator has the console output.
        this.logStream.on("error", () => {
          this.closeLogStream();
        });
      }
      this.logStream.write(`${line}\n`);
    } catch {
      this.closeLogStream();
    }
  }

  private closeLogStream(): void {
    const stream = this.logStream;
    this.logStream = undefined;
    stream?.end();
  }

  /**
   * Exit handling for both real crashes and deliberate stops. The restart
   * decision lives here alone so a stopped child can never be resurrected by a
   * stale stream callback.
   */
  private async handleExit(
    child: Subprocess<"ignore", "pipe", "pipe">,
    code: number,
  ): Promise<void> {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    this.childPid = undefined;
    this.lastExitCode = code;

    if (this.deliberateStop) {
      this.state = "stopped";
      this.emit();
      await this.removePidFile();
      return;
    }
    if (this.detached) {
      // The CLI let go on purpose; a restart from here would resurrect a child
      // nobody owns.
      this.state = "stopped";
      this.emit();
      return;
    }

    await this.removePidFile();

    const now = Date.now();
    while (this.restartHistory.length > 0 && now - (this.restartHistory[0] ?? 0) > RESTART_WINDOW_MS) {
      this.restartHistory.shift();
    }
    if (this.restartHistory.length >= RESTART_MAX_ATTEMPTS) {
      this.state = "crashed";
      this.lastError ??= `gateway exited with code ${code} after ${RESTART_MAX_ATTEMPTS} restarts`;
      this.emit();
      return;
    }

    const attempt = this.restartHistory.length;
    this.restartHistory.push(now);
    const delay = RESTART_BASE_DELAY_MS * 2 ** attempt;
    this.state = "crashed";
    this.lastError = `gateway exited with code ${code}; restarting in ${delay}ms`;
    this.emit();

    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.deliberateStop) {
        return;
      }
      void this.start();
    }, delay);
  }

  /**
   * Signal, wait, then force. Windows has no signal semantics, so `taskkill`
   * is the only way to reach the child's process tree; on POSIX the tree dies
   * with the child because the gateway does not spawn grandchildren of its own.
   */
  private async terminate(pid: number, timeoutMs: number): Promise<void> {
    if (process.platform === "win32") {
      await this.taskkill(pid, false);
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        return;
      }
      await Bun.sleep(100);
    }
    if (!isProcessAlive(pid)) {
      return;
    }

    if (process.platform === "win32") {
      await this.taskkill(pid, true);
    } else {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        return;
      }
    }
    for (let i = 0; i < 20 && isProcessAlive(pid); i += 1) {
      await Bun.sleep(50);
    }
  }

  private async taskkill(pid: number, force: boolean): Promise<void> {
    const args = ["taskkill", "/PID", String(pid), "/T"];
    if (force) {
      args.push("/F");
    }
    try {
      const killer = Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      await killer.exited;
    } catch {
      // taskkill missing (stripped Windows image): fall back to the pid kill
      // so stop still does something rather than silently doing nothing.
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        return;
      }
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  private async writePidFile(pid: number): Promise<void> {
    try {
      await writeFile(resolvePidFile(this.options.installRoot), `${pid}\n`, "utf8");
    } catch {
      // A read-only install root is survivable: adoption is a convenience, not
      // a correctness requirement for this process.
    }
  }

  private async removePidFile(): Promise<void> {
    try {
      await rm(resolvePidFile(this.options.installRoot), { force: true });
    } catch {
      return;
    }
  }

  /**
   * Synchronous last-resort kill. `process.on("exit")` cannot await, so this
   * is a direct signal; it only fires when the child is still ours, which
   * excludes an adopted gateway owned by another CLI.
   */
  private installExitHook(): void {
    if (this.exitHookInstalled) {
      return;
    }
    this.exitHookInstalled = true;
    process.on("exit", () => {
      const child = this.child;
      if (child === undefined || this.deliberateStop || this.detached) {
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        return;
      }
    });
  }

  private emit(): void {
    const snapshot = this.status;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A subscriber throwing must not break supervision; the status was
        // delivered to the others.
      }
    }
  }
}
