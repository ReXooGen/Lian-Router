/**
 * The tray message pump.
 *
 * # Why polling instead of `GetMessageW`
 *
 * `GetMessageW` blocks its thread until a message arrives, and a blocked thread
 * cannot run JavaScript: an FFI call that sleeps for 2 s leaves a pending
 * `fetch` unresolved for the whole 2 s. The pump has to share a thread with the
 * control HTTP calls (a Worker cannot register the window class — measured on
 * Bun 1.4.2 / Windows, `RegisterClassExW` there returns 0 with
 * `ERROR_INVALID_PARAMETER`), so it polls instead: drain the queue with
 * `PeekMessageW(..., PM_REMOVE)`, then `await Bun.sleep(8)` to hand the event
 * loop back. Measured cost of the idle turn: ~180 loop iterations per 1.5 s
 * with a `fetch` from a `setInterval` resolving in ~1 ms.
 *
 * # Window procedure contract
 *
 * `WM_NCCREATE` (0x0081) must return 1. Returning 0 makes Windows abort window
 * creation, and `CreateWindowExW` then returns NULL with `GetLastError() == 0` —
 * the most misleading failure Win32 can produce, because there is no error to
 * read. Everything unhandled falls through to `DefWindowProcW`.
 *
 * # Callback lifetime
 *
 * The window procedure is a `JSCallback`, i.e. a native trampoline whose address
 * `user32` stores in the window class. If the `JSCallback` is garbage-collected
 * the trampoline is freed while `user32` still calls it, and the next message
 * jumps into freed memory and kills the process with no catchable error. Every
 * callback created here is pushed into `callbackKeepAlive`, a module-level array
 * that lives for the whole process. Do not clean it up.
 */

import { JSCallback, ptr } from "bun:ffi";
import "./icon";
import { TRAY_COMMANDS } from "./protocol";
import type { TrayCommandId } from "./protocol";
import {
  destroyTrayIcon,
  getWin32,
  requestTrayQuit,
  resolveTrayIconHandle,
  showTrayError,
  toHandle,
  wideString,
  writeWideString,
} from "./win32";
import type { NativeHandle } from "./win32";

// ─── Message and flag constants ─────────────────────────────────────────────

const WM_DESTROY = 0x0002;
const WM_QUIT = 0x0012;
const WM_NULL = 0x0000;
const WM_NCCREATE = 0x0081;
const WM_RBUTTONUP = 0x0205;
const WM_CONTEXTMENU = 0x007b;
const WM_LBUTTONDBLCLK = 0x0203;

/**
 * First application-defined message. Win32 reserves `WM_APP` (0x8000) upward for
 * the application, which is how a window without a resource-defined menu gets a
 * private callback channel. `TRAY_CALLBACK_MESSAGE` is the id registered with
 * `Shell_NotifyIconW`; Explorer posts it to our window on every icon interaction.
 */
const WM_APP = 0x8000;
const TRAY_CALLBACK_MESSAGE = WM_APP + 1;

const CS_HREDRAW = 0x0002;
const CS_VREDRAW = 0x0001;
const WS_OVERLAPPED = 0x0000;

const PM_REMOVE = 0x0001;

const NIM_ADD = 0;
const NIM_MODIFY = 1;
const NIM_DELETE = 2;
const NIF_MESSAGE = 0x01;
const NIF_ICON = 0x02;
const NIF_TIP = 0x04;

const MF_STRING = 0x0000;
const MF_SEPARATOR = 0x0800;
const TPM_RIGHTBUTTON = 0x0002;
/** Returns the chosen command id from `TrackPopupMenu` instead of posting `WM_COMMAND`. */
const TPM_RETURNCMD = 0x0100;

/** Idle turn length. Short enough that a click feels immediate, long enough that the loop costs nothing. */
const PUMP_IDLE_MS = 8;

// ─── Struct layouts (x64) ───────────────────────────────────────────────────

/**
 * `MSG`, 48 bytes on x64: hwnd@0, message@8, wParam@16, lParam@24, time@32,
 * pt@36 (two int32s).
 */
const MSG_SIZE = 48;
const MSG_MESSAGE_OFFSET = 8;

/**
 * `WNDCLASSEXW`, 80 bytes on x64:
 * cbSize@0, style@4, lpfnWndProc@8, cbClsExtra@16, cbWndExtra@20,
 * hInstance@24, hIcon@32, hCursor@40, hbrBackground@48, lpszMenuName@56,
 * lpszClassName@64, hIconSm@72.
 */
const WNDCLASSEXW_SIZE = 80;

/**
 * `NOTIFYICONDATAW` in its full Vista+ form, 976 bytes on x64:
 * cbSize@0, hWnd@8, uID@16, uFlags@20, uCallbackMessage@24, hIcon@32,
 * szTip@40 (128 wchars), dwState@296, dwStateMask@300, szInfo@304 (256 wchars),
 * uVersion@816, szInfoTitle@820 (64 wchars), dwInfoFlags@948, guidItem@952,
 * hBalloonIcon@968.
 */
const NOTIFYICONDATAW_SIZE = 976;
const NID_HWND = 8;
const NID_UID = 16;
const NID_UFLAGS = 20;
const NID_CALLBACK = 24;
const NID_HICON = 32;
const NID_SZTIP = 40;
const NID_SZTIP_CHARS = 128;

/** `POINT`: two int32s. */
const POINT_SIZE = 8;

// ─── Callback pinning ───────────────────────────────────────────────────────

/** Process-lifetime home for every `JSCallback`. See the module header. */
const callbackKeepAlive: JSCallback[] = [];

// ─── Public surface ─────────────────────────────────────────────────────────

export interface TrayPumpOptions {
  readonly tooltip: string;
  readonly iconPath?: string;
  readonly onCommand: (command: TrayCommandId) => void;
  readonly onLeftClick?: () => void;
  readonly onReady?: () => void;
}

export interface TrayPumpHandle {
  /** Resolves after WM_QUIT and window/icon teardown. */
  stop(): Promise<void>;
  /**
   * Resolves when the loop ends on its own — the operator chose Exit, or the
   * window was destroyed from outside. Distinct from {@link stop} because a
   * host that awaits `stop()` would be asking the tray to quit as its first
   * act; awaiting this one keeps the process alive until someone else decides.
   */
  readonly exited: Promise<void>;
  /**
   * Rewrites the notification-area tooltip through `NIM_MODIFY`.
   *
   * The icon is registered before the control API has been asked for its URL,
   * so the tooltip starts provisional and is corrected once `status()` answers.
   */
  setTooltip(tooltip: string): void;
  /** The window handle; a `NativeHandle` (64-bit `HWND`) carried as `unknown`. */
  readonly windowHandle: unknown;
}

// ─── Menu ───────────────────────────────────────────────────────────────────

interface MenuEntry {
  readonly label: string;
  readonly command: TrayCommandId;
}

const MENU_ENTRIES: readonly (MenuEntry | "separator")[] = [
  { label: "Open Console", command: TRAY_COMMANDS.openConsole },
  { label: "Restart Server", command: TRAY_COMMANDS.restart },
  { label: "Stop Server", command: TRAY_COMMANDS.stop },
  { label: "Check for Updates", command: TRAY_COMMANDS.checkUpdate },
  "separator",
  { label: "Exit", command: TRAY_COMMANDS.exit },
];

/**
 * Builds, shows, and destroys the context menu, returning the chosen command id
 * (0 when the operator dismissed it).
 *
 * `TrackPopupMenu` runs its own modal loop on this thread, so the pump stalls
 * for as long as the menu is open. That is unavoidable and harmless: the menu
 * needs the same message queue, and nothing else is due while it is up.
 *
 * The label buffers are kept referenced until after `TrackPopupMenu` returns.
 * `AppendMenuW` copies the string, but holding them keeps the buffer lifetime
 * obvious to the next reader.
 */
function showContextMenu(window: NativeHandle): number {
  const { user32 } = getWin32();
  const menu = toHandle(user32.CreatePopupMenu());
  if (menu === undefined) return 0;

  const keepAlive: Buffer[] = [];
  for (const entry of MENU_ENTRIES) {
    if (entry === "separator") {
      user32.AppendMenuW(menu, MF_SEPARATOR, 0n, null);
      continue;
    }
    const label = wideString(entry.label);
    keepAlive.push(label);
    user32.AppendMenuW(menu, MF_STRING, BigInt(entry.command), ptr(label));
  }

  const cursor = Buffer.alloc(POINT_SIZE);
  user32.GetCursorPos(ptr(cursor));
  const view = new DataView(cursor.buffer, cursor.byteOffset, cursor.byteLength);
  const x = view.getInt32(0, true);
  const y = view.getInt32(4, true);

  // A popup menu is dismissed by the first click anywhere else only when its
  // owner is the foreground window — MSDN documents this as required for tray
  // menus, and without it the menu stays on screen after the user clicks away.
  user32.SetForegroundWindow(window);
  const command = user32.TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, 0, window, null);
  user32.DestroyMenu(menu);
  // The documented follow-up to SetForegroundWindow: without a posted message
  // the menu's owner can keep the foreground and swallow the next click.
  user32.PostMessageW(window, WM_NULL, 0n, 0n);

  return command;
}

/** Which handler a tray callback should invoke, decoded from the mouse message. */
type TrayEvent = "context" | "activate" | "none";

function decodeTrayEvent(mouseMessage: number): TrayEvent {
  if (mouseMessage === WM_RBUTTONUP || mouseMessage === WM_CONTEXTMENU) return "context";
  if (mouseMessage === WM_LBUTTONDBLCLK) return "activate";
  return "none";
}

const COMMAND_IDS: readonly number[] = Object.values(TRAY_COMMANDS);

function isTrayCommandId(value: number): value is TrayCommandId {
  return COMMAND_IDS.includes(value);
}

// ─── Icon registration ──────────────────────────────────────────────────────

function buildNotifyIconData(window: NativeHandle, icon: NativeHandle, tooltip: string): Buffer {
  const data = Buffer.alloc(NOTIFYICONDATAW_SIZE);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setUint32(0, NOTIFYICONDATAW_SIZE, true);
  view.setBigUint64(NID_HWND, window, true);
  view.setUint32(NID_UID, 1, true);
  view.setUint32(NID_UFLAGS, NIF_MESSAGE | NIF_ICON | NIF_TIP, true);
  view.setUint32(NID_CALLBACK, TRAY_CALLBACK_MESSAGE, true);
  view.setBigUint64(NID_HICON, icon, true);
  writeWideString(data, NID_SZTIP, NID_SZTIP_CHARS, tooltip);
  return data;
}

/** A `NIM_MODIFY` payload: same icon identity, new tooltip only. */
function buildTooltipUpdate(window: NativeHandle, tooltip: string): Buffer {
  const data = Buffer.alloc(NOTIFYICONDATAW_SIZE);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setUint32(0, NOTIFYICONDATAW_SIZE, true);
  view.setBigUint64(NID_HWND, window, true);
  view.setUint32(NID_UID, 1, true);
  view.setUint32(NID_UFLAGS, NIF_TIP, true);
  writeWideString(data, NID_SZTIP, NID_SZTIP_CHARS, tooltip);
  return data;
}

// ─── Window class ───────────────────────────────────────────────────────────

const WINDOW_TITLE = "LianRouter Tray";

/**
 * Class names must be unique per registration: registering the same name twice
 * in one process fails with `ERROR_CLASS_ALREADY_EXISTS` (1410), and the tray
 * can be stopped and started again inside one process (tests do exactly that).
 */
let classSequence = 0;

interface PumpState {
  window: NativeHandle | undefined;
  stopRequested: boolean;
  destroyed: boolean;
}

/**
 * Starts the tray pump on the calling thread.
 *
 * Resolves once the icon is registered with Explorer. From then on the caller
 * owns the loop's liveness: it must not block the thread for long, or clicks
 * queue up in the message queue unseen.
 */
export async function startTrayPump(options: TrayPumpOptions): Promise<TrayPumpHandle> {
  const { user32, shell32, kernel32 } = getWin32();

  const moduleHandle = toHandle(kernel32.GetModuleHandleW(null));
  if (moduleHandle === undefined) throw new Error("GetModuleHandleW returned NULL");

  const state: PumpState = { window: undefined, stopRequested: false, destroyed: false };

  const windowProc = new JSCallback(
    (hWnd: NativeHandle, message: number, wParam: bigint, lParam: bigint): bigint => {
      // WM_NCCREATE must return TRUE or Windows aborts creation and
      // CreateWindowExW fails with GetLastError() == 0.
      if (message === WM_NCCREATE) return 1n;
      if (message === TRAY_CALLBACK_MESSAGE) {
        // Classic (pre-version-4) tray callback: lParam carries the mouse
        // message, wParam carries the icon id. The icon id is always 1 here.
        void wParam;
        const event = decodeTrayEvent(Number(lParam & 0xffffn));
        const window = state.window;
        if (window === undefined) return 0n;
        if (event === "context") {
          const chosen = showContextMenu(window);
          if (isTrayCommandId(chosen)) options.onCommand(chosen);
          return 0n;
        }
        if (event === "activate") {
          options.onLeftClick?.();
          return 0n;
        }
        return 0n;
      }
      if (message === WM_DESTROY) {
        // PostQuitMessage makes the next PeekMessageW hand back WM_QUIT, which
        // is the loop's exit signal. A destroyed window cannot be reused, so the
        // teardown must not call DestroyWindow a second time.
        state.destroyed = true;
        user32.PostQuitMessage(0);
        return 0n;
      }
      return user32.DefWindowProcW(hWnd, message, wParam, lParam);
    },
    { args: ["ptr", "u32", "u64", "i64"], returns: "i64" },
  );
  callbackKeepAlive.push(windowProc);

  classSequence += 1;
  const className = wideString(`LianRouterTrayHostWindow${classSequence}`);
  const windowClass = Buffer.alloc(WNDCLASSEXW_SIZE);
  const classView = new DataView(windowClass.buffer, windowClass.byteOffset, windowClass.byteLength);
  classView.setUint32(0, WNDCLASSEXW_SIZE, true);
  classView.setUint32(4, CS_HREDRAW | CS_VREDRAW, true);
  classView.setBigUint64(8, BigInt(windowProc.ptr ?? 0), true);
  // The same hInstance must reach CreateWindowExW; a mismatch fails the create
  // with ERROR_CLASS_DOES_NOT_EXIST (1407).
  classView.setBigUint64(24, moduleHandle, true);
  classView.setBigUint64(64, BigInt(ptr(className)), true);

  const atom = user32.RegisterClassExW(ptr(windowClass));
  if (atom === 0) {
    throw new Error(`RegisterClassExW failed (GetLastError=${kernel32.GetLastError()})`);
  }

  const title = wideString(WINDOW_TITLE);
  // A message-only window (HWND_MESSAGE) cannot own a tray icon, so this is a
  // normal hidden window: no WS_VISIBLE, zero size, no parent.
  const window = toHandle(
    user32.CreateWindowExW(0, ptr(className), ptr(title), WS_OVERLAPPED, 0, 0, 0, 0, null, null, moduleHandle, null),
  );
  if (window === undefined) {
    user32.UnregisterClassW(ptr(className), moduleHandle);
    throw new Error(`CreateWindowExW failed (GetLastError=${kernel32.GetLastError()})`);
  }
  state.window = window;

  const icon = resolveTrayIconHandle(options.iconPath);
  const notifyData = buildNotifyIconData(window, icon ?? 0n, options.tooltip);
  if (shell32.Shell_NotifyIconW(NIM_ADD, ptr(notifyData)) === 0) {
    destroyTrayIcon(icon);
    user32.DestroyWindow(window);
    user32.UnregisterClassW(ptr(className), moduleHandle);
    state.window = undefined;
    throw new Error("Shell_NotifyIconW(NIM_ADD) failed");
  }

  const messageBuffer = Buffer.alloc(MSG_SIZE);
  const messageView = new DataView(messageBuffer.buffer, messageBuffer.byteOffset, messageBuffer.byteLength);

  const exited = (async (): Promise<void> => {
    try {
      for (;;) {
        if (user32.PeekMessageW(ptr(messageBuffer), null, 0, 0, PM_REMOVE) !== 0) {
          if (messageView.getUint32(MSG_MESSAGE_OFFSET, true) === WM_QUIT) break;
          user32.TranslateMessage(ptr(messageBuffer));
          user32.DispatchMessageW(ptr(messageBuffer));
          continue;
        }
        // The queue is empty. A stop request whose WM_CLOSE never made it into
        // the queue (PostMessageW refused it) must still end the loop.
        if (state.stopRequested) break;
        await Bun.sleep(PUMP_IDLE_MS);
      }
    } finally {
      shell32.Shell_NotifyIconW(NIM_DELETE, ptr(notifyData));
      destroyTrayIcon(icon);
      if (!state.destroyed) user32.DestroyWindow(window);
      user32.UnregisterClassW(ptr(className), moduleHandle);
      state.window = undefined;
    }
  })();

  // The loop is detached from the caller's stack; an exception inside it would
  // otherwise be an unhandled rejection that kills the process with no dialog.
  void exited.catch((error: unknown) => {
    showTrayError(error instanceof Error ? error.message : String(error));
  });

  options.onReady?.();

  return {
    windowHandle: window,
    exited,
    stop(): Promise<void> {
      if (!state.stopRequested) {
        state.stopRequested = true;
        requestTrayQuit(window);
      }
      return exited;
    },
    setTooltip(tooltip: string): void {
      const update = buildTooltipUpdate(window, tooltip);
      shell32.Shell_NotifyIconW(NIM_MODIFY, ptr(update));
    },
  };
}
