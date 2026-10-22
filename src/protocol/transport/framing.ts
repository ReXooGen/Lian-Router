/**
 * Upstream response framing that cannot be trusted from the header alone.
 *
 * Some gateways append the SSE terminator to a plain JSON body, and some label
 * a JSON body `text/event-stream`. A decoder that trusts the header breaks on
 * the first shape; one that trusts the body breaks on a genuine stream. These
 * helpers classify a buffered body by what it actually is, so the caller can
 * pick the matching decoder, and strip only an exact trailing terminator —
 * never an interior `data:` occurrence, which would truncate real content.
 */

/**
 * Removes one or more trailing `data: [DONE]` terminators from a buffered body.
 *
 * Matched only at the end of the body, so a JSON string whose value happens to
 * contain the marker (`{"text":"send data: [DONE]"}`) is left intact — there
 * the body continues past the marker with the JSON's own closing characters.
 */
export function stripTrailingSseTerminator(raw: string): string {
  return raw.replace(/(?:\s*data:\s*\[DONE\]\s*)+$/u, "").trimEnd();
}

/**
 * True when a buffered body is framed as SSE.
 *
 * Legal SSE bodies start with a field name (`data`, `event`, `id`, `retry`) or
 * a `:` comment; valid JSON can start with none of those, so the first token is
 * enough to tell the two apart without parsing. A keepalive comment before the
 * first `data:` frame is common — a gateway that emits `: heartbeat` makes the
 * whole body non-JSON, and treating it as JSON turned a healthy stream into a
 * 502.
 */
export function bodyIsSse(raw: string): boolean {
  return /^\s*(?::|event:|data:|id:|retry:)/u.test(raw);
}
