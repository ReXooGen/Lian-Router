// Automation control-plane proxy.
//
// Proxies the loopback GrokFarm WebUI (FastAPI on 127.0.0.1:8092) under
// `/automation/*`. The route lives at the root rather than under
// `/console/api` because the WebUI's scripts call absolute paths
// (`fetch('/api/config')`) that a nested proxy path or `<base>` rewrite cannot
// capture; a root proxy keeps every upstream path byte-identical.
//
// Auth is manual per request through `resolveConsoleAccess` — the console
// router's session middleware only covers `/console/api/*`. Requests without a
 // valid console session get the console sign-in document served at
// `/console/login`, so an expired session behaves like any other dashboard
// navigation, not like a JSON 401 the iframe cannot act on.
//
// The upstream contract is trusted to be loopback-only; this proxy is the sole
// authenticated doorway. Response headers are sanitized: upstream CSP and
// frame headers would otherwise forbid the iframe embed the console page
// creates, and hop-by-hop headers are meaningless across the proxy boundary.

import { Elysia } from "elysia";
import { resolveConsoleAccess } from "../auth/session-resolver";
import type { ConsoleSessionService } from "../auth/service";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { API_CONTENT_SECURITY_POLICY, X_FRAME_OPTIONS } from "../../security/outbound-headers";

/** Headers never forwarded in either direction (connection-scoped). */
const HOP_BY_HOP_HEADERS: Readonly<Record<string, true>> = Object.freeze({
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  "proxy-connection": true,
  te: true,
  "transfer-encoding": true,
  upgrade: true,
});

/** Response headers the upstream must not impose on the console embed. */
const STRIPPED_RESPONSE_HEADERS: Readonly<Record<string, true>> = Object.freeze({
  ...HOP_BY_HOP_HEADERS,
  "content-security-policy": true,
  "content-security-policy-report-only": true,
  "x-frame-options": true,
  "content-encoding": true,
  "content-length": true,
});

const PROXY_TIMEOUT_MS = 30_000;
/** Matches FastAPI's body ceiling for the config PUT the WebUI performs. */
const PROXY_MAX_BODY_BYTES = 4 * 1024 * 1024;

function stripRequestHeaders(headers: Headers): Headers {
  const cleaned = new Headers();
  headers.forEach((value, name) => {
    if (HOP_BY_HOP_HEADERS[name.toLowerCase()]) return;
    // The console session cookie must never leak to the upstream process.
    if (name.toLowerCase() === "cookie") return;
    cleaned.set(name, value);
  });
  return cleaned;
}

export interface AutomationProxyConfig {
  readonly db: LianRouterDatabase;
  readonly sessionService: ConsoleSessionService;
  /** Base URL of the loopback control plane; empty string disables the proxy. */
  readonly upstream: string;
}

export function createAutomationProxy(config: AutomationProxyConfig): Elysia {
  const forward = async (request: Request, subpath: string): Promise<Response> => {
    const access = await resolveConsoleAccess(config.db, config.sessionService, request);
    if (!access) {
      // Serve the console SPA document path so the browser session flow takes
      // over: the iframe navigates to login and returns after sign-in.
      return new Response(null, {
        status: 302,
        headers: { location: "/console/login?returnTo=%2Fconsole%2Fautomation" },
      });
    }
    const upstreamUrl = `${config.upstream}${subpath}${new URL(request.url).search}`;
    const method = request.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    if (hasBody) {
      const length = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > PROXY_MAX_BODY_BYTES) {
        return Response.json(
          { error: "payload too large", code: "payload_too_large" },
          { status: 413, headers: { "content-security-policy": API_CONTENT_SECURITY_POLICY } },
        );
      }
    }
    const body: BodyInit | null = hasBody ? await request.arrayBuffer() : null;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method,
        headers: stripRequestHeaders(request.headers),
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
    } catch {
      return Response.json(
        { error: "automation service unreachable", code: "automation_unreachable" },
        { status: 502, headers: { "content-security-policy": API_CONTENT_SECURITY_POLICY } },
      );
    }
    const responseHeaders = new Headers();
    upstreamResponse.headers.forEach((value, name) => {
      if (STRIPPED_RESPONSE_HEADERS[name.toLowerCase()]) return;
      responseHeaders.set(name, value);
    });
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("x-content-type-options", "nosniff");
    // The iframe is same-origin, so scripts/styles from the upstream document
    // execute with the console origin's authority; a document-level CSP is
    // re-imposed here rather than trusting the upstream to set one.
    if ((responseHeaders.get("content-type") ?? "").includes("text/html")) {
      responseHeaders.set("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'");
    } else {
      responseHeaders.set("content-security-policy", API_CONTENT_SECURITY_POLICY);
      responseHeaders.set("x-frame-options", X_FRAME_OPTIONS);
    }
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  };

  // /automation strips its mount prefix (the upstream document is served at
  // "/"), but /api and /proxy-pool.* must reach the upstream with the path
  // intact — the upstream serves those at their literal paths
  // (`/api/status`, not `/status`).
  const automationRoutes = (prefix: string): Elysia =>
    new Elysia({ prefix })
      .get("/", ({ request }) => forward(request, "/"))
      .get("/*", ({ request, params }) => forward(request, `/${params["*"] ?? ""}`))
      .post("/", ({ request }) => forward(request, "/"))
      .post("/*", ({ request, params }) => forward(request, `/${params["*"] ?? ""}`))
      .put("/", ({ request }) => forward(request, "/"))
      .put("/*", ({ request, params }) => forward(request, `/${params["*"] ?? ""}`))
      .delete("/*", ({ request, params }) => forward(request, `/${params["*"] ?? ""}`)) as unknown as Elysia;

  const apiRoutes = (prefix: string): Elysia =>
    new Elysia({ prefix })
      .get("/*", ({ request, params }) => forward(request, `${prefix}/${params["*"] ?? ""}`))
      .post("/*", ({ request, params }) => forward(request, `${prefix}/${params["*"] ?? ""}`))
      .put("/*", ({ request, params }) => forward(request, `${prefix}/${params["*"] ?? ""}`))
      .delete("/*", ({ request, params }) => forward(request, `${prefix}/${params["*"] ?? ""}`)) as unknown as Elysia;

  // The WebUI document is served under /automation, but its scripts call
  // origin-absolute paths (`fetch('/api/config')`, `/proxy-pool.js`). Those
  // paths would hit the SPA fallback and return the dashboard HTML, which the
  // scripts fail to parse as JSON. When the integration is enabled these
  // root namespaces belong to the control plane — the gateway and dashboard
  // use /v1, /console/api, and /share only — so they are proxied at the root
  // too, keeping every upstream path byte-identical.
  return new Elysia()
    .use(automationRoutes("/automation"))
    .use(apiRoutes("/api"))
    .get("/proxy-pool.js", ({ request }: { request: Request }) => forward(request, "/proxy-pool.js"))
    .get("/proxy-pool.css", ({ request }: { request: Request }) => forward(request, "/proxy-pool.css")) as unknown as Elysia;
}
