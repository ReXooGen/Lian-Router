import type { CanonicalRequest, ContentPart } from "../canonical-model";

/**
 * Prepends a provider's configured text to a request as a canonical `system`
 * part.
 *
 * Applied per attempt, not once per request. Failover moves an attempt to a
 * different provider, and each provider's text is its own: a request that
 * falls back to `rdhx` must carry `rdhx`'s text and none of the previous
 * provider's. Merging at the dispatch site is what keeps that true.
 *
 * The text is added as a `system` part rather than `instructions` because every
 * wire encoder already emits `system` for all four families (chat, messages,
 * responses, gemini), while `instructions` is Responses-specific — a provider
 * hint written once has to survive whichever family the route ends up using.
 *
 * A request with no `system` array gets one; an existing array is preserved
 * with the provider text first, so the client's own system prompt still
 * follows it and neither overwrites the other.
 *
 * Returns the request unchanged when the provider configured nothing, so the
 * common path allocates nothing.
 */
export function withProviderSystemPrompt(
  request: CanonicalRequest,
  systemPrompt: string | undefined,
): CanonicalRequest {
  const text = systemPrompt?.trim();
  if (text === undefined || text.length === 0) return request;
  const part: ContentPart = { kind: "text", text };
  return {
    ...request,
    system: [part, ...(request.system ?? [])],
  };
}
