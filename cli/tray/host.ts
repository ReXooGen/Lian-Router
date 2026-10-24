/**
 * The tray process.
 *
 * `lianrouter tray` spawns this file detached and then hides its own console,
 * so everything the operator can still reach lives here: one notification-area
 * icon, a popup menu, and an HTTP client pointed at the CLI's loopback control
 * port. The tray owns no server state — every menu action is a control request
 * resolved from `run/control.json` at the moment it is made.
 *
 * The failure mode this file exists to prevent is a menu click that silently
 * does nothing. Every control result is inspected, and every failure becomes a
 * modal dialog; a tray that looks alive but cannot reach the gateway is worse
 * than no tray, because the operator stops looking for the gateway.
 *
 * The endpoint is never cached. The control server binds an ephemeral port and
 * mints a new token on every start, so a launcher restart invalidates both — a
 * cached client would turn a healthy launcher into a permanent error dialog.
 * `connection.ts` owns that resolution and the retry-once recovery.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { callRecovering, callWithReconnect, isProcessAlive, resolveControlConnection } from "./connection";
import { resolveInstallRoot } from "./paths";
import { startTrayPump } from "./pump";
import type { TrayPumpHandle } from "./pump";
import { TRAY_COMMANDS } from "./protocol";
import type { TrayCommandId } from "./protocol";
import { consoleUrlFallback, classifyTrayState, describeTrayState } from "./state";
import { UPDATE_POLL_INTERVAL_MS, UPDATE_WATCH_TIMEOUT_MS, watchUpdate } from "./update-watch";
import type { UpdateOutcome } from "./update-watch";
import { showTrayError } from "./win32";

/** Shown until the first probe answers. */
const TOOLTIP_UNREACHABLE = "LianRouter — control unreachable";

/**
 * How often the tooltip re-reads the launcher's status.
 *
 * Long enough to cost nothing, short enough that a launcher restart, a stopped
 * gateway or a finished update shows up while the operator is still looking at
 * the icon. The interval is unref'd, so it never keeps the process alive by
 * itself.
 */
const TOOLTIP_REFRESH_MS = 15_000;

/**
 * `run/tray.pid`, the file `isTrayRunning`/`stopTray` in `cli/src/tray-launcher`
 * read.
 *
 * Duplicated rather than imported: `cli/src/paths.ts` is the launcher's layout
 * module and pulls in the dev-repo locator, the update cache and the state-dir
 * creator, none of which the tray needs — and importing it would put a second
 * `resolveInstallRoot` in this process, which is exactly the disagreement
 * `cli/tray/paths.ts` warns about. The join below must stay identical to
 * `resolveStateDir(root) + TRAY_PID_FILE_NAME`.
 */
function trayPidPath(installRoot: string): string {
  return join(installRoot, "run", "tray.pid");
}

/**
 * Claims the tray pid file, refusing to start a second host.
 *
 * Two hosts would register two icons against two windows in the same install
 * root, and `stopTray` would only ever signal the pid in the file — the other
 * icon would survive until Explorer restarted. A pid file naming a dead process
 * is stale (the host was killed), so it is overwritten.
 */
function claimTrayPidFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const raw = readFileSync(path, "utf8").trim();
    const existing = Number.parseInt(raw, 10);
    if (Number.isInteger(existing) && existing > 0 && existing !== process.pid && isProcessAlive(existing)) {
      throw new Error(`A tray host is already running (pid ${existing}).`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("A tray host")) throw error;
    // Unreadable or absent: nothing to protect, so the write below wins.
  }
  writeFileSync(path, `${process.pid}\n`, "utf8");
}

/** Removes the pid file only when it still names this process. */
function releaseTrayPidFile(path: string): void {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (Number.parseInt(raw, 10) !== process.pid) return;
    rmSync(path, { force: true });
  } catch {
    // Already gone; nothing to release.
  }
}

async function main(): Promise<number> {
  if (process.platform !== "win32") {
    console.log("the tray host is Windows-only; run `lianrouter` in a terminal");
    return 0;
  }

  const installRoot = resolveInstallRoot();

  // Startup is the one place a missing or dead handshake is fatal: without a
  // launcher there is nothing for the icon to drive. Every later action
  // re-resolves instead of trusting this read.
  const initial = resolveControlConnection(installRoot);
  if (!initial.ok) {
    showTrayError(initial.error);
    return 1;
  }

  const pidPath = trayPidPath(installRoot);
  try {
    claimTrayPidFile(pidPath);
  } catch (error) {
    showTrayError(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let pump: TrayPumpHandle | undefined;
  let exiting = false;
  let tooltipTimer: ReturnType<typeof setInterval> | undefined;

  const stopPump = async (): Promise<void> => {
    if (pump === undefined) return;
    const handle = pump;
    pump = undefined;
    await handle.stop();
  };

  const stopTooltipTimer = (): void => {
    if (tooltipTimer === undefined) return;
    clearInterval(tooltipTimer);
    tooltipTimer = undefined;
  };

  const exitTray = async (): Promise<void> => {
    if (exiting) return;
    exiting = true;
    stopTooltipTimer();
    await stopPump();
    releaseTrayPidFile(pidPath);
    process.exit(0);
  };

  /** Last URL the launcher reported, so the console can be opened without it. */
  let knownUrl: string | undefined;
  /** Gateway port from that URL, reused when a launcher has to be restarted. */
  let knownPort: number | undefined;

  /**
   * Refreshes the tooltip from the live endpoint.
   *
   * Runs on a timer, not once: a launcher restart, a stopped gateway, or an
   * update that finished all change what the icon should say, and a single
   * startup read pins the tooltip to whatever was true in the first second.
   * A failure is not fatal — the next tick re-resolves and recovers.
   *
   * The text names the state rather than saying "unreachable" for all of them:
   * "launcher not running (pid N)" and "gateway stopped" are different problems
   * with different fixes, and the tooltip is the only always-visible surface.
   */
  const refreshTooltip = async (): Promise<void> => {
    if (pump === undefined) return;
    const resolved = resolveControlConnection(installRoot);
    const launcherAlive = resolved.ok || !resolved.error.includes("is not running");
    const expectedPid = resolved.ok ? resolved.connection.handshake.pid : undefined;

    const result = resolved.ok ? await resolved.connection.client.status() : undefined;
    if (pump === undefined) return;
    if (result?.ok === true) {
      knownUrl = result.data.url;
      knownPort = result.data.port;
    }

    const state = classifyTrayState(
      result?.ok === true ? result.data : undefined,
      launcherAlive,
      expectedPid,
      result?.ok === false ? result.error : resolved.ok ? undefined : resolved.error,
    );
    pump.setTooltip(describeTrayState(state));
  };

  /**
   * Watches an update the launcher accepted, and reports how it ended.
   *
   * `POST /update/start` answers `202` before any work happens, so the response
   * proves nothing. The launcher keeps the outcome in `/update/state`; polling
   * it is what turns a silent no-op into either a dialog or a new tooltip.
   */
  const followUpdate = async (): Promise<void> => {
    await watchUpdate({
      timeoutMs: UPDATE_WATCH_TIMEOUT_MS,
      intervalMs: UPDATE_POLL_INTERVAL_MS,
      readState: async () => {
        const result = await callWithReconnect(installRoot, (client) => client.updateState());
        return result.ok ? result.data : undefined;
      },
      onSettled: (outcome: UpdateOutcome) => {
        if (outcome.kind === "failed") {
          showTrayError(`Update failed: ${outcome.message}`);
          void refreshTooltip();
          return;
        }
        if (outcome.kind === "unknown") {
          showTrayError(
            `Could not confirm whether the update finished: ${outcome.message}. ` +
              "Check the console before retrying.",
          );
          void refreshTooltip();
          return;
        }
        // `done` and `none` are both quiet: a successful update should not nag,
        // and "nothing was running" is not an error worth a dialog.
        void refreshTooltip();
      },
    });
  };

  /**
   * Opens the console without needing the launcher.
   *
   * `POST /open-web` is the normal path, but it needs the control server. When
   * the launcher is gone the gateway may still be serving, and the URL is
   * either the last one it reported or the gateway default. This is the one
   * action that must work in every state, so it never reports a control-port
   * failure.
   */
  const openConsoleDirectly = (): void => {
    const url = consoleUrlFallback(knownUrl);
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
      showTrayError(`Could not open ${url}. Visit it manually.`);
    }
  };

  /** Shared resurrection settings for every menu action. */
  const recoveryDeps = {
    spawn: (command: { readonly file: string; readonly args: readonly string[] }): number | undefined => {
      try {
        const child = Bun.spawn([command.file, ...command.args], {
          cwd: installRoot,
          env: { ...process.env, LIANROUTER_HOME: installRoot },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        child.unref();
        return child.pid;
      } catch {
        return undefined;
      }
    },
    readHandshakePid: (): number | undefined => {
      const resolved = resolveControlConnection(installRoot);
      return resolved.ok ? resolved.connection.handshake.pid : undefined;
    },
    sleep: (ms: number) => Bun.sleep(ms),
    now: () => Date.now(),
  };

  /**
   * Runs one menu command.
   *
   * Async on purpose: the pump calls this from inside the window procedure, and
   * `showTrayError` is a modal dialog with its own message loop. Reporting an
   * error synchronously from the window procedure would re-enter it while the
   * tray callback that triggered the command is still on the stack.
   *
   * Every action goes through `callRecovering`, which reconnects after a
   * launcher restart and, when the launcher is actually gone, starts a headless
   * one and retries once. The exception is Open Console, which falls back to
   * opening the URL directly — a menu whose only working item is Exit is the
   * failure this whole path exists to prevent.
   */
  const runCommand = async (command: TrayCommandId): Promise<void> => {
    if (command === TRAY_COMMANDS.exit) {
      const result = await callRecovering({
        installRoot,
        startDir: import.meta.dir,
        deps: recoveryDeps,
        ...(knownPort === undefined ? {} : { gatewayPort: knownPort }),
        call: (client) => client.shutdown(),
      });
      // A launcher that is already gone is the desired end state for Exit, so a
      // failed shutdown must not hold the icon hostage.
      if (!result.result.ok && result.recovery.kind !== "failed") showTrayError(result.result.error);
      await exitTray();
      return;
    }

    if (command === TRAY_COMMANDS.openConsole) {
      const result = await callRecovering({
        installRoot,
        startDir: import.meta.dir,
        deps: recoveryDeps,
        ...(knownPort === undefined ? {} : { gatewayPort: knownPort }),
        call: (client) => client.openWeb(),
      });
      if (result.result.ok) {
        void refreshTooltip();
        return;
      }
      // The launcher could not be reached or restarted: the gateway may still
      // serve, and the operator asked for the console, so open it directly.
      openConsoleDirectly();
      void refreshTooltip();
      return;
    }

    if (command === TRAY_COMMANDS.checkUpdate) {
      const accepted = await callRecovering({
        installRoot,
        startDir: import.meta.dir,
        deps: recoveryDeps,
        ...(knownPort === undefined ? {} : { gatewayPort: knownPort }),
        call: (client) => client.startUpdate(),
      });
      if (!accepted.result.ok) {
        showTrayError(accepted.result.error);
        void refreshTooltip();
        return;
      }
      void followUpdate();
      return;
    }

    const result = await callRecovering({
      installRoot,
      startDir: import.meta.dir,
      deps: recoveryDeps,
      ...(knownPort === undefined ? {} : { gatewayPort: knownPort }),
      call: (client) => (command === TRAY_COMMANDS.restart ? client.restart() : client.stop()),
    });
    if (!result.result.ok) {
      showTrayError(result.result.error);
      void refreshTooltip();
      return;
    }
    // The URL and the state both change after a restart or a stop, and the
    // operator is looking at the icon when it happens.
    void refreshTooltip();
  };

  try {
    pump = await startTrayPump({
      tooltip: TOOLTIP_UNREACHABLE,
      onCommand: (command) => {
        void runCommand(command);
      },
      onLeftClick: () => {
        void runCommand(TRAY_COMMANDS.openConsole);
      },
    });
  } catch (error) {
    releaseTrayPidFile(pidPath);
    showTrayError(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const handle = pump;
  const onSignal = (): void => {
    void (async () => {
      stopTooltipTimer();
      await stopPump();
      releaseTrayPidFile(pidPath);
      process.exit(0);
    })();
  };
  // On Windows a `SIGTERM` sent by `stopTray` terminates the process outright —
  // Bun does not deliver it to a JS handler, and `exit` handlers do not run
  // either (measured). The handlers stay for the POSIX path and for Ctrl-C in a
  // terminal; the pid file is cleaned by `stopTray` itself in both cases, which
  // is why it also removes the file after a successful kill.
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // The icon is already visible, so the first read is out of band rather than
  // delaying the tray on a request that may take the full 5 s timeout.
  void refreshTooltip();
  tooltipTimer = setInterval(() => {
    void refreshTooltip();
  }, TOOLTIP_REFRESH_MS);
  tooltipTimer.unref();

  // Resolves only after the pump's loop ends on its own (Exit was chosen, the
  // window was destroyed, or a signal called `stop()`), so the process stays
  // alive for as long as the icon is visible.
  await handle.exited;
  stopTooltipTimer();
  releaseTrayPidFile(pidPath);
  return 0;
}

process.exitCode = await main();
