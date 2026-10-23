// Typed gateway failures: the stable public error codes, the error class, and
// the sanitizers that keep upstream payloads out of public envelopes.
import { redactTelemetryValue } from "../observability/redaction";

/** Stable typed error codes returned at gateway boundaries. */
export type GatewayErrorCode =
  | "capability_unsupported"
  | "ambiguous_model"
  | "model_not_found"
  | "context_length_exceeded"
  | "accounts_unavailable"
  | "capacity_exhausted"
  | "proxy_pool_capacity_exceeded"
  | "proxy_pool_cooldown"
  | "proxy_pool_unavailable"
  | "proxy_pool_unhealthy"
  | "proxy_pool_not_allowed"
  | "invalid_pool_limits"
  | "admission_unavailable"
  | "slug_reserved"
  | "quota_exceeded"
  | "authentication_failed"
  | "invalid_request"
  | "unsupported_field"
  | "internal_error"
  | "transport_unavailable"
  | "tunnel_setup_failed"
  | "platform_unavailable"
  | "tenant_capacity_exhausted"
  | "tls_rejected"
  | "proxy_auth_required"
  | "deadline_exceeded"
  | "transport_closed"
  | "max_connections_exceeded"
  | "proxy_unreachable"
  | "tool_call_loop_detected"
  | "shutting_down";

/**
 * Prefix on every gateway-authored public error message. Upstream-origin
 * messages are never prefixed, so the marker means "the router itself failed"
 * and never blames a provider for our fault (or vice versa).
 */
export const GATEWAY_ERROR_PREFIX = "lianrouter Error:";

/**
 * Identifies which boundary produced a safe public error.
 *
 * `gateway` means this router authored the failure; `upstream` means the
 * provider's response did; `network` means the transport between them did.
 * These values are persisted in `telemetry_events.error_origin` and rendered
 * by the Usage drawer, so they are a stored contract — the rename from the
 * old `lianrouter` value ships with the DDL in
 * `drizzle/migrations/manual/0014_rename_error_origin_gateway.sql`.
 */
export type GatewayErrorOrigin = "gateway" | "upstream" | "network";

/**
 * Error with a client-safe stable code, origin, and sanitized metadata.
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly origin: GatewayErrorOrigin;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GatewayErrorCode,
    status: number,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    origin: GatewayErrorOrigin = "gateway",
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.origin = origin;
    this.details = details;
  }
}

/** Formats a gateway error for public/internal clients without mutating it. */
export function explainGatewayError(error: GatewayError): string {
  if (error.origin === "upstream") return error.message;
  if (error.message.startsWith(GATEWAY_ERROR_PREFIX)) return error.message;
  return `${GATEWAY_ERROR_PREFIX} ${error.message}`;
}

const PUBLIC_ERROR_DETAIL_KEYS = new Set([
  "accountId",
  "accountScope",
  "available",
  "capacity",
  "configuredPools",
  "cooldownReason",
  "currentInflight",
  "credentialEvidence",
  "model",
  "poolId",
  "pools",
  "providerCode",
  "providerId",
  "providerStatus",
  "providerScope",
  "raw",
  "rateLimitScope",
  "reason",
  "reasons",
  "candidate_count",
  "requestId",
  "retryAfterMs",
  "retryAt",
  "safeMessage",
  "scope",
  "status",
  "upstreamRequestId",
  "upstreamStatus",
  "maxInflight",
  "weight",
]);
function sanitizePublicDetail(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 3) return "[redacted]";
  if (Array.isArray(value))
    return value.slice(0, 32).map((entry) => sanitizePublicDetail(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sanitizePublicDetail(entry, depth + 1),
    ]),
  );
}

/** Returns bounded allowlisted details suitable for public error envelopes.
 *  The `raw` field is passed through `redactTelemetryValue` before size
 *  bounding so upstream error bodies that echo API keys / bearer tokens are
 *  not leaked to public API clients through the error envelope. */
export function publicGatewayErrorDetails(
  error: GatewayError,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(error.details)
      .filter(([key]) => PUBLIC_ERROR_DETAIL_KEYS.has(key))
      .map(([key, value]) => [
        key,
        sanitizePublicDetail(key === "raw" ? redactTelemetryValue(value) : value),
      ]),
  );
}
/** Creates the typed rejection required when a semantic feature is unavailable. */
export function capabilityUnsupported(
  capability: string,
  details: Readonly<Record<string, unknown>> = {},
): GatewayError {
  return new GatewayError(
    "capability_unsupported",
    400,
    `The selected route does not support capability: ${capability}`,
    { capability, ...details },
  );
}
