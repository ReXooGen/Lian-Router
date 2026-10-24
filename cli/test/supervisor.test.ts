import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewaySupervisor, type ServerStatus } from "../src/supervisor";
import { resolveLogFile, resolvePidFile } from "../src/paths";

/**
 * Supervisor behavior against a real fake gateway.
 *
 * The fake is an actual child process (`bun -e`), not a stub: restart budgets,
 * exit codes, and pid files only mean anything when a process really starts and
 * stops. A mocked `Bun.spawn` would prove the mock, not the supervisor.
 *
 * Waiting is done on observable signals — a status transition, a file the child
 * wrote, its death — never on a guessed sleep, except where a bounded poll is
 * the only way to see an asynchronous file write land.
 */

const RUNTIME = process.execPath;
const tempRoots: string[] = [];
const supervisors: GatewaySupervisor[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lianrouter-sup-"));
  tempRoots.push(dir);
  return dir;
}

function makeSupervisor(
  installRoot: string,
  script: string,
  port = 41_800,
  onLogLine?: (line: string) => void,
): GatewaySupervisor {
  const supervisor = new GatewaySupervisor({
    port,
    installRoot,
    logFile: resolveLogFile(installRoot),
    cwd: installRoot,
    command: [RUNTIME, "-e", script],
    ...(onLogLine === undefined ? {} : { onLogLine }),
  });
  supervisors.push(supervisor);
  return supervisor;
}

/** Resolves on the first status matching the predicate, or rejects on timeout. */
function waitForStatus(
  supervisor: GatewaySupervisor,
  predicate: (status: ServerStatus) => boolean,
  timeoutMs: number,
): Promise<ServerStatus> {
  const { promise, resolve, reject } = Promise.withResolvers<ServerStatus>();
  if (predicate(supervisor.status)) {
    resolve(supervisor.status);
    return promise;
  }
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new Error(`no matching status within ${timeoutMs}ms; last=${supervisor.status.state}`));
  }, timeoutMs);
  const unsubscribe = supervisor.subscribe((status) => {
    if (predicate(status)) {
      clearTimeout(timer);
      unsubscribe();
      resolve(status);
    }
  });
  return promise;
}

/**
 * Polls until `read` returns a non-undefined value. Used only where the signal
 * is a filesystem write by a child process, which has no event to await.
 */
async function pollUntil<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await Bun.sleep(25);
  }
  return undefined;
}

async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.stop(1_000).catch(() => undefined);
    await supervisor.dispose();
  }
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("GatewaySupervisor", () => {
  test(
    "start reports running and records the pid file",
    async () => {
      const root = await makeRoot();
      const supervisor = makeSupervisor(root, "setInterval(() => {}, 1000)");

      const started = await supervisor.start();
      expect(started.state).toBe("running");
      expect(started.pid).toBeGreaterThan(0);
      expect(started.url).toBe("http://localhost:41800");

      const recorded = await pollUntil(() => readFileOrUndefined(resolvePidFile(root)), 2_000);
      expect(recorded?.trim()).toBe(String(started.pid));
    },
    20_000,
  );

  test(
    "stop transitions to stopped, kills the child, and clears the pid file",
    async () => {
      const root = await makeRoot();
      const supervisor = makeSupervisor(root, "setInterval(() => {}, 1000)");
      const started = await supervisor.start();
      const pid = started.pid;
      expect(pid).toBeDefined();

      const stopped = await supervisor.stop(5_000);
      expect(stopped.state).toBe("stopped");
      expect(stopped.pid).toBeUndefined();
      expect(existsSync(resolvePidFile(root))).toBe(false);
      expect(() => process.kill(pid ?? -1, 0)).toThrow();
    },
    20_000,
  );

  test(
    "an unexpected exit is restarted rather than treated as a stop",
    async () => {
      const root = await makeRoot();
      // The marker file is how the fake distinguishes its first run from the
      // respawn: a child process cannot remember anything in memory.
      const marker = join(root, "first-run-done");
      const script = [
        'import { existsSync, writeFileSync } from "node:fs";',
        `const marker = ${JSON.stringify(marker)};`,
        "if (!existsSync(marker)) {",
        '  writeFileSync(marker, "1");',
        "  setTimeout(() => process.exit(7), 50);",
        "} else {",
        "  setInterval(() => {}, 1000);",
        "}",
      ].join("\n");
      const supervisor = makeSupervisor(root, script);

      const states: string[] = [];
      supervisor.subscribe((status) => {
        if (states[states.length - 1] !== status.state) {
          states.push(status.state);
        }
      });

      await supervisor.start();
      const recovered = await waitForStatus(
        supervisor,
        (status) => status.state === "running" && status.lastExitCode === 7,
        15_000,
      );
      expect(recovered.pid).toBeGreaterThan(0);
      expect(states).toContain("crashed");
    },
    25_000,
  );

  test(
    "exhausts the restart budget and settles on crashed",
    async () => {
      const root = await makeRoot();
      const counter = join(root, "spawns.log");
      await mkdir(root, { recursive: true });
      const script = [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(counter)}, "x");`,
        "process.exit(3);",
      ].join("\n");
      const supervisor = makeSupervisor(root, script);

      await supervisor.start();
      const crashed = await waitForStatus(
        supervisor,
        (status) => status.state === "crashed" && status.lastError?.includes("restarts") === true,
        20_000,
      );
      expect(crashed.state).toBe("crashed");
      expect(crashed.pid).toBeUndefined();

      // Budget of three restarts means four children total: the initial spawn
      // plus three retries, and no fifth.
      const spawns = (await readFile(counter, "utf8")).length;
      expect(spawns).toBe(4);
      expect(supervisor.status.state).toBe("crashed");
    },
    30_000,
  );

  test(
    "a deliberate stop never schedules a restart",
    async () => {
      const root = await makeRoot();
      const supervisor = makeSupervisor(root, "setInterval(() => {}, 1000)");
      const states: string[] = [];
      supervisor.subscribe((status) => {
        if (states[states.length - 1] !== status.state) {
          states.push(status.state);
        }
      });

      await supervisor.start();
      await supervisor.stop(5_000);
      await supervisor.dispose();

      expect(states).not.toContain("crashed");
      expect(supervisor.status.state).toBe("stopped");
    },
    20_000,
  );

  test(
    "forwards child output to the listener and appends it to the log file",
    async () => {
      const root = await makeRoot();
      const lines: string[] = [];
      const supervisor = makeSupervisor(
        root,
        "console.log('ready-line'); setTimeout(() => {}, 300);",
        41_801,
        (line) => {
          lines.push(line);
        },
      );

      await supervisor.start();
      const logged = await pollUntil(async () => {
        const content = await readFileOrUndefined(resolveLogFile(root));
        return content?.includes("ready-line") === true ? content : undefined;
      }, 5_000);

      expect(lines).toContain("ready-line");
      expect(logged).toContain("ready-line");
    },
    20_000,
  );

  test(
    "adoptExisting takes over a live pid file without spawning a second child",
    async () => {
      const root = await makeRoot();
      const supervisor = makeSupervisor(root, "setInterval(() => {}, 1000)");
      const started = await supervisor.start();
      const pid = started.pid;
      await supervisor.dispose();

      // Simulates a second CLI invocation: a fresh supervisor reading the same
      // install root must adopt, not spawn. Its own command would exit 9 if it
      // ever ran.
      const adopter = makeSupervisor(root, "process.exit(9)", 41_802);

      expect(await adopter.adoptExisting()).toBe(true);
      expect(adopter.status.state).toBe("running");
      expect(adopter.status.pid).toBe(pid);
    },
    20_000,
  );

  test(
    "adoptExisting clears a stale pid file and reports false",
    async () => {
      const root = await makeRoot();
      const supervisor = makeSupervisor(root, "setInterval(() => {}, 1000)");
      await mkdir(join(root, "run"), { recursive: true });
      // A pid beyond every platform's ceiling, so it can never be alive.
      await writeFile(resolvePidFile(root), "999999999\n", "utf8");

      expect(await supervisor.adoptExisting()).toBe(false);
      expect(existsSync(resolvePidFile(root))).toBe(false);
    },
    20_000,
  );

  test(
    "surfaces EADDRINUSE from the child's stderr as lastError",
    async () => {
      const root = await makeRoot();
      const supervisor = makeSupervisor(
        root,
        "console.error('error: Failed to start server. Is port 41803 in use? EADDRINUSE'); setInterval(() => {}, 1000);",
        41_803,
      );

      await supervisor.start();
      const reported = await waitForStatus(
        supervisor,
        (status) => status.lastError?.includes("already in use") === true,
        10_000,
      );
      expect(reported.lastError).toContain("41803");
    },
    20_000,
  );

  test(
    "a nonexistent command settles on crashed immediately instead of waiting for health",
    async () => {
      const root = await makeRoot();
      // The published-install failure: the supervisor's default command is
      // `<installRoot>/lianrouter.exe`, which does not exist before the first
      // install. `Bun.spawn` throws ENOENT, and the supervisor must report that
      // rather than sit in "starting" while `waitForHealthy` polls a port
      // nobody will ever bind.
      const missing = join(root, "lianrouter.exe");
      const supervisor = new GatewaySupervisor({
        port: 41_804,
        installRoot: root,
        logFile: resolveLogFile(root),
        cwd: root,
        command: [missing],
      });
      supervisors.push(supervisor);

      const started = await supervisor.start();
      expect(started.state).toBe("crashed");
      expect(started.lastError).toContain(missing);
      expect(started.pid).toBeUndefined();

      // The early-exit arm returns on the already-crashed state instead of
      // polling a port nobody will bind. Asserting the state *before* the wait
      // is what makes the wait terminate: a supervisor left in "starting" would
      // spend the whole budget here and then report the generic health message.
      expect(supervisor.status.state).toBe("crashed");
      expect(await supervisor.waitForHealthy(5_000)).toBe(false);
      expect(supervisor.status.state).toBe("crashed");
    },
    20_000,
  );

  test(
    "describeFailure names the child's own fatal line from its log",
    async () => {
      const root = await makeRoot();
      // A child that fails the way the real gateway does with no database: it
      // prints a structured error and exits, so the port is never bound and the
      // health wait times out. The supervisor must report the child's line, not
      // just "did not answer".
      const script = [
        "console.log(JSON.stringify({ level: 'info', msg: 'starting gateway' }));",
        "console.error(JSON.stringify({ level: 'error', msg: 'DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db)' }));",
        "process.exit(1);",
      ].join("\n");
      const supervisor = makeSupervisor(root, script, 41_805);

      await supervisor.start();
      // Wait for the child to die: its exit is what produces the log tail.
      await waitForStatus(supervisor, (status) => status.state === "crashed", 10_000);
      const described = await supervisor.describeFailure();

      expect(described).toContain("The gateway logged:");
      expect(described).toContain("DATABASE_URL is required");
      // The informational line above it must not be mistaken for the cause.
      expect(described).not.toContain("starting gateway");
    },
    20_000,
  );

  test(
    "describeFailure names the log path when the child logged nothing fatal",
    async () => {
      const root = await makeRoot();
      // A child that is alive and chatting but has no fatal line to report.
      const supervisor = makeSupervisor(
        root,
        "console.log('ready-line'); setInterval(() => {}, 1000);",
        41_806,
      );

      await supervisor.start();
      // The log write is asynchronous; the readiness line is the observable
      // signal that the file now exists.
      await pollUntil(async () => {
        const content = await readFileOrUndefined(resolveLogFile(root));
        return content?.includes("ready-line") === true ? content : undefined;
      }, 5_000);
      const described = await supervisor.describeFailure();

      // No fatal line anywhere: the honest answer is where to look, not an
      // invented cause.
      expect(described).toContain("The gateway log is at");
      expect(described).toContain(resolveLogFile(root));
    },
    20_000,
  );

  test(
    "describeFailure names the expected path when no log was written at all",
    async () => {
      const root = await makeRoot();
      const supervisor = makeSupervisor(root, "setInterval(() => {}, 1000)", 41_807);

      await supervisor.start();
      const described = await supervisor.describeFailure();

      expect(described).toContain("No gateway log was written");
      expect(described).toContain(resolveLogFile(root));
    },
    20_000,
  );
});
