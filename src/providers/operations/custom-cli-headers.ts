/**
 * Custom provider CLI identity headers.
 *
 * Emits official CLI headers for OpenAI-compatible (Codex CLI) and
 * Anthropic-compatible (Claude Code CLI) endpoints so upstream requests
 * reflect realistic first-party tooling instead of naked node/bun user agents.
 */
import {
  getCodexVersion,
  getOmpAgentVersion,
  resolveClaudeCliVersion,
  resolveCodexVersion,
  resolveOmpAgentVersion,
} from "./client-versions";
import {
  CLAUDE_CODE_SDK_VERSION,
  CLAUDE_CODE_USER_AGENT,
} from "../integrations/claude-code/claude-fingerprint";
import { GATEWAY_USER_AGENT } from "./gateway-user-agent";
import type { WireFamily } from "../../transport/canonical-model";

/** Builds Codex CLI identity headers for OpenAI-compatible wire families. */
export function buildCustomCodexCliHeaders(): Record<string, string> {
  const version = getCodexVersion();
  return {
    "user-agent": `codex_cli_rs/${version}`,
    originator: "codex_cli_rs",
  };
}

/** OMP agent identity headers — version tracks the live oh-my-pi release. */
export function buildOmpAgentHeaders(): Record<string, string> {
  return {
    "user-agent": `omp/${getOmpAgentVersion()}`,
    "x-agent": "omp",
  };
}

/**
 * Hermes Agent identity headers.
 *
 * Nous Research's inference API attributes calls through its own agent face;
 * the client tag mirrors the shipped Hermes desktop client version.
 */
export function buildHermesAgentHeaders(): Record<string, string> {
  return {
    "user-agent": "hermes-agent/0.13.0",
    "x-product": "hermes-agent",
  };
}

/** Builds Claude Code CLI identity headers for Anthropic-compatible wire families. */
export function buildCustomClaudeCliHeaders(): Record<string, string> {
  return {
    "User-Agent": CLAUDE_CODE_USER_AGENT,
    "x-app": "cli",
    "X-Stainless-Package-Version": CLAUDE_CODE_SDK_VERSION,
    "X-Stainless-Runtime": "node",
    "X-Stainless-Retry-Count": "0",
  };
}

/**
 * The identity presets a custom provider can present upstream.  and
 *  are the historical CLI cloaking lanes;  and 






















 are the
 * agent faces;  swaps in the gateway's own User-Agent;  strips
 * identity entirely (the runtime's default Bun/undici agent stays).
 */
export type CliIdentityPreset = "codex" | "claude" | "omp" | "hermes" | "gateway" | "none";

export function isCliIdentityPreset(value: unknown): value is CliIdentityPreset {
  return (
    value === "codex" ||
    value === "claude" ||
    value === "omp" ||
    value === "hermes" ||
    value === "gateway" ||
    value === "none"
  );
}

/**
 * Returns the appropriate CLI headers based on target wire family.
 * Messages wire family gets Claude CLI headers; chat / responses get Codex CLI headers.
 */
export function resolveCustomCliHeaders(wireFamily: WireFamily): Record<string, string> {
  if (wireFamily === "messages") {
    return buildCustomClaudeCliHeaders();
  }
  return buildCustomCodexCliHeaders();
}

/**
 * Headers for an explicit identity preset. Wire-family branching only applies
 * to the historical CLI lanes; the agent faces are the same on every wire.
 */
export function resolveIdentityHeaders(
  preset: CliIdentityPreset,
  wireFamily: WireFamily,
): Record<string, string> {
  switch (preset) {
    case "omp":
      return buildOmpAgentHeaders();
    case "hermes":
      return buildHermesAgentHeaders();
    case "gateway":
      return { "user-agent": GATEWAY_USER_AGENT };
    case "claude":
      return buildCustomClaudeCliHeaders();
    case "codex":
      return buildCustomCodexCliHeaders();
    case "none":
      return {};
    default: {
      // Exhaustiveness: an unknown preset falls back to the historical
      // wire-family behavior rather than emitting no identity at all.
      return resolveCustomCliHeaders(wireFamily);
    }
  }
}
/**
 * Version-aware builders for the preset identities whose faces track a live
 * npm release (codex_cli_rs, claude-cli). Awaited at dispatch through the
 * async `buildExtraHeaders` hook so the first request after boot carries the
 * current version instead of the pinned fallback; the shared resolver cache
 * (TTL, deduped) keeps repeat dispatches network-free.
 */
export async function resolveIdentityHeadersAsync(
  preset: CliIdentityPreset,
  wireFamily: WireFamily,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Record<string, string>> {
  switch (preset) {
    case "codex":
      await resolveCodexVersion(fetcher);
      return buildCustomCodexCliHeaders();
    case "claude":
      await resolveClaudeCliVersion(fetcher);
      return buildCustomClaudeCliHeaders();
    case "omp":
      await resolveOmpAgentVersion(fetcher);
      return buildOmpAgentHeaders();
    default:
      return resolveIdentityHeaders(preset, wireFamily);
  }
}
