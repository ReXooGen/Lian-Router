/**
 * Guards that collapse one operator gesture into one action.
 *
 * A tray callback is not a reliable one-per-gesture signal. Some shells report a
 * single physical right-click through more than one mouse message, and a
 * double-click arrives as two plain `WM_LBUTTONUP` messages because the window
 * class omits `CS_DBLCLKS`. Each of those callbacks reaches the host as a
 * separate command, and a command that opens a browser tab opens one tab per
 * callback.
 *
 * Two guards live here, both pure and both clock-injected so the windows are
 * testable without sleeping:
 *
 * - {@link createCommandGuard} — for a command with a beginning and an end. It
 *   drops a duplicate that is still in flight *and* a duplicate that repeats
 *   inside the window after the first one finished. Both conditions matter,
 *   because a double-click's two callbacks may or may not overlap.
 * - {@link createRepeatSuppressor} — for an event with no completion (a menu
 *   opening). It only applies the window.
 */

/**
 * How long a repeat of the same command is treated as the same gesture.
 *
 * Longer than any plausible double-click interval, far shorter than the time
 * between two deliberate clicks on a tray menu.
 */
export const OPEN_CONSOLE_GUARD_MS = 1_500;

/**
 * How long after a popup menu closes a second context callback is still
 * considered part of the same click.
 *
 * The duplicate is queued behind the modal `TrackPopupMenu` and is dispatched
 * the instant the first one returns, so the real gap is milliseconds. A
 * deliberate second right-click after dismissing a menu cannot happen this fast.
 */
export const MENU_REOPEN_GUARD_MS = 300;

export interface CommandGuard {
  /**
   * Runs `action` unless this invocation is a duplicate, and reports whether it
   * ran. The in-flight claim is released in `finally`, so a throwing action
   * cannot wedge the guard shut; the window still rejects a repeat that lands
   * immediately afterwards.
   */
  run(command: number, action: () => Promise<void>): Promise<boolean>;
}

/** Creates an independent guard. State is per instance, so tests never share it. */
export function createCommandGuard(windowMs: number, now: () => number): CommandGuard {
  const inFlight = new Set<number>();
  const lastStartedAt = new Map<number, number>();

  return {
    async run(command: number, action: () => Promise<void>): Promise<boolean> {
      if (inFlight.has(command)) return false;
      const last = lastStartedAt.get(command);
      // A clock that moved backwards makes the elapsed time negative, which is
      // below the window and therefore still a duplicate — the safe direction.
      if (last !== undefined && now() - last < windowMs) return false;
      inFlight.add(command);
      lastStartedAt.set(command, now());
      try {
        await action();
      } finally {
        inFlight.delete(command);
      }
      return true;
    },
  };
}

export interface RepeatSuppressor {
  /** `true` when this occurrence is the first inside the window. */
  allow(): boolean;
}

/** Creates a suppressor for an event that has no completion to release. */
export function createRepeatSuppressor(windowMs: number, now: () => number): RepeatSuppressor {
  let last = Number.NEGATIVE_INFINITY;
  return {
    allow(): boolean {
      const at = now();
      if (at - last < windowMs) return false;
      last = at;
      return true;
    },
  };
}
