/**
 * The tray's command vocabulary.
 *
 * The popup menu and the host share these ids, and nothing else: the pump is a
 * non-blocking loop on the host's own thread (`pump.ts`), so there is no worker
 * channel to narrow. A click reaches the host as a direct callback, which is
 * why this module holds ids rather than a message protocol.
 *
 * `toggle` is the Stop/Start Server row: the label flips with the gateway's
 * state, but the id stays constant so the host resolves what to do from the
 * state it already holds. A click on "Stop Server" that lands after the gateway
 * stopped — because the state changed while the menu was open — is a start, not
 * a second stop, which is what per-label ids would have made it.
 */

export const TRAY_COMMANDS = {
  openConsole: 1,
  restart: 2,
  toggle: 3,
  checkUpdate: 4,
  exit: 5,
} as const;

export type TrayCommandId = (typeof TRAY_COMMANDS)[keyof typeof TRAY_COMMANDS];
