/**
 * Startup update notices.
 *
 * Rendering only: no I/O, no clock, no terminal state. The caller decides when
 * to print; this module decides what the lines say, so the exact wording and
 * the order can be asserted without a terminal or a network.
 *
 * The two notices are different facts about different artifacts. The launcher
 * package is replaced by the package manager that installed it; the gateway
 * archive is replaced by this launcher's own update command. Printing one line
 * per artifact, each naming its own command, is the whole reason they are not
 * merged into a single "an update is available".
 *
 * No colour and no emoji: this output can be piped into a CI log, where escape
 * sequences are noise and a blank trailing line is a diff.
 */
import { compareVersions } from "../update/contracts";

export interface UpdateNoticeInput {
  readonly launcher?: { readonly current: string; readonly latest: string } | undefined;
  readonly gateway?: { readonly current: string; readonly latest: string } | undefined;
}

/** U+2192, the arrow the menu labels and update output already use. */
const ARROW = "\u2192";

/**
 * Builds the startup notice lines, launcher first.
 *
 * The launcher leads because it is the outer artifact: a newer package may
 * carry a newer update path, so its instruction is the one to act on first.
 * A pair produces a line only when the published version is strictly newer —
 * the same precedence rule the update engine uses, so a notice never contradicts
 * the menu row about the same pair. Returns an empty array when neither pair
 * qualifies; the caller prints nothing rather than a blank line.
 */
export function renderUpdateNotices(input: UpdateNoticeInput): readonly string[] {
  const lines: string[] = [];

  const launcher = input.launcher;
  if (launcher !== undefined && compareVersions(launcher.latest, launcher.current) > 0) {
    lines.push(
      `lianrouter: a newer launcher is published (${launcher.current} ${ARROW} ${launcher.latest}). Run: bun add -g lianrouter@latest`,
    );
  }

  const gateway = input.gateway;
  if (gateway !== undefined && compareVersions(gateway.latest, gateway.current) > 0) {
    lines.push(
      `lianrouter: a gateway update is available (${gateway.current} ${ARROW} ${gateway.latest}). Run: lianrouter update`,
    );
  }

  return lines;
}
