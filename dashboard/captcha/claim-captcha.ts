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
  /** verifyType 2.0 flow: the SDK passes the certify JSON; the page answers. */
  readonly captchaVerifyCallback?: (
    value: string,
  ) => Promise<{ captchaResult: boolean }> | { captchaResult: boolean };
  /** verifyType 1.0/3.0 flow: a signed certify id. */
  readonly success?: (captchaVerifyParam: string) => void;
}

interface CaptchaWindow extends Window {
  initAliyunCaptcha?: (options: AliyunCaptchaOptions) => void;
  AliyunCaptchaConfig?: { readonly region: string; readonly prefix: string };
}

const params = new URLSearchParams(window.location.search);
const sceneId = params.get("sceneId") ?? "";
const region = params.get("region") ?? "";
const prefix = params.get("prefix") ?? "";
const openerOrigin = window.location.origin;
/**
 * Which dialog this challenge belongs to.
 *
 * The page is shared: the claim flow and the AutoClaw OAuth flow both need an
 * Aliyun token and both must run outside the dashboard document's policy. The
 * channel is carried in and echoed back so each opener only accepts its own
 * message instead of racing over a shared name.
 */
const channel = params.get("channel") ?? "zcode-claim-captcha";
/**
 * Keep this window alive after a solved challenge so it can navigate itself to
 * the login page. Only the AutoClaw OAuth flow sets it: the claim flow spends
 * its token in place and closes, while the OAuth flow needs the window as the
 * login surface.
 */
const holdForRedirect = params.get("hold") === "1";
const pageTitle = params.get("title") ?? "";
if (pageTitle.length > 0) document.title = pageTitle;

/**
 * Delivery back to the dashboard.
 *
 * `postMessage` through `window.opener` is the primary path, but an opener is not
 * guaranteed: a window opened with a severed opener (or re-opened from a
 * session-restored tab) reports `opener === null`, and the token then had no way
 * home while the dashboard sat waiting for it. A `BroadcastChannel` on the same
 * origin reaches the dashboard regardless of window relationships, so both are
 * used and the receiver de-duplicates by token.
 */
const outbox = typeof BroadcastChannel === "function" ? new BroadcastChannel(channel) : null;

function deliver(payload: Record<string, unknown>): void {
  const message = { type: channel, region, ...payload };
  try {
    window.opener?.postMessage(message, openerOrigin);
  } catch {
    // A severed or cross-origin opener throws on access; the channel below is
    // the path that still works.
  }
  try {
    outbox?.postMessage(message);
  } catch {
    // Channel closed mid-flight — nothing else can deliver this token.
  }
}

const statusEl = document.getElementById("status");
const holderEl = document.getElementById("holder");
const submitEl = document.getElementById("submit");

function report(message: string): void {
  if (statusEl !== null) statusEl.textContent = message;
}

/**
 * Returns the result to the dashboard.
 *
 * The window is single-use: a solved token is spent by the first claim attempt,
 * so keeping the window alive would invite replaying it into another captcha
 * rejection — unless `hold=1`, where the window has a second job: it becomes the
 * login page and navigates itself once the dashboard posts the authorize URL.
 * Closing it there would destroy the only window that can still navigate.
 */
function finish(payload: { readonly param?: string; readonly error?: string }): void {
  deliver(payload);
  // A window that closes in the same task can drop a channel message that has
  // not been handed to the browser yet; the close is deferred one tick so the
  // delivery above is already in flight.
  if (!holdForRedirect) window.setTimeout(() => window.close(), 120);
}

/**
 * AutoClaw's login window is this document.
 *
 * The dashboard used to pre-open an `about:blank` tab and navigate it once the
 * authorize URL arrived. That only ever ran when the solved token reached the
 * dashboard, and delivery went through `window.opener` alone: with no opener the
 * message is dropped, the dashboard stays on "Open the challenge", and the
 * pre-opened tab is left sitting blank — the white screen this replaces. So the
 * challenge window becomes the login window instead: the dashboard mints the URL
 * and posts it here, and this document navigates itself, the way the vendor's own
 * desktop client does.
 */
const REDIRECT_TYPE = `${channel}:redirect`;

window.addEventListener("message", (event: MessageEvent) => {
  if (event.origin !== openerOrigin) return;
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) return;
  const record = data as Record<string, unknown>;
  if (record["type"] !== REDIRECT_TYPE) return;
  const url = record["url"];
  if (typeof url !== "string" || url.length === 0) return;
  report("Verification accepted. Opening the login page…");
  window.location.assign(url);
});

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
    // The SDK's verifyType 2.0 flow (the default when the config omits
    // verifyType) never calls `success`: it hands the certify result to
    // `captchaVerifyCallback` and waits for the page to answer. The vendor's
    // own desktop app follows the same pattern — the JSON string is the proof
    // and the server-side exchange validates it — so the param goes to the
    // opener verbatim and the callback resolves to close the widget.
    captchaVerifyCallback: (value: string) => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed.length === 0) {
        report("The challenge returned no token.");
        finish({ error: "empty_token" });
        return Promise.resolve({ captchaResult: false });
      }
      report("Challenge solved. Returning to the claim…");
      finish({ param: trimmed });
      // The opener navigates away and the window closes; the widget only needs
      // an affirmative business result so it does not surface a retry error.
      return Promise.resolve({ captchaResult: true });
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
