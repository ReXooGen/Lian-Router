/**
 * Isolated claim-challenge page.
 *
 * This page exists because the captcha must run under a policy the dashboard
 * document cannot have. The dashboard is served with `script-src` limited to its
 * own bundle, while the vendor widget loads a remote script, opens its own
 * frames and posts the challenge to region-specific captcha hosts. Widening the
 * dashboard policy for that would weaken every screen to buy one dialog, so the
 * challenge runs here and only this document carries the wider policy
 * (`claimCaptchaContentSecurityPolicy` in `src/security/outbound-headers.ts`).
 *
 * The page has no authority of its own: it holds no credential, calls no console
 * API, and returns exactly one value — the solved challenge token — to the
 * opener that created it. The claim itself is posted by the dashboard, so the
 * worst a tampered page can do is hand back a token the vendor rejects.
 */

/** The vendor's widget script. */
const SDK_SRC = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

interface AliyunCaptchaOptions {
  readonly SceneId: string;
  readonly region: string;
  readonly prefix: string;
  readonly mode: "popup" | "embed";
  readonly language: "en" | "cn";
  readonly showErrorTip: boolean;
  readonly element: string;
  readonly button: string;
  readonly getInstance: (instance: { show?: () => void }) => void;
  readonly success: (captchaVerifyParam: string) => void;
  readonly fail: (reason: unknown) => void;
}

interface CaptchaWindow extends Window {
  initAliyunCaptcha?: (options: AliyunCaptchaOptions) => void;
  AliyunCaptchaConfig?: { readonly region: string; readonly prefix: string };
}

const params = new URLSearchParams(window.location.search);
const sceneId = params.get("sceneId") ?? "";
const region = params.get("region") ?? "";
const prefix = params.get("prefix") ?? "";
const opener = window.opener as Window | null;
const openerOrigin = window.location.origin;

const statusEl = document.getElementById("status");
const holderEl = document.getElementById("holder");
const submitEl = document.getElementById("submit");

function report(message: string): void {
  if (statusEl !== null) statusEl.textContent = message;
}

/**
 * Returns the result to the dashboard and closes.
 *
 * The window is single-use: a solved token is spent by the first claim attempt,
 * so keeping the window alive would invite replaying it into another captcha
 * rejection.
 */
function finish(payload: { readonly param?: string; readonly error?: string }): void {
  opener?.postMessage({ type: "zcode-claim-captcha", region, ...payload }, openerOrigin);
  window.close();
}

function loadSdk(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error(`Could not load the captcha SDK from ${new URL(SDK_SRC).host}.`));
    document.head.appendChild(script);
  });
}

async function main(): Promise<void> {
  if (sceneId.length === 0 || region.length === 0 || prefix.length === 0) {
    report("The claim challenge is misconfigured: scene, region or prefix is missing.");
    finish({ error: "missing_config" });
    return;
  }
  if (holderEl === null || submitEl === null) {
    report("This page is missing its widget host element.");
    finish({ error: "missing_element" });
    return;
  }
  await loadSdk();
  const win = window as CaptchaWindow;
  if (win.initAliyunCaptcha === undefined) {
    report("The captcha SDK loaded but published no initialiser.");
    finish({ error: "sdk_missing_initialiser" });
    return;
  }
  // Region and prefix are read from this global at init time, not per call.
  win.AliyunCaptchaConfig = { region, prefix };
  win.initAliyunCaptcha({
    SceneId: sceneId,
    region,
    prefix,
    mode: "popup",
    language: "en",
    showErrorTip: true,
    element: "#holder",
    button: "#submit",
    getInstance: (instance) => {
      try {
        instance.show?.();
      } catch {
        // A widget that refuses to open automatically is still reachable through
        // the button; an unhandled throw here would leave the page stuck.
      }
    },
    success: (captchaVerifyParam: string) => {
      const trimmed = captchaVerifyParam.trim();
      if (trimmed.length === 0) {
        report("The challenge returned no token.");
        finish({ error: "empty_token" });
        return;
      }
      report("Challenge solved. Returning to the claim…");
      finish({ param: trimmed });
    },
    fail: (reason: unknown) => {
      const message =
        typeof reason === "string" && reason.length > 0 ? reason : "The challenge was not solved.";
      report(message);
      finish({ error: message });
    },
  });
  report("Solve the challenge below.");
}

void main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Captcha setup failed.";
  report(message);
  finish({ error: message });
});
