/**
 * ZCode plan-lane identity asset.
 *
 * The start-plan gateway (`/api/v1/zcode-plan/anthropic/v1/messages`) inspects
 * the `system` field as content, not as prose: a request whose first block is
 * not the CLI prefix verbatim, or whose second block does not open with the
 * canonical stable text, is refused with `405 {"code":3012}` regardless of
 * headers or credential. The third block is unconstrained and carries the
 * caller's own system prompt.
 *
 * This text is client-version-tied. It tracks the ZCode 4.0.0 prompt contract;
 * when an app update makes the gateway answer 3012, re-capture the blocks from a
 * live client request and replace the literals here together with
 * `ZCODE_APP_VERSION`. Nothing else in the adapter may hand-copy this text.
 *
 * # Where the 4.0.0 bytes come from
 *
 * Not hand-transcribed. `system[1]` is rebuilt from the publisher's own source
 * (`zai-org/ZCode` tag `v4.0.0`,
 * `apps/zcode-cli/packages/core/src/context/sections/identity.ts`): the intro
 * constant, the security notice, then the `# Harness` block assembled exactly as
 * `buildHarnessBlock(true)` assembles it. That reconstruction was then compared
 * against an independent capture of the same contract and matched byte for byte
 * at 1229 characters, which is the only reason the literal is trusted — a
 * prompt-shape gate fails on one wrong character, so "looks right" is not
 * evidence.
 *
 * 4.0.0 dropped the prose the 3.x asset opened with. The stable body no longer
 * describes a software-engineering agent at all: it opens with the
 * judgement-and-goals intro and keeps the authorized-security boundary and the
 * harness rules. Re-deriving means reading the tag, not editing this string.
 */
import { getZcodeVersion } from "../../operations/client-versions";

/** Desktop client version the asset was captured against. */
export const ZCODE_APP_VERSION = "4.0.0";

/**
 * Client version the billing and marketing faces must claim.
 *
 * These are two different questions and they must not share one constant. The
 * inference lane is version-locked to the captured system prompt
 * (`ZCODE_APP_VERSION`); the campaign faces are gated the other way — the
 * vendor serves its current marketing deliveries only to a recent client, and
 * an older version is answered `deliveries: []`, which reads as "this account
 * has no campaigns" when the truth is "ask as this client and you are not
 * offered any". Measured live against one start-plan account: 3.16.3 and
 * 3.17.2 both answered empty while 3.18.2 carried the weekend campaign, so the
 * claimed version tracks the installed desktop client — which on 4.0.0 is
 * 4.0.0, the same release the inference asset was derived from. The two
 * constants stay separate because that is the measured rule, not because they
 * must hold different strings: the next campaign-only bump will diverge them
 * again, and sharing one constant would then silently break the prompt gate.
 *
 * Bumping this changes the claimed identity only on the control faces, so it
 * never touches the system-prompt gate.
 *
 * Read through `zcodeCampaignAppVersion()` rather than directly: the campaign
 * gate is the *only* ZCode face that can safely follow a new client release, so
 * it follows the resolver and never the captured constant.
 */
const ZCODE_CAMPAIGN_APP_VERSION_FALLBACK = "4.0.0";

/**
 * Client version the campaign/control faces claim, latest release first.
 *
 * Deliberately not a constant export. This is the one ZCode version that may
 * advance on its own: the vendor serves marketing deliveries only to a recent
 * client, so following the published release is what keeps claims visible. The
 * inference lane cannot do this — it is pinned to a captured system prompt — so
 * the two must not share a value. Sync read of the warm cache, same contract as
 * every other identity preset.
 */
export function zcodeCampaignAppVersion(): string {
  const resolved = getZcodeVersion();
  return resolved.length > 0 ? resolved : ZCODE_CAMPAIGN_APP_VERSION_FALLBACK;
}

/** Anthropic protocol headers the captured client sent. */
export const ZCODE_ANTHROPIC_VERSION = "2023-06-01";
export const ZCODE_ANTHROPIC_BETA = "mid-conversation-system-2026-04-07";

/** SDK user-agent face the captured client presented. */
export const ZCODE_SDK_USER_AGENT = "ZCode/4.0.0 ai-sdk/provider-utils/4.0.27 runtime/node.js/24";

/** First system block: must match byte for byte. */
export const ZCODE_CLI_PREFIX = "You are ZCode, an interactive agent";

/** Second system block: must open with the full text, leading newline included. */
export const ZCODE_STABLE_PREFIX = "\nYou are an agent working with the user toward their goals, using your own judgment along the way.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n - The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n - Reference code as `file_path:line_number` — it's clickable.";
