/**
 * Win32 FFI bindings, tray icon primitives, and the error dialog.
 *
 * # Where the message pump went
 *
 * `Shell_NotifyIconW` registers an icon owned by a window, and that window only
 * lives while its message queue is being drained. `GetMessageW` blocks its
 * thread, and a blocked thread cannot run JavaScript: measured on Bun 1.4.2 /
 * Windows, an FFI call that blocks for 2 s leaves a pending `fetch` unresolved
 * for the whole 2 s. That rules out a pump sharing a thread with the control
 * HTTP calls.
 *
 * A Worker is not the answer either: `RegisterClassExW` returns 0 with
 * `ERROR_INVALID_PARAMETER` when called from a Worker in this runtime, so the
 * pump cannot be moved off the main thread. The pump therefore lives in
 * `pump.ts` and polls with `PeekMessageW(..., PM_REMOVE)` between
 * `await Bun.sleep(8)` turns, which keeps the event loop free for `fetch` on
 * the same thread. This module owns only the FFI signatures and the icon
 * plumbing that both the pump and `icon.ts` build on.
 *
 * # Callback lifetime
 *
 * `JSCallback` allocates a native trampoline that Win32 stores as the window
 * procedure — a raw function pointer. If JavaScript garbage-collects the
 * `JSCallback`, the trampoline is freed while `user32` still holds the address,
 * and the next message jumps into freed memory and kills the process with no
 * catchable error. `pump.ts` keeps every callback it creates in a module-level
 * array for the process lifetime; nothing here may create one in a local scope.
 */

import { dlopen, ptr, toBuffer } from "bun:ffi";
import type { Pointer } from "bun:ffi";

// ─── Constants ──────────────────────────────────────────────────────────────

const WM_CLOSE = 0x0010;

const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x0010;

const MB_OK = 0x00000000;
const MB_ICONERROR = 0x00000010;

/** `SM_CXSMICON`: the notification-area icon width for the current DPI. */
const SM_CXSMICON = 49;

// ─── Struct layouts (x64) ───────────────────────────────────────────────────

/** `ICONINFO`: fIcon@0, xHotspot@4, yHotspot@8, hbmMask@16, hbmColor@24. 32 bytes. */
const ICONINFO_SIZE = 32;

/** `BITMAPINFOHEADER`, 40 bytes. */
const BITMAPINFOHEADER_SIZE = 40;

const DIB_RGB_COLORS = 0;

// ─── Lazy library loading ───────────────────────────────────────────────────

/**
 * Signatures are declared exactly as the Win32 prototypes in the SDK:
 * pointer-sized handles are `ptr`, `LRESULT`/`LPARAM`/`WPARAM` are 64-bit on
 * x64, and `BOOL` returns are `i32` because Win32 defines `BOOL` as a signed int
 * (a failed call can return -1, which a `bool`/`u32` binding would misreport).
 *
 * Bun's `dlopen` has no symbol-alias field, so every name here is the real
 * export name.
 */
function openUser32() {
  return dlopen("user32.dll", {
    RegisterClassExW: { args: ["ptr"], returns: "u16" },
    UnregisterClassW: { args: ["ptr", "ptr"], returns: "i32" },
    CreateWindowExW: {
      args: ["u32", "ptr", "ptr", "u32", "i32", "i32", "i32", "i32", "ptr", "ptr", "ptr", "ptr"],
      returns: "ptr",
    },
    DefWindowProcW: { args: ["ptr", "u32", "u64", "i64"], returns: "i64" },
    DestroyWindow: { args: ["ptr"], returns: "i32" },
    PeekMessageW: { args: ["ptr", "ptr", "u32", "u32", "u32"], returns: "i32" },
    TranslateMessage: { args: ["ptr"], returns: "i32" },
    DispatchMessageW: { args: ["ptr"], returns: "i64" },
    PostQuitMessage: { args: ["i32"], returns: "void" },
    PostMessageW: { args: ["ptr", "u32", "u64", "i64"], returns: "i32" },
    SetForegroundWindow: { args: ["ptr"], returns: "i32" },
    GetCursorPos: { args: ["ptr"], returns: "i32" },
    CreatePopupMenu: { args: [], returns: "ptr" },
    AppendMenuW: { args: ["ptr", "u32", "u64", "ptr"], returns: "i32" },
    TrackPopupMenu: { args: ["ptr", "u32", "i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
    DestroyMenu: { args: ["ptr"], returns: "i32" },
    LoadImageW: { args: ["ptr", "ptr", "u32", "i32", "i32", "u32"], returns: "ptr" },
    LoadIconW: { args: ["ptr", "ptr"], returns: "ptr" },
    CreateIconIndirect: { args: ["ptr"], returns: "ptr" },
    DestroyIcon: { args: ["ptr"], returns: "i32" },
    GetDC: { args: ["ptr"], returns: "ptr" },
    ReleaseDC: { args: ["ptr", "ptr"], returns: "i32" },
    GetSystemMetrics: { args: ["i32"], returns: "i32" },
    MessageBoxW: { args: ["ptr", "ptr", "ptr", "u32"], returns: "i32" },
  } as const);
}

function openShell32() {
  return dlopen("shell32.dll", {
    Shell_NotifyIconW: { args: ["u32", "ptr"], returns: "i32" },
  } as const);
}

function openKernel32() {
  return dlopen("kernel32.dll", {
    GetModuleHandleW: { args: ["ptr"], returns: "ptr" },
    GetLastError: { args: [], returns: "u32" },
  } as const);
}

function openGdi32() {
  return dlopen("gdi32.dll", {
    CreateCompatibleDC: { args: ["ptr"], returns: "ptr" },
    DeleteDC: { args: ["ptr"], returns: "i32" },
    CreateDIBSection: { args: ["ptr", "ptr", "u32", "ptr", "ptr", "u32"], returns: "ptr" },
    SelectObject: { args: ["ptr", "ptr"], returns: "ptr" },
    DeleteObject: { args: ["ptr"], returns: "i32" },
  } as const);
}

/** An argument position declared `ptr` in the FFI table. */
type PtrArg = Pointer | NodeJS.TypedArray | bigint | null;

/** A `ptr` return, which Bun reports as a `Pointer`, a `bigint`, or NULL. */
type PtrReturn = Pointer | bigint | null;

export interface User32Api {
  RegisterClassExW(classStruct: PtrArg): number;
  UnregisterClassW(className: PtrArg, instance: PtrArg): number;
  CreateWindowExW(
    exStyle: number,
    className: PtrArg,
    windowName: PtrArg,
    style: number,
    x: number,
    y: number,
    width: number,
    height: number,
    parent: PtrArg,
    menu: PtrArg,
    instance: PtrArg,
    param: PtrArg,
  ): PtrReturn;
  DefWindowProcW(window: PtrArg, message: number, wParam: bigint, lParam: bigint): bigint;
  DestroyWindow(window: PtrArg): number;
  PeekMessageW(message: PtrArg, window: PtrArg, filterMin: number, filterMax: number, removeMsg: number): number;
  TranslateMessage(message: PtrArg): number;
  DispatchMessageW(message: PtrArg): bigint;
  PostQuitMessage(exitCode: number): void;
  PostMessageW(window: PtrArg, message: number, wParam: bigint, lParam: bigint): number;
  SetForegroundWindow(window: PtrArg): number;
  GetCursorPos(point: PtrArg): number;
  CreatePopupMenu(): PtrReturn;
  AppendMenuW(menu: PtrArg, flags: number, itemId: bigint, item: PtrArg): number;
  TrackPopupMenu(
    menu: PtrArg,
    flags: number,
    x: number,
    y: number,
    reserved: number,
    window: PtrArg,
    rect: PtrArg,
  ): number;
  DestroyMenu(menu: PtrArg): number;
  LoadImageW(instance: PtrArg, name: PtrArg, type: number, cx: number, cy: number, load: number): PtrReturn;
  LoadIconW(instance: PtrArg, name: PtrArg): PtrReturn;
  CreateIconIndirect(info: PtrArg): PtrReturn;
  DestroyIcon(icon: PtrArg): number;
  GetDC(window: PtrArg): PtrReturn;
  ReleaseDC(window: PtrArg, deviceContext: PtrArg): number;
  GetSystemMetrics(index: number): number;
  MessageBoxW(window: PtrArg, text: PtrArg, caption: PtrArg, type: number): number;
}

export interface Shell32Api {
  Shell_NotifyIconW(message: number, data: PtrArg): number;
}

export interface Kernel32Api {
  GetModuleHandleW(moduleName: PtrArg): PtrReturn;
  GetLastError(): number;
}

export interface Gdi32Api {
  CreateCompatibleDC(deviceContext: PtrArg): PtrReturn;
  DeleteDC(deviceContext: PtrArg): number;
  CreateDIBSection(
    deviceContext: PtrArg,
    header: PtrArg,
    usage: number,
    bits: PtrArg,
    section: PtrArg,
    offset: number,
  ): PtrReturn;
  SelectObject(deviceContext: PtrArg, object: PtrArg): PtrReturn;
  DeleteObject(object: PtrArg): number;
}

export interface Win32Api {
  readonly user32: User32Api;
  readonly shell32: Shell32Api;
  readonly kernel32: Kernel32Api;
  readonly gdi32: Gdi32Api;
}

let api: Win32Api | undefined;

/**
 * Loads the Win32 libraries once per process.
 *
 * Called lazily so importing this module on Linux or macOS — where the CLI's
 * own typecheck and test runs live — never touches `user32.dll`.
 */
export function getWin32(): Win32Api {
  if (api === undefined) {
    api = {
      user32: openUser32().symbols,
      shell32: openShell32().symbols,
      kernel32: openKernel32().symbols,
      gdi32: openGdi32().symbols,
    };
  }
  return api;
}

// ─── Handles ────────────────────────────────────────────────────────────────

/**
 * A Win32 handle carried as a 64-bit integer.
 *
 * Bun types every `ptr` return as `Pointer | bigint | null`, so a `bigint` is
 * the one representation that survives every signature without a cast: it is a
 * legal `ptr` argument and it is exact for the sign-extended 32-bit user
 * handles Windows actually hands out.
 */
export type NativeHandle = bigint;

/** Narrows an FFI pointer return, treating NULL as "no handle". */
export function toHandle(value: Pointer | bigint | null | undefined): NativeHandle | undefined {
  if (value === null || value === undefined) return undefined;
  const handle = typeof value === "bigint" ? value : BigInt(value);
  return handle === 0n ? undefined : handle;
}

// ─── Wide strings ───────────────────────────────────────────────────────────

/** UTF-16LE buffer with the terminating NUL Win32 requires. */
export function wideString(value: string): Buffer {
  return Buffer.from(`${value}\u0000`, "utf16le");
}

/** Copies a string into a fixed-width UTF-16 field, always leaving a NUL. */
export function writeWideString(target: Buffer, byteOffset: number, maxChars: number, value: string): void {
  const encoded = Buffer.from(value, "utf16le");
  const bytes = Math.min(encoded.length, (maxChars - 1) * 2);
  encoded.copy(target, byteOffset, 0, bytes);
}

// ─── Dialogs ────────────────────────────────────────────────────────────────

/**
 * Shows a modal error dialog. Used for failures that must not be silent: a tray
 * whose menu does nothing is indistinguishable from a frozen gateway.
 */
export function showTrayError(message: string, caption = "LianRouter"): void {
  const { user32 } = getWin32();
  user32.MessageBoxW(null, ptr(wideString(message)), ptr(wideString(caption)), MB_OK | MB_ICONERROR);
}

/**
 * Asks the pump's window to close.
 *
 * `PostMessageW` queues on the window's owning thread, where `DefWindowProcW`
 * turns `WM_CLOSE` into `DestroyWindow`, which raises `WM_DESTROY`, which ends
 * the loop. Safe to call from any thread, including inside the window procedure.
 */
export function requestTrayQuit(windowHandle: NativeHandle): void {
  const { user32 } = getWin32();
  user32.PostMessageW(windowHandle, WM_CLOSE, 0n, 0n);
}

// ─── Icon resolution ────────────────────────────────────────────────────────

/** `IDI_APPLICATION`, a resource id encoded as a pointer, per Win32 convention. */
const IDI_APPLICATION = 32512n;

/**
 * Builds the tray icon at runtime.
 *
 * Declared here rather than imported from `icon.ts` to keep the module graph
 * acyclic: `icon.ts` imports the GDI primitives from this module, so this
 * module cannot import `icon.ts`.
 */
let createTrayIcon: () => NativeHandle | undefined = () => undefined;

/** Installs the runtime icon factory. Called by `icon.ts` when it loads. */
export function registerTrayIconFactory(factory: () => NativeHandle | undefined): void {
  createTrayIcon = factory;
}

/**
 * Resolves the tray icon: a shipped `.ico` when present, otherwise the drawn
 * mark, otherwise the stock application icon.
 *
 * The fallbacks exist because a packaged build may not carry assets and a
 * missing icon must not stop the tray from appearing — `Shell_NotifyIconW`
 * accepts a null `hIcon` and shows a blank slot, which is worse than a plain
 * glyph but better than no menu at all.
 */
export function resolveTrayIconHandle(iconPath: string | undefined): NativeHandle | undefined {
  const { user32 } = getWin32();
  if (iconPath !== undefined) {
    const loaded = loadIconFile(iconPath);
    if (loaded !== undefined) return loaded;
  }
  const drawn = createTrayIcon();
  if (drawn !== undefined) return drawn;
  return toHandle(user32.LoadIconW(null, IDI_APPLICATION));
}

/** Frees a tray icon handle produced by the factory or `LoadImageW`. */
export function destroyTrayIcon(handle: NativeHandle | undefined): void {
  if (handle === undefined) return;
  const { user32 } = getWin32();
  user32.DestroyIcon(handle);
}

/** Loads an icon from a `.ico` file, or `undefined` when the path is unusable. */
export function loadIconFile(iconPath: string): NativeHandle | undefined {
  const { user32 } = getWin32();
  return toHandle(user32.LoadImageW(null, ptr(wideString(iconPath)), IMAGE_ICON, 0, 0, LR_LOADFROMFILE));
}

/** Notification-area icon size for the current DPI; 0 when the metric is unavailable. */
export function systemSmallIconSize(): number {
  const { user32 } = getWin32();
  return user32.GetSystemMetrics(SM_CXSMICON);
}

// ─── Icon construction primitives (used by icon.ts) ─────────────────────────

export interface DibSection {
  /** The `HBITMAP`, owned by the caller and freed with `deleteBitmap`. */
  readonly bitmap: NativeHandle;
  /** Writable view over the raw pixels, in reading order. */
  readonly pixels: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Creates a top-down DIB section.
 *
 * A negative `biHeight` selects top-down row order, so `pixels` is laid out in
 * reading order (row 0 first) instead of Windows' default bottom-up. For 32-bit
 * sections the alpha channel is what makes the tray icon blend against the
 * taskbar instead of showing a black box; the 1-bit form is only used for the
 * mask, which `CreateIconIndirect` requires but ignores when alpha is present.
 */
export function createDibSection(width: number, height: number, bitsPerPixel: 32 | 1): DibSection {
  const { user32, gdi32 } = getWin32();

  const header = Buffer.alloc(BITMAPINFOHEADER_SIZE);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(0, BITMAPINFOHEADER_SIZE, true);
  view.setInt32(4, width, true);
  view.setInt32(8, -height, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, bitsPerPixel, true);
  view.setUint32(16, 0, true);
  const rowBytes = bitsPerPixel === 32 ? width * 4 : Math.ceil(width / 8 / 4) * 4;
  view.setUint32(20, rowBytes * height, true);

  // CreateDIBSection writes the pixel base address through this out-parameter.
  const out = Buffer.alloc(8);
  const deviceContext = toHandle(user32.GetDC(null));
  if (deviceContext === undefined) throw new Error("GetDC(NULL) returned NULL");
  let bitmap: NativeHandle | undefined;
  try {
    bitmap = toHandle(gdi32.CreateDIBSection(deviceContext, ptr(header), DIB_RGB_COLORS, ptr(out), null, 0));
  } finally {
    user32.ReleaseDC(null, deviceContext);
  }
  if (bitmap === undefined) throw new Error("CreateDIBSection failed");

  const address = new DataView(out.buffer, out.byteOffset, out.byteLength).getBigUint64(0, true);
  return { bitmap, pixels: toBuffer(address, 0, rowBytes * height), width, height };
}

/**
 * Wraps a colour bitmap and its mask into an `HICON`.
 *
 * The mask is still required by `CreateIconIndirect` even for 32-bit ARGB icons
 * — Windows ignores it when the colour bitmap carries alpha, but a null mask
 * makes the call fail. `CreateIconIndirect` copies both bitmaps, so the caller
 * frees them afterwards.
 */
export function createIconFromBitmaps(color: NativeHandle, mask: NativeHandle): NativeHandle | undefined {
  const { user32 } = getWin32();
  const info = Buffer.alloc(ICONINFO_SIZE);
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
  view.setInt32(0, 1, true); // fIcon = TRUE
  view.setBigUint64(16, mask, true);
  view.setBigUint64(24, color, true);
  return toHandle(user32.CreateIconIndirect(ptr(info)));
}

/** Releases a GDI bitmap. */
export function deleteBitmap(bitmap: NativeHandle | undefined): void {
  if (bitmap === undefined) return;
  const { gdi32 } = getWin32();
  gdi32.DeleteObject(bitmap);
}
