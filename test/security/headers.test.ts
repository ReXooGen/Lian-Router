import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  API_CONTENT_SECURITY_POLICY,
  X_FRAME_OPTIONS,
  claimCaptchaContentSecurityPolicy,
  dashboardContentSecurityPolicy,
  inlineScriptBodies,
  inlineScriptHash,
} from "../../src/security/outbound-headers";

/** Hash of the raw bytes, which is what the browser must never be asked to match. */
function rawByteHash(body: string): string {
  return `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
}

describe("security header policy", () => {
  test("API CSP denies every resource class and blocks framing", () => {
    expect(API_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(API_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(API_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(X_FRAME_OPTIONS).toBe("DENY");
  });

  test("inlineScriptHash is a stable base64 sha256 source expression", () => {
    const hash = inlineScriptHash("console.log(1)");
    expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    expect(inlineScriptHash("console.log(1)")).toBe(hash);
    expect(inlineScriptHash("console.log(2)")).not.toBe(hash);
  });

  test("inlineScriptBodies extracts only scripts without a src attribute", () => {
    const html = [
      `<script src="/app.js"></script>`,
      `<script>theme()</script>`,
      `<script type="module" src="/main.js"></script>`,
      `<script>\n  boot()\n</script>`,
      `<script>   </script>`,
    ].join("");
    expect(inlineScriptBodies(html)).toEqual(["theme()", "\n  boot()\n"]);
  });

  test("dashboard CSP allows only hashed inline scripts", () => {
    const csp = dashboardContentSecurityPolicy("<script>boot()</script>");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(inlineScriptHash("boot()"));
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("https://fonts.gstatic.com");
  });

  test("dashboard CSP omits hashes when no inline script exists", () => {
    const csp = dashboardContentSecurityPolicy("<html><body></body></html>");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'sha256-");
  });

  test("inlineScriptHash normalises CRLF to the LF hash the parser computes", () => {
    expect(inlineScriptHash("a\r\nb")).toBe(inlineScriptHash("a\nb"));
    // The served HTML keeps CRLF, so this is the exact mismatch the live page hit.
    expect(inlineScriptHash("a\r\nb")).not.toBe(rawByteHash("a\r\nb"));
  });

  test("inlineScriptHash normalises a lone CR to LF", () => {
    expect(inlineScriptHash("a\rb")).toBe(inlineScriptHash("a\nb"));
    expect(inlineScriptHash("a\rb")).not.toBe(rawByteHash("a\rb"));
  });

  test("dashboard CSP emits the LF-normalised hash for a CRLF inline script", () => {
    const body = "const theme = 'dark';\r\napply(theme);\r\n";
    const csp = dashboardContentSecurityPolicy(`<script>${body}</script>`);
    expect(csp).toContain(inlineScriptHash(body.replace(/\r\n/g, "\n")));
    expect(csp).not.toContain(rawByteHash(body));
  });

  test("inlineScriptHash is unchanged for a body without line endings", () => {
    const body = "console.log('single line')";
    expect(inlineScriptHash(body)).toBe(rawByteHash(body));
  });
  /**
   * The claim challenge cannot run inside the dashboard document: the vendor
   * widget needs its remote scripts, its own stylesheet and icon font, remote
   * frames and region-scoped challenge hosts, and widening the dashboard policy
   * for those would weaken every screen. So the challenge gets its own document
   * and its own policy, and this pins the split: the dashboard stays strict, the
   * captcha page is wide enough to work.
   *
   * Every host pinned here was observed in a real Chromium load of the deployed
   * page. Allowing only the script CDN renders an unstyled or empty widget that
   * reports a network error of its own, which is indistinguishable from the
   * vendor being down.
   */
  test("the captcha page gets its own wider policy, the dashboard stays strict", () => {
    const captcha = claimCaptchaContentSecurityPolicy();
    const dashboard = dashboardContentSecurityPolicy("<script>boot()</script>");

    for (const host of ["https://o.alicdn.com", "https://g.alicdn.com", "https://*.aliyuncs.com"]) {
      expect(captcha).toContain(host);
    }
    // The widget ships a stylesheet and an embedded icon font.
    expect(captcha).toMatch(/style-src[^;]*https:\/\/g\.alicdn\.com/);
    expect(captcha).toMatch(/font-src[^;]*data:/);
    // The SDK fetches its own `data:` images; `connect-src` governs that fetch,
    // so `img-src` alone leaves the widget unmounted behind a blank page.
    expect(captcha).toMatch(/connect-src[^;]*data:/);
    // Same-origin embedding only: nothing else may frame the challenge page.
    expect(captcha).toContain("frame-ancestors 'self'");

    // The dashboard document opens the challenge page; it never renders the
    // widget itself, so it must not carry the vendor origins.
    expect(dashboard).toContain("frame-ancestors 'none'");
    expect(dashboard).not.toContain("https://*.aliyuncs.com");
    expect(dashboard).not.toContain("https://o.alicdn.com");
    expect(dashboard).not.toContain("'unsafe-inline';");
  });
});
