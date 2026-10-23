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
 * Stable session cache keyed per (client identity, egress) pair.
 *
 * `x-opencode-session` is the client handle upstream attributes a request to,
 * and it carries prompt-cache affinity, so two properties have to hold:
 *
 * 1. **One session per conversation.** Minting a fresh id on every dispatch
 *    looks like a brand-new client each turn, so nothing upstream can be
 *    attributed to a continuing conversation.
 * 2. **One session per client.** A handle is an identity: two tenants, two
 *    accounts, or two egress addresses presenting the same id are the same
 *    client to upstream. Sharing one is wrong on its own terms — it collapses
 *    distinct conversations into one correlation identity — so the key pairs
 *    the credential with the egress that presents it.
 *
 * What the key does **not** do is buy quota. The free tier's allowance is
 * keyed on the **source address**, not on this handle: the probe evidence is
 * that a freshly minted `ses_` id from a spent address still answers `429`,
 * while a fresh id from an unspent address answers `200`. Rotating the proxy
 * is therefore what actually changes the quota, and reusing a session id is
 * not what produced the observed 429s — those came from addresses that were
 * already spent. Correct keying here is about identity and cache affinity; it
 * does not, by itself, lift a spent allowance.
 *
 * Entries expire after `STABLE_SESSION_TTL_MS` and the map evicts its
 * least-recently-used entry at `MAX_STABLE_SESSIONS`, so the key space is
 * bounded regardless of how many identities or pools exist.
 */
const STABLE_SESSION_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_STABLE_SESSIONS = 1000;
const stableOpencodeSessions = new Map<string, { sessionId: string; lastUsed: number }>();

/**
 * Which client this dispatch is, from what upstream can actually distinguish.
 *
 * The account id is the strongest available identity. Failing that, the
 * credential bytes are hashed (FNV-1a over the raw secret) so the map key never
 * retains key material. A provider with no account and no secret — OpenCode
 * Free sends the literal `Bearer public` — has no identity at all, and
 * `anonymous` is the honest answer: upstream cannot tell those callers apart
 * either, so the egress half of the key is what separates them.
 */
function credentialKey(credential: ProviderDispatchContext["credential"] | undefined): string {
  if (!credential) return "anonymous";
  if (credential.account_id) return `account:${credential.account_id}`;
  const secret = credential.secret;
  if (secret && secret.length > 0) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < secret.length; i += 1) {
      hash ^= secret[i] ?? 0;
      hash = Math.imul(hash, 0x01000193);
    }
    return `secret:${(hash >>> 0).toString(16)}`;
  }
  return "anonymous";
}

function identityKey(context?: ProviderDispatchContext): string {
  const egress = context?.network_pool_id ?? "direct";
  return `${credentialKey(context?.credential)}|egress:${egress}`;
}

/** Resolve (or mint and cache) a stable session id for this identity+egress pair. */
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

/**
 * Drop this identity+egress session so the next dispatch mints a new one.
 *
 * Called when upstream reports `FreeUsageLimitError`. This is hygiene, not the
 * remedy: the allowance is keyed on the source address, so the retry that
 * matters is one leaving through a *different* exit, and a fresh handle from
 * the same spent address is still refused. Retiring it is still correct —
 * a handle upstream has just declared spent should not be reused, and a new
 * conversation should not inherit it — but no reader should expect this to
 * restore quota by itself.
 *
 * Scoped deliberately to that one error: a bare 429 is a request window the
 * same handle may pass shortly, and a 5xx is not about this handle at all;
 * rotating on either would discard a healthy conversation's affinity.
 */
export function invalidateOpenCodeSession(context?: ProviderDispatchContext): void {
  stableOpencodeSessions.delete(identityKey(context));
}

/** Test-only: clear the stable-session cache so tests observe fresh ids. */
export function _resetStableOpenCodeSessionsForTesting(): void {
  stableOpencodeSessions.clear();
}

/** Test-only: observable cache size, so bounds are asserted rather than assumed. */
export function _stableOpenCodeSessionCountForTesting(): number {
  return stableOpencodeSessions.size;
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
