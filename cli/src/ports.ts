/**
 * Port availability, asked *before* a gateway is spawned.
 *
 * # Why a pre-flight is not redundant with `EADDRINUSE`
 *
 * The gateway calls `app.listen({ port, reusePort: true })` so that several
 * workers, or a second process, can share the listener on platforms that
 * support `SO_REUSEPORT`. On Windows that flag makes a genuine conflict
 * **invisible**: two separate processes both bind `:12800` successfully and the
 * kernel gives every connection to the one that bound first. Measured on Bun
 * 1.4.2 / win32 — process A and process B both printed "bound 46010", and four
 * consecutive requests all reached A. A second install root therefore boots a
 * gateway that never receives a request, while the launcher's health wait
 * succeeds against *the other* process.
 *
 * # Why a connect probe and not a bind probe
 *
 * A bind probe cannot see this. On Windows, `SO_REUSEPORT` also makes the port
 * bindable by a *plain* listener, so `Bun.serve({ port })` without the flag
 * succeeds against a gateway that is holding the port with it — measured, and
 * the reason this module does not bind at all. A connect probe asks the only
 * question with a stable answer: does something already accept TCP connections
 * here.
 *
 * # What "busy" means for the caller
 *
 * `adoptExisting()` has already run and failed, so any listener on this port is
 * not the gateway this launcher owns: it is another install root, a stray
 * gateway whose pid file was stale, or an unrelated program. All three are cases
 * where spawning a second gateway produces a silent split brain, so the caller
 * reports the conflict and names a free neighbour.
 */

/** How many consecutive ports {@link findFreePort} will try before giving up. */
const DEFAULT_SCAN_ATTEMPTS = 20;



/**
 * True when something accepts TCP connections on `port`.
 *
 * A refused connection is the free-port answer and resolves immediately; the
 * timeout only bounds the pathological case where the kernel neither accepts nor
 * refuses. Either failure means the port is not free for a gateway, because a
 * half-open listener is not a listener a launcher can take over.
 */
export async function isPortBusy(port: number): Promise<boolean> {
  let socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  try {
    socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data() {},
        close() {},
        error() {},
        connectError() {},
      },
    });
    return true;
  } catch {
    return false;
  } finally {
    socket?.end();
  }
}

/**
 * First free port at or above `start`, or `undefined` when every candidate in
 * the window is taken.
 *
 * Walking upward is what makes the suggestion in the error message useful — the
 * operator reads "pass `--port 12801`" and that number is actually free at the
 * moment it was printed. It is a suggestion, not an action: the launcher never
 * moves itself to a different port behind the operator's back, because the
 * console URL is bookmarked, reverse-proxied, and pasted into other tools.
 */
export async function findFreePort(
  start: number,
  attempts: number = DEFAULT_SCAN_ATTEMPTS,
): Promise<number | undefined> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = start + offset;
    if (candidate > 65_535) {
      return undefined;
    }
    if (!(await isPortBusy(candidate))) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * The message a busy default port produces.
 *
 * Three parts, because the operator can act on three different things: which
 * port, whether a free alternative exists, and how to use it. The old message
 * only appeared when the child happened to print `EADDRINUSE`, which on Windows
 * it does not.
 */
export function describePortConflict(port: number, suggestion: number | undefined): string {
  const base = `port ${port} is already in use; stop the other process or pass --port`;
  if (suggestion === undefined) {
    return `${base} (no free port in the next ${DEFAULT_SCAN_ATTEMPTS})`;
  }
  return `${base} ${suggestion}`;
}
