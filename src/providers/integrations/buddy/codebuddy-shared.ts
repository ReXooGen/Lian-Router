import { createHash } from "node:crypto";
import { withBearerAuthentication, type OpenAICompatibleAdapterConfig } from "../../compatible-adapter";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import type {
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ProviderId,
} from "../../provider-registry";
import { resolveInboundSessionId, resolvePromptCacheKey } from "../../operations/session-resolution";
import { buildCodeBuddyUserAgent, resolveCodeBuddyVersion } from "../../operations/client-versions";
import { applyParamQuirks } from "../../../transport/translation/quirks";

/** Client identity variant behind the per-request CodeBuddy headers. */
export type CodeBuddyVariant = "IDE" | "CLI";

export function codebuddyDomain(variant: CodeBuddyVariant): string {
  return variant === "IDE" ? "www.codebuddy.ai" : "copilot.tencent.com";
}

/**
 * Deterministic RFC-4122-v5-shaped UUID derived from a conversation key,
 * mirroring the official IDE client's per-conversation id (uuidv5 over the
 * session key). Deterministic, so retries of one turn and later turns of the
 * same conversation carry the same id — the shape is what the gateway
 * validates, not cryptographic uniqueness.
 */
export function stableUuidFrom(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex");
  const timeHigh = ((parseInt(hash.slice(12, 16), 16) & 0x0fff) | 0x5000)
    .toString(16)
    .padStart(4, "0");
  const clockSeq = ((parseInt(hash.slice(16, 20), 16) & 0x3fff) | 0x8000)
    .toString(16)
    .padStart(4, "0");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    timeHigh,
    clockSeq,
    hash.slice(20, 32),
  ].join("-");
}

/** Case-insensitive write that updates an existing differently-cased key instead of adding a duplicate. */
function writeHeader(headers: Record<string, string>, name: string, value: string): void {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  headers[key ?? name] = value;
}

/** The first user message's text, flattened from string or typed blocks. */
function firstUserText(request: CanonicalRequest): string {
  const message = request.messages.find((m) => m.role === "user");
  if (!message) return "";
  return message.content
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("\n");
}

/**
 * Attach the conversation-correlation family the intl gateway's channel
 * verification demands — HTTP 400 code 11128 "conversation id missing"
 * without it. All three `X-Conversation-ID`, `X-Conversation-Request-ID` and
 * `X-Conversation-Message-ID` are required; `X-Request-ID` mirrors the
 * message id because the official client sends it.
 *
 - Values already present and non-empty are preserved so a caller tracking
 * its own conversation keeps it; blank values count as absent.
 * - `X-Conversation-ID` derives stably from the inbound session identity
 * (inbound header or canonical session/prompt-cache key, falling back to the
 * opening user message), so retries keep the id; a fresh UUID only when
 * nothing is derivable.
 * - `X-Conversation-Request-ID` / `X-Conversation-Message-ID` are fresh per
 * dispatch.
 */
export function withConversationHeaders(
  headers: Record<string, string>,
  request?: CanonicalRequest,
  context?: ProviderDispatchContext,
): Record<string, string> {
  const sessionKey =
    resolveInboundSessionId(context, request) ??
    resolvePromptCacheKey(request) ??
    null;
  const userText = request ? firstUserText(request) : "";
  const conversationKey = sessionKey ?? (userText.length > 0 ? `cbai:${userText}` : null);
  const headerValue = (name: string): string => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    const value = key ? headers[key] : undefined;
    return typeof value === "string" ? value.trim() : "";
  };

  if (headerValue("X-Conversation-ID").length === 0) {
    // A caller-supplied inbound `x-conversation-id` passes through verbatim —
    // it is the caller's conversation identity, not ours to reshape. Only
    // when nothing is supplied does the id derive stably from the canonical
    // session identity (UUID-shaped, so retries and siblings agree).
    const inboundRaw = context?.request_headers?.["x-conversation-id"]?.trim();
    writeHeader(
      headers,
      "X-Conversation-ID",
      inboundRaw && inboundRaw.length > 0
        ? inboundRaw
        : conversationKey !== null
          ? stableUuidFrom(conversationKey)
          : crypto.randomUUID(),
    );
  }
  if (headerValue("X-Conversation-Request-ID").length === 0) {
    writeHeader(headers, "X-Conversation-Request-ID", crypto.randomUUID());
  }
  // The request id mirrors the message id: reuse whichever side already exists.
  const messageId =
    headerValue("X-Conversation-Message-ID") ||
    headerValue("X-Request-ID") ||
    crypto.randomUUID();
  if (headerValue("X-Conversation-Message-ID").length === 0) {
    writeHeader(headers, "X-Conversation-Message-ID", messageId);
  }
  if (headerValue("X-Request-ID").length === 0) {
    writeHeader(headers, "X-Request-ID", messageId);
  }
  return headers;
}


/**
 * Per-request CodeBuddy headers — exact provider contract shared by the
 * international (IDE identity) and CN (CLI identity). The stable conversation
 * header is preserved from the client when available; request IDs rotate.
 *
 * The `X-Conversation-*` family is mandatory on the intl gateway (HTTP 400
 * code 11128 "conversation id missing" without it); `withConversationHeaders`
 * owns the derivation and preserves caller-supplied values.
 */
export async function codebuddyHeaders(
  variant: CodeBuddyVariant,
  context?: ProviderDispatchContext,
  request?: CanonicalRequest,
): Promise<Record<string, string>> {
  const identity = variant === "IDE" ? "IDE" : "CLI";
  // Await discovery so the true latest client version is stamped on every
  // dispatch; the pinned fallback only applies on a real network failure.
  await resolveCodeBuddyVersion();
  const ua = buildCodeBuddyUserAgent(identity);
  return withConversationHeaders(
    {
      accept: "text/event-stream",
      "User-Agent": ua,
      "X-Product": "SaaS",
      "X-IDE-Type": identity,
      "X-IDE-Name": identity,
      "X-Domain": codebuddyDomain(variant),
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    request,
    context,
  );
}

/**
 * Shared OpenAI-compatible chat-adapter config for both CodeBuddy variants:
 * bearer auth, chat-only wire contract, per-request identity headers, and the
 * variant's payload hook.
 */
export function codebuddyAdapterConfig(args: {
  providerId: ProviderId;
  baseUrl: string;
  variant: CodeBuddyVariant;
  prePayload: (
    payload: Record<string, unknown>,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ) => void;
  fetchImpl?: typeof fetch;
}): OpenAICompatibleAdapterConfig {
  return withBearerAuthentication({
    provider_id: args.providerId,
    base_url: args.baseUrl,
    supported_wire_families: ["chat"],
    // Opus 4.7+ is served by Anthropic, which rejects non-default sampling
    // parameters; the quirk table owns that rule so the header and payload
    // builders never disagree about which controls the route accepts.
    prepareRequest: (request) => applyParamQuirks(request, args.providerId),
    buildExtraHeaders: (context, request) => codebuddyHeaders(args.variant, context, request),
    prePayload: args.prePayload,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
}
