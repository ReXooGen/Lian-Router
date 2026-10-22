/**
 * Antigravity loopback helper: Python + bash scripts the console hands out
 * to a logged-in operator so their own machine can host the OAuth callback
 * Google's "Desktop" OAuth client type requires (`http://127.0.0.1:<port>/`).
 *
 * The scripts are plain text files embedded as module constants so route
 * handlers can serve them with `Content-Type: text/x-python` /
 * `text/x-shellscript` without a filesystem read. The console returns the
 * API base URL + bearer and the `state`/`codeVerifier`/`clientId`/`scope`
 * tuple from `/oauth/loopback/start`; the Python script does the rest.
 */

/**
 * Python helper. Runs on operator's machine. Flow:
 *   1. Pick a random loopback port, start a one-shot HTTP server.
 *   2. Build the authorize URL using `clientId`, `scope`, `codeChallenge`,
 *      `extra` returned by the server, plus the loopback redirect URI.
 *   3. Open the system browser.
 *   4. On callback, extract `code`, POST it + the loopback URI + `state`
 *      back to the console's `/oauth/loopback/complete` endpoint.
 *   5. Print the saved account id.
 *
 * The script trusts stdin JSON for the credentials — the operator pastes
 * it after copying from the dashboard, so there is nothing on the command
 * line (which `ps` could show) and nothing on disk.
 */
export const ANTIGRAVITY_LOOPBACK_PYTHON = `#!/usr/bin/env python3
"""Antigravity loopback OAuth helper, served by the LianRouter console.

Usage (dashboard will show the exact command):

    curl -fsSL "https://your-router/console/api/providers/antigravity/oauth/helper.py" \\
      | python3 - <<'JSON'
    {
      "console": "https://your-router",
      "providerId": "antigravity",
      "accountLabel": "my-account@gmail.com",
      "state": "...",
      "codeChallenge": "...",
      "clientId": "...",
      "scope": "...",
      "authorizeBase": "https://accounts.google.com/o/oauth2/v2/auth",
      "extra": {"access_type": "offline", "prompt": "consent"}
    }
    JSON
"""
import http.server
import json
import socket
import socketserver
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser


SUCCESS_PAGE = b"""<!doctype html>
<html><head><meta charset="utf-8"><title>Antigravity login</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#e5e5e5}
.card{text-align:center;padding:2rem 3rem;background:#1b1b1b;border-radius:10px;border:1px solid #2a2a2a}
h1{margin:0 0 .5rem;color:#4ade80}p{margin:0;color:#999}</style></head>
<body><div class="card"><h1>Signed in</h1><p>You can close this tab.</p></div></body></html>"""


def _die(msg: str, exit_code: int = 1) -> None:
    sys.stderr.write(f"error: {msg}\\n")
    sys.exit(exit_code)


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _read_config() -> dict:
    raw = sys.stdin.read().strip()
    if not raw:
        _die("stdin is empty — pass the JSON blob the dashboard printed")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        _die(f"stdin is not valid JSON: {e}")
    required = ("console", "providerId", "state", "codeChallenge",
                "clientId", "scope", "authorizeBase")
    for key in required:
        if not isinstance(data.get(key), str) or not data[key]:
            _die(f"config missing required string field: {key}")
    if not isinstance(data.get("extra", {}), dict):
        _die("config.extra must be an object")
    return data


class _CaptureHandler(http.server.BaseHTTPRequestHandler):
    captured: dict | None = None

    def do_GET(self):  # noqa: N802 — stdlib signature
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path not in ("/callback", "/"):
            self.send_response(404)
            self.end_headers()
            return
        params = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
        type(self).captured = params
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(SUCCESS_PAGE)))
        self.end_headers()
        self.wfile.write(SUCCESS_PAGE)

    def log_message(self, *args, **kwargs):  # suppress default access log
        return


def _wait_for_callback(server: socketserver.TCPServer, timeout_s: int = 300) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if _CaptureHandler.captured is not None:
            return _CaptureHandler.captured
        server.handle_request()
        if _CaptureHandler.captured is not None:
            return _CaptureHandler.captured
    _die("timed out waiting for Google callback (5 minutes)")
    return {}  # unreachable


def _post_complete(console: str, provider_id: str, payload: dict) -> dict:
    url = f"{console.rstrip('/')}/console/api/providers/{provider_id}/oauth/loopback/complete"
    req = urllib.request.Request(
        url,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
        data=json.dumps(payload).encode(),
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        _die(f"complete-loopback returned {e.code}: {body[:800]}")
    except Exception as e:  # noqa: BLE001 — surface any transport error
        _die(f"complete-loopback failed: {e}")
    try:
        return json.loads(body)
    except Exception:  # noqa: BLE001
        _die(f"complete-loopback returned non-JSON: {body[:800]}")
        return {}  # unreachable


def main() -> None:
    cfg = _read_config()
    port = _free_loopback_port()
    redirect_uri = f"http://127.0.0.1:{port}/callback"

    params = {
        "client_id": cfg["clientId"],
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": cfg["scope"],
        "state": cfg["state"],
        "code_challenge": cfg["codeChallenge"],
        "code_challenge_method": "S256",
    }
    for key, value in (cfg.get("extra") or {}).items():
        if isinstance(key, str) and isinstance(value, str):
            params[key] = value
    authorize_url = f"{cfg['authorizeBase']}?{urllib.parse.urlencode(params)}"

    sys.stderr.write(f"\\n[antigravity-login] loopback: {redirect_uri}\\n")
    sys.stderr.write(f"[antigravity-login] opening browser (if it does not open, visit the URL below):\\n")
    sys.stderr.write(f"{authorize_url}\\n\\n")
    try:
        webbrowser.open(authorize_url)
    except Exception:  # noqa: BLE001 — browser launch is best-effort
        pass

    class _Server(socketserver.TCPServer):
        allow_reuse_address = True

    with _Server(("127.0.0.1", port), _CaptureHandler) as server:
        server.timeout = 1
        callback = _wait_for_callback(server)

    if "error" in callback:
        _die(f"Google returned error: {callback.get('error')} {callback.get('error_description','')}")
    code = callback.get("code")
    state = callback.get("state")
    if not code or not state:
        _die(f"callback missing code or state: {callback}")
    if state != cfg["state"]:
        _die("callback state mismatch — restart the login flow")

    sys.stderr.write("[antigravity-login] got authorization code, finalising with console...\\n")
    result = _post_complete(cfg["console"], cfg["providerId"], {
        "state": state,
        "code": code,
        "redirectUri": redirect_uri,
    })
    account_id = result.get("accountId") or "(unknown)"
    email = result.get("email") or "(unknown)"
    sys.stderr.write(f"\\n[antigravity-login] ✓ account saved: id={account_id} email={email}\\n")
    sys.stdout.write(json.dumps(result, indent=2) + "\\n")


if __name__ == "__main__":
    main()
`;

/**
 * Bash wrapper: downloads the Python script and pipes the operator's JSON
 * config into it. Kept short enough to show as a copy-paste snippet in the
 * dashboard UI. Operator pastes the whole command — including the JSON
 * heredoc — into their terminal.
 */
export function antigravityLoopbackShellSnippet(args: {
  console: string;
  providerId: string;
  accountLabel: string;
  state: string;
  codeChallenge: string;
  codeVerifier: string;
  clientId: string;
  scope: string;
  authorizeBase: string;
  extra: Record<string, string>;
}): string {
  // The JSON goes through a bash heredoc so quoting is preserved as-is;
  // `python3 -` reads the script from stdin via a prior curl pipe would
  // conflict with the config heredoc, so the script is downloaded first
  // and the JSON is passed on a second stdin invocation.
  const configJson = JSON.stringify(
    {
      console: args.console,
      providerId: args.providerId,
      accountLabel: args.accountLabel,
      state: args.state,
      codeChallenge: args.codeChallenge,
      // `codeVerifier` is private to the console — DO NOT include in payload
      // the operator pastes. The console keeps it in Redis under `state` and
      // uses it during the complete-loopback exchange.
      clientId: args.clientId,
      scope: args.scope,
      authorizeBase: args.authorizeBase,
      extra: args.extra,
    },
    null,
    2,
  );
  const consoleOrigin = args.console.replace(/\/+$/, "");
  return [
    "set -e",
    `TMP=$(mktemp -d) && trap 'rm -rf "$TMP"' EXIT`,
    `curl -fsSL "${consoleOrigin}/console/api/providers/antigravity/oauth/helper.py" -o "$TMP/ag.py"`,
    `python3 "$TMP/ag.py" <<'ANTIGRAVITY_CONFIG_JSON'`,
    configJson,
    "ANTIGRAVITY_CONFIG_JSON",
  ].join("\n");
}
