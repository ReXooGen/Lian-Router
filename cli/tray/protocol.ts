/**
 * The tray's command vocabulary.
 *
 * The popup menu and the host share these ids, and nothing else: the pump is a
 * non-blocking loop on the host's own thread (`pump.ts`), so there is no worker
 * channel to narrow. A click reaches the host as a direct callback, which is
 * why this module holds ids rather than a message protocol.
 */

/** Menu command ids, matching the popup menu built by the pump. */
export const TRAY_COMMANDS = {
  openConsole: 1,
  restart: 2,
  stop: 3,
  checkUpdate: 4,
  exit: 5,
} as const;

export type TrayCommandId = (typeof TRAY_COMMANDS)[keyof typeof TRAY_COMMANDS];
