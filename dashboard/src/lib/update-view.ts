import type { UpdateStatus } from "./contracts";

/**
 * Presentation decisions for the brand-header update control, kept out of the
 * components so they can be asserted directly.
 *
 * The badge must name the gateway that is actually answering, not the bundle
 * that was built. `DASHBOARD_RELEASE_LABEL` is a build-time constant, so a
 * console served by a 2.2.2 gateway would otherwise keep advertising the
 * version it was compiled from. The status response is the only live source;
 * the constant survives only as the fallback for "no launcher, request failed,
 * or not loaded yet".
 */
export function versionLabel(status: UpdateStatus | undefined, fallback: string): string {
  const current = status?.current.trim();
  if (current === undefined || current.length === 0) return fallback;
  // The launcher may report either `2.2.2` or `v2.2.2`; the badge owns the
  // prefix, so a second one would render `vv2.2.2`.
  return current.startsWith("v") ? current : `v${current}`;
}

export interface UpdateButtonState {
  /** True only when the control cannot act: no launcher is attached. */
  readonly disabled: boolean;
  /** Drives the accent tone — the only signal the operator gets unopened. */
  readonly available: boolean;
  /** Native tooltip; states why the control is disabled when it is. */
  readonly title: string;
  /** True when the control must not render at all. */
  readonly hidden: boolean;
}

/**
 * The control exists for one job: getting the operator to an installable
 * release, or back to the progress of one already running. Every other state
 * renders nothing, because a permanently inert pill beside the version badge is
 * noise — the badge already answers "what am I running".
 *
 * The rules are explicit per case rather than derived, because two of them are
 * easy to get wrong:
 *
 * - `available` → visible. An installable release is exactly what it is for.
 * - `running` → visible even when `available` is false. An install is in
 *   flight; the operator needs a way back to the progress bar after closing the
 *   dialog. Hiding it mid-install would strand him with no route back.
 * - `launcher === false` → hidden. Nothing on this install can apply a release,
 *   so the control could never do anything; `disabled` and `title` still carry
 *   the explanation for any caller that renders it anyway.
 * - `status === undefined` (not loaded) → hidden. Rendering it would flash a
 *   button that may vanish a moment later; the badge already carries the
 *   version during that window.
 * - loaded, launcher present, not running, not available → hidden. This is the
 *   common case: up to date means no control.
 *
 * `disabled` stays as it was so callers that ignore `hidden` still behave.
 */
export function updateButtonState(status: UpdateStatus | undefined): UpdateButtonState {
  if (status === undefined) {
    return { disabled: false, available: false, title: "Check for updates", hidden: true };
  }
  if (!status.launcher) {
    return {
      disabled: true,
      available: false,
      title:
        "This gateway was not started by the lianrouter launcher, so it cannot install updates. Run lianrouter update in the terminal.",
      hidden: true,
    };
  }
  if (status.running) {
    return {
      disabled: false,
      available: true,
      title: "Update in progress — open for progress",
      hidden: false,
    };
  }
  if (status.available) {
    const latest = status.latest ?? status.current;
    return {
      disabled: false,
      available: true,
      title: `LianRouter ${latest} is available`,
      hidden: false,
    };
  }
  return {
    disabled: false,
    available: false,
    title: `LianRouter ${versionLabel(status, status.current)} is up to date`,
    hidden: true,
  };
}
