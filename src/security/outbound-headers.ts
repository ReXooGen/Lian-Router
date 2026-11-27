// Central header protection for outbound custom-header validation.
import { createHash } from "node:crypto";

/**
 * Content-Security-Policy for non-document (JSON/API) responses. The gateway
 * never serves scripts, frames, or forms from these endpoints, so everything
 * is denied. `frame-ancestors 'none'` also covers clickjacking for browsers
 * that ignore `X-Frame-Options`.
 */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/** Legacy clickjacking guard for clients that predate CSP `frame-ancestors`. */
export const X_FRAME_OPTIONS = "DENY";

/**
 * Security headers on every `/v1` response, whichever path produced it.
 *
 * Three paths used to hand-copy this list — the request-context middleware,
 * the error encoder, and the upstream success projection — and they had
 * already drifted: the success path was missing the CSP pair. One list means a
 * future hardening cannot land on one path and miss the others.
 *
 * Carrying the CSP pair on the success path is safe because every surface
 * adapter emits `application/json` or `text/event-stream`, never a renderable
 * document. Console and `/share` responses keep their own narrower set.
 */
export const GATEWAY_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": API_CONTENT_SECURITY_POLICY,
  "x-frame-options": X_FRAME_OPTIONS,
});

/** CSP source expression for one inline script body (base64 SHA-256). */
export function inlineScriptHash(scriptBody: string): string {
  // The served HTML keeps CRLF while the CSP parser reads LF, so the hash must
  // be taken over the normalized form or the browser rejects it.
  const normalised = scriptBody.replace(/\r\n?/g, "\n");
  return `'sha256-${createHash("sha256").update(normalised, "utf8").digest("base64")}'`;
}

/**
 * Extracts the bodies of inline `<script>` tags (those without a `src`
 * attribute) so the dashboard CSP can allow exactly those scripts by hash
 * instead of enabling `'unsafe-inline'`.
 */
export function inlineScriptBodies(html: string): readonly string[] {
  const bodies: string[] = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const body = match[1] ?? "";
    if (body.trim().length > 0) bodies.push(body);
  }
  return bodies;
}

/**
 * Third-party origins the dashboard document must be allowed to reach.
 *
 * `o.alicdn.com` serves the Aliyun captcha widget that the ZCode claim gate
 * requires. Without it the script is blocked, the widget reports "could not
 * load the captcha SDK", and the only remaining way to claim a gated campaign
 * is another application.
 *
 * The widget also loads its own frames, images and device-fingerprint calls,
 * and reports the solved challenge over XHR to the captcha service, so these
 * origins are needed in `script-src`, `frame-src`, `connect-src` and `img-src`.
 *
 * Three separate hosts are involved and the widget fails with its own
 * "Network Err. Please refresh" panel when any of them is refused: the script
 * CDN, the captcha service API, and the device-signal endpoint it fingerprints
 * with. Blocking the last one looks exactly like a broken captcha rather than a
 * policy problem, which is why all three are named here instead of only the CDN.
 *
 * The list is intentionally tiny and named: a blanket `https:` would let any
 * injected string reach any origin.
 */
const DASHBOARD_WIDGET_SCRIPT_ORIGINS = [
  // The widget boots from `o.` and then pulls its rendering code, fonts and
  // styles from sibling subdomains (`g.`, `x.`). Measured in a real Chromium
  // against this deployment: blocking those siblings leaves the widget with no
  // challenge UI, which reads as "the captcha is broken".
  "https://o.alicdn.com",
  "https://g.alicdn.com",
  "https://x.alicdn.com",
  // The challenge service. The concrete host is region- and prefix-scoped —
  // measured: `no8xfe.captcha-open-southeast.aliyuncs.com` for this account's
  // scene — plus an upload host under the same family. The family is
  // templated, so it is matched by domain rather than enumerated.
  "https://*.aliyuncs.com",
] as const;

/**
 * Content-Security-Policy for the dashboard document. Scripts are restricted
 * to the bundled same-origin modules, hashes of the static inline theme
 * bootstrap, and the named widget origin; styles allow inline (React `style`
 * props) and Google Fonts.
 */
export function dashboardContentSecurityPolicy(html: string): string {
  const hashes = inlineScriptBodies(html).map(inlineScriptHash);
  // The captcha runs in its own document (`claimCaptchaContentSecurityPolicy`),
  // so the dashboard document itself needs no vendor origins at all: it only
  // opens that page. Keeping them here would widen every screen for a dialog
  // that no longer renders inside this document.
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length > 0 ? ` ${hashes.join(" ")}` : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Content-Security-Policy for the isolated captcha page.
 *
 * The claim challenge needs a policy the dashboard document must not have: it
 * loads a remote widget script, opens the vendor's frames, and posts the
 * challenge to region-specific captcha hosts. Rather than widen the dashboard
 * policy — which would apply to every screen — the challenge runs in its own
 * document, and only that document gets this wider policy.
 *
 * `frame-ancestors` stays `'self'` because the dashboard hosts it in an iframe
 * of the same origin; nothing else may embed it. Scripts are still limited to
 * the nonce-free same-origin bundle plus the one vendor origin, with
 * `'unsafe-inline'` present only because the page's own bootstrap is inline and
 * the page holds no data worth protecting from itself.
 */
export function claimCaptchaContentSecurityPolicy(): string {
  const widgetOrigins = DASHBOARD_WIDGET_SCRIPT_ORIGINS.join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${widgetOrigins}`,
    // The widget ships its own stylesheet and an embedded icon font. Measured
    // blocks: the stylesheet and a `data:` font were refused while the policy
    // listed neither, and the challenge rendered unstyled or not at all.
    `style-src 'self' 'unsafe-inline' ${widgetOrigins}`,
    "font-src 'self' data: " + widgetOrigins,
    "img-src 'self' data: blob: " + widgetOrigins,
    // The widget also loads its own `data:` images through `fetch()`, which
    // `connect-src` governs rather than `img-src`. Without `data:` here the SDK
    // logs "Fetch API cannot load data:image/png;base64,…" and never mounts, so
    // the page stayed blank behind a working Verify button.
    `connect-src 'self' data: ${widgetOrigins}`,
    `frame-src 'self' ${widgetOrigins}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * Content-Security-Policy for small self-contained console HTML pages (e.g.
 * the OAuth callback result). The default API policy denies scripts entirely,
 * so pages that must run an inline script declare its hash here to override it.
 */
export function inlineScriptContentSecurityPolicy(scriptBodies: readonly string[]): string {
  const hashes = scriptBodies.map(inlineScriptHash);
  return [
    "default-src 'none'",
    `script-src${hashes.length > 0 ? ` ${hashes.join(" ")}` : " 'none'"}`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const BASE_PROTECTED_HEADERS: Readonly<Record<string, true>> = Object.freeze({
  host: true,
  "content-type": true,
  "content-length": true,
  authorization: true,
  "x-api-key": true,
  cookie: true,
  connection: true,
  "keep-alive": true,
  "proxy-connection": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  via: true,
  forwarded: true,
  "x-real-ip": true,
  "x-forwarded-for": true,
  "x-forwarded-host": true,
  "x-forwarded-proto": true,
  "x-forwarded-port": true,
  "x-forwarded-prefix": true,
  "x-lianrouter-surface": true,
  "x-lianrouter-tenant": true,
});

export const HEADER_TOKEN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const HEADER_CONTROL = /[\r\n\x00-\x1f\x7f]/;

export function isProtectedHeader(name: string, extra: Readonly<Record<string, true>> = {}): boolean {
  const lower = name.toLowerCase();
  if (BASE_PROTECTED_HEADERS[lower] || extra[lower]) return true;
  if (lower.startsWith("x-forwarded-")) return true;
  return false;
}
