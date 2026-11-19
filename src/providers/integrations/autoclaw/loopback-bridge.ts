import { AUTOCLAW_OAUTH_REDIRECT_URI } from "./oauth";

/**
 * Local loopback receiver for the AutoClaw browser login.
 *
 * The vendor's client registration pins the redirect to the shipped desktop
 * app's server (`http://localhost:18432/auth/callback-zai`). When the desktop
 * app is not running, the browser lands on a dead port and the login code dies
 * with it — the operator would have to copy the dead tab's URL and paste it
 * back into the dashboard. This bridge closes that gap: it listens on the
 * registered loopback, forwards `code`+`state` to the gateway's own completion
 * endpoint, and shows a page that closes itself.
 *
 * The bridge holds no credential and no store: it can only complete a login
 * whose `state` the gateway itself minted, which is the same authority the
 * paste-the-URL flow already has. A desktop app already listening on the port
 * wins — starting the bridge then simply fails and the paste flow remains.
 */

/** Result of an idempotent bridge start attempt. */
export interface LoopbackBridgeStart {
  readonly started: boolean;
  /** The bound port; absent when `started` is false and unknown before bind. */
  readonly port?: number;
  /** Why the bridge is not listening; absent when `started`. */
  readonly reason?: string;
}

interface BridgeState {
  readonly stop: () => void;
  readonly port: number;
}


let bridge: BridgeState | undefined;

const SUCCESS_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Account connected</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #0b0b0c; color: #e7e7ea;
             display: grid; place-items: center; min-height: 90vh; margin: 0; }
      main { text-align: center; }
      h1 { font-size: 1.1rem; }
      p { color: #9a9aa2; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>AutoClaw account connected</h1>
      <p>You can close this window and return to the dashboard.</p>
      <script>setTimeout(() => window.close(), 1200);</script>
    </main>
  </body>
</html>`;

function page(title: string, message: string): string {
  return SUCCESS_PAGE.replace("Account connected", title).replace(
    "You can close this window and return to the dashboard.",
    message,
  );
}

/**
 * Starts the loopback receiver once per process. Later calls are no-ops while
 * a bridge already listens; a failed start (desktop app holding the port, or a
 * platform without Bun.serve) keeps the paste-the-URL fallback usable.
 */
export function startAutoClawLoopbackBridge(options: {
  /** Origin of this gateway, e.g. `http://localhost:12800`. */
  readonly gatewayOrigin: string;
  readonly fetchFn?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  readonly port?: number;
}): LoopbackBridgeStart {
  if (bridge !== undefined) return { started: true, port: bridge.port };
  const fetchFn = options.fetchFn ?? fetch;
  const port = options.port ?? 18432;
  const completeUrl = `${options.gatewayOrigin.replace(/\/+$/, "")}/console/api/providers/autoclaw/oauth/complete`;
  try {
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname !== "/auth/callback-zai") {
          return new Response(page("Not the redirect target", "This port only serves the AutoClaw login callback."), {
            status: 404,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          return new Response(
            page("Login incomplete", "The callback carried no code. Start the login again from the dashboard."),
            { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
        try {
          const response = await fetchFn(completeUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, state }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) {
            const detail = (await response.text().catch(() => "")).slice(0, 200);
            return new Response(
              page("Login failed", detail.length > 0 ? detail : `The exchange failed (${response.status}).`),
              { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
            );
          }
          return new Response(SUCCESS_PAGE, {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "The exchange failed.";
          return new Response(page("Login failed", message), {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
      },
    });
    const boundPort = server.port ?? port;
    bridge = { stop: () => server.stop(true), port: boundPort };
    return { started: true, port: boundPort };
  } catch (error) {
    const reason =
      error instanceof Error && error.message.includes("EADDRINUSE")
        ? `${AUTOCLAW_OAUTH_REDIRECT_URI} is already served (AutoClaw desktop app running). Finish the login there or paste the callback URL in the dashboard.`
        : error instanceof Error
          ? `Loopback bridge unavailable: ${error.message}`
          : "Loopback bridge unavailable.";
    return { started: false, reason };
  }
}

/** Test-only: stops the bridge and resets the singleton. */
export function stopAutoClawLoopbackBridge(): void {
  bridge?.stop();
  bridge = undefined;
}
