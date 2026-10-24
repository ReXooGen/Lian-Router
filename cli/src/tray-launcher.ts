import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ControlHandshake } from "./control-server";
import { ensureStateDirs, resolveTrayPidFile } from "./paths";

/**
 * Starts and hides the tray host.
 *
 * The tray is a separate process on purpose: the CLI owns a console window and
 * a foreground event loop, and a tray icon must outlive both. That splits the
 * lifecycle in two, so the handshake is explicit — the tray reads
 * `run/control.json` to find the control port and token, and the CLI records the
 * tray pid so it can stop a host it started without touching one the operator
 * launched by hand.
 */

export interface TrayLaunchOptions {
  readonly installRoot: string;
  /** Handshake the tray needs; written to `run/control.json` by the CLI already. */
  readonly control: ControlHandshake;
  /** Repository root when running from a checkout; undefined for a packaged install. */
  readonly devRepoRoot?: string;
  /** Overrides the tray command; tests pass a plain runtime. */
  readonly command?: readonly string[];
  readonly cwd?: string;
}

export interface TrayEntryOptions {
  readonly installRoot: string;
  /** Repository root when running from a checkout; undefined for a packaged install. */
  readonly devRepoRoot?: string;
}

/** Outcome of a tray spawn. A failure carries a message fit to print. */
export type TrayStartResult = { readonly ok: true; readonly pid: number } | { readonly ok: false; readonly error: string };

/**
 * Path of the tray entry.
 *
 * A packaged install ships `dist/tray.js` inside the install root. A source
 * checkout does not: `bun run build:cli` writes the bundle to
 * `<repo>/cli/dist/tray.js`, while the install root stays in app data, so the
 * install-root path names a file that will never exist there.
 *
 * The choice is made by existence rather than by mode, because both directions
 * are real — a checkout that has not been built yet has neither file, and a
 * packaged install has no repo at all. `devRepoRoot` is the gateway repository
 * root, whose launcher package is `cli/`.
 */
export function resolveTrayEntry(options: TrayEntryOptions): string | undefined {
  const candidates: string[] = [];
  if (options.devRepoRoot !== undefined) {
    candidates.push(join(options.devRepoRoot, "cli", "dist", "tray.js"));
  }
  candidates.push(join(options.installRoot, "dist", "tray.js"));
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Spawns the tray host detached with stdio discarded.
 *
 * Detached + ignored stdio is what makes `lianrouter` able to exit its console
 * while the icon stays alive: a child holding our pipes would keep the parent's
 * stdio handles open and the shell prompt would never return.
 *
 * The existence check comes first so a missing bundle produces an actionable
 * message. Without it `Bun.spawn` fails on a path the operator cannot see, and
 * the caller would hide the console and poll for a pid file that is never
 * written — a silent hang with no icon.
 */
export async function startTray(options: TrayLaunchOptions): Promise<TrayStartResult> {
  ensureStateDirs(options.installRoot);

  let command: readonly string[];
  if (options.command !== undefined) {
    command = options.command;
  } else {
    const entry = resolveTrayEntry(
      options.devRepoRoot === undefined
        ? { installRoot: options.installRoot }
        : { installRoot: options.installRoot, devRepoRoot: options.devRepoRoot },
    );
    if (entry === undefined) {
      const looked: string[] = [];
      if (options.devRepoRoot !== undefined) {
        looked.push(join(options.devRepoRoot, "cli", "dist", "tray.js"));
      }
      looked.push(join(options.installRoot, "dist", "tray.js"));
      return {
        ok: false,
        error: `The tray bundle is missing (looked for ${looked.join(", ")}). Run \`bun run build:cli\` to build it.`,
      };
    }
    command = [process.execPath, entry];
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // The tray resolves the same layout from the same variable, so passing it
  // explicitly keeps a `--port`/`LIANROUTER_HOME` override consistent across
  // the process boundary.
  env["LIANROUTER_HOME"] = options.installRoot;

  let pid: number;
  try {
    const child = Bun.spawn([...command], {
      cwd: options.cwd ?? options.installRoot,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
    pid = child.pid;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not start the tray host (${command.join(" ")}): ${detail}` };
  }

  await writeFile(resolveTrayPidFile(options.installRoot), `${pid}\n`, "utf8");
  return { ok: true, pid };
}

/** True when the tray pid file names a live process. */
export async function isTrayRunning(installRoot: string): Promise<boolean> {
  const pid = await readTrayPid(installRoot);
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    await rm(resolveTrayPidFile(installRoot), { force: true });
    return false;
  }
}

/**
 * Stops a tray host this CLI started. A pid file pointing at a dead process is
 * cleaned up rather than reported as a failure.
 */
export async function stopTray(installRoot: string): Promise<boolean> {
  const pid = await readTrayPid(installRoot);
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    await rm(resolveTrayPidFile(installRoot), { force: true });
    return false;
  }
  for (let i = 0; i < 20; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      await rm(resolveTrayPidFile(installRoot), { force: true });
      return true;
    }
    await Bun.sleep(50);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone between the last probe and the kill.
  }
  await rm(resolveTrayPidFile(installRoot), { force: true });
  return true;
}

/**
 * Hides the console window that owns this process, on Windows only.
 *
 * `ShowWindow(GetConsoleWindow(), 0)` through `Add-Type` is the supported way to
 * hide a console from the process that owns it — there is no Win32 export the
 * Bun runtime exposes, and launching a second hidden host would detach the
 * launcher from its own window. On POSIX there is no window to hide, so this is
 * a no-op that reports `false`.
 */
export function hideConsoleWindow(): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const script = [
    "Add-Type -Name Win -Namespace Native -MemberDefinition",
    "'[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();",
    "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);';",
    "[void][Native.Win]::ShowWindow([Native.Win]::GetConsoleWindow(), 0)",
  ].join(" ");
  try {
    const result = Bun.spawnSync(
      ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    return result.exitCode === 0;
  } catch {
    // No PowerShell on the image (Nano Server, stripped container): the console
    // stays visible, which is a cosmetic failure, not a functional one.
    return false;
  }
}

async function readTrayPid(installRoot: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(resolveTrayPidFile(installRoot), "utf8");
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}
