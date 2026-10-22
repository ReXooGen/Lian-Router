import {
  getOpenCodeVersion,
  refreshOpenCodeVersion,
} from "../operations/client-versions";
import type { CanonicalRequest, ToolDefinition } from "../../transport/canonical-model";
import type { ProviderDispatchContext } from "../provider-registry";

let lastTimestamp = 0;
let sequenceCounter = 0;

/**
 * Generate a valid OpenCode session identifier matching the official binary:
 * `ses_` + 12-char hex (bitwise inverted millisecond timestamp * 4096 + seq) + 14-char base62.
 */
export function generateOpenCodeSessionId(now = Date.now()): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    sequenceCounter = 0;
  }
  sequenceCounter++;
  const num = BigInt(now) * 0x1000n + BigInt(sequenceCounter);
  const inverted = ~num;
  const hex = Array.from({ length: 6 }, (_, i) =>
    Number((inverted >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
  const rand = crypto.getRandomValues(new Uint8Array(14));
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const suffix = Array.from(rand, (byte) => chars[byte % 62]).join("");
  return `ses_${hex}${suffix}`;
}

/** Generate a valid OpenCode message/request identifier: `msg_` + 30-char hex. */
export function generateOpenCodeRequestId(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 30)}`;
}

/**
 * Stable session cache keyed per credential identity.
 *
 * The upstream free-tier gate accounts quota per `x-opencode-session`; minting
 * a fresh session on every dispatch burns through the per-session quota and
 * surfaces as `429 FreeUsageLimitError` with growing reset-after delays, while
 * the real CLI reuses one long-lived canonical session per conversation.
 * Mirror that: one stable session per downstream identity, evicted after
 * `STABLE_SESSION_TTL_MS` to bound memory.
 */
const STABLE_SESSION_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_STABLE_SESSIONS = 1000;
const stableOpencodeSessions = new Map<string, { sessionId: string; lastUsed: number }>();

function identityKey(context?: ProviderDispatchContext): string {
  const credential = context?.credential;
  if (credential && typeof credential === "object" && "secret" in credential) {
    const secret = (credential as { secret?: unknown }).secret;
    if (typeof secret === "string" && secret.length > 0) {
      // Hash the secret so the map key cannot leak the raw credential.
      let hash = 0;
      for (let i = 0; i < secret.length; i++) hash = ((hash << 5) - hash + secret.charCodeAt(i)) | 0;
      return `opencode:cred:${hash}`;
    }
  }
  return "opencode:default";
}

/** Resolve (or mint and cache) a stable session id for this credential identity. */
export function stableOpenCodeSessionId(context?: ProviderDispatchContext): string {
  const key = identityKey(context);
  const now = Date.now();
  const existing = stableOpencodeSessions.get(key);
  if (existing && now - existing.lastUsed <= STABLE_SESSION_TTL_MS) {
    existing.lastUsed = now;
    // Refresh LRU ordering so eviction prefers truly idle entries.
    stableOpencodeSessions.delete(key);
    stableOpencodeSessions.set(key, existing);
    return existing.sessionId;
  }
  // Evict stale or oldest entry when at capacity.
  if (stableOpencodeSessions.size >= MAX_STABLE_SESSIONS) {
    const oldest = stableOpencodeSessions.keys().next().value;
    if (oldest !== undefined) stableOpencodeSessions.delete(oldest);
  }
  const sessionId = generateOpenCodeSessionId(now);
  stableOpencodeSessions.set(key, { sessionId, lastUsed: now });
  return sessionId;
}

/** Test-only: clear the stable-session cache so tests observe fresh ids. */
export function _resetStableOpenCodeSessionsForTesting(): void {
  stableOpencodeSessions.clear();
}

/**
 * Build the Zen (billed) client fingerprint headers. Zen also expects the
 * desktop-client identity but the account credential is forwarded separately
 * by the adapter, so no Authorization is added here.
 */
export function buildOpenCodeHeaders(
  version = getOpenCodeVersion(),
  context?: ProviderDispatchContext,
): Record<string, string> {
  refreshOpenCodeVersion();
  return {
    "x-opencode-client": "desktop",
    "x-opencode-session": stableOpenCodeSessionId(context),
    "x-opencode-request": generateOpenCodeRequestId(),
    "x-opencode-project": "global",
    "user-agent": `opencode/${version}`,
  };
}

/**
 * Build the OpenCode Free fingerprint headers. The free gate expects the
 * literal `Authorization: Bearer public` plus the desktop client fingerprint,
 * plus `Accept: text/event-stream` when streaming (every free dispatch streams
 * — see `ensureFreeAgentRequest`). Returning anything else gets a 403
 * `FreeTierError` with "can only be used from within OpenCode".
 */
export function buildOpenCodeFreeHeaders(
  context?: ProviderDispatchContext,
  version = getOpenCodeVersion(),
): Record<string, string> {
  return {
    ...buildOpenCodeHeaders(version, context),
    authorization: "Bearer public",
    accept: "text/event-stream",
  };
}

/**
 * The canonical lowercase fingerprint quartet. OpenCode Free's gate rejects a
 * request whose `tools` array lacks any of these, so the adapter dedupes
 * case variants (`Bash` + `bash` is rejected as duplicate) and appends any
 * genuinely missing names with the decoy description below.
 */
export const OPENCODE_FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"] as const;

/** Decoy description used for every injected fingerprint tool. */
const OPENCODE_FINGERPRINT_DECOY_DESCRIPTION =
  "This tool is currently unavailable and must not be used.";

function fingerprintToolKey(name: string): string {
  const lower = name.trim().toLowerCase();
  return (OPENCODE_FINGERPRINT_TOOLS as readonly string[]).includes(lower) ? lower : "";
}

/**
 * Dedupe case-variant quartet tools (keeping only one lowercase declaration
 * for each quartet member), append any missing quartet members, and force
 * `stream: true`. The transform is additive: non-quartet caller tools pass
 * through verbatim, including tools that differ only by case — they are
 * outside OpenCode's fingerprint contract.
 */
export function ensureFreeAgentRequest(request: CanonicalRequest): CanonicalRequest {
  const existing = request.tools ?? [];
  const seenQuartet = new Set<string>();
  const normalized: ToolDefinition[] = [];
  for (const tool of existing) {
    const key = fingerprintToolKey(tool.name);
    if (!key) {
      normalized.push(tool);
      continue;
    }
    if (seenQuartet.has(key)) continue; // drop duplicate case variants
    seenQuartet.add(key);
    normalized.push(tool.name === key ? tool : { ...tool, name: key });
  }
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (seenQuartet.has(name)) continue;
    normalized.push({
      name,
      description: OPENCODE_FINGERPRINT_DECOY_DESCRIPTION,
      jsonSchema: { type: "object", properties: {} },
    });
  }
  if (normalized.length === existing.length && request.stream === true) {
    // Nothing to backfill and already streaming: avoid cloning the request.
    return request;
  }
  return { ...request, stream: true, tools: normalized };
}
