/**
 * Identity material for the `provider_accounts_identity_uidx` unique index.
 *
 * The index is `(provider_id, tenant, credential_fingerprint)`, so whatever this
 * returns *is* the account's identity: two logins that produce the same value
 * are refused as duplicates of each other.
 *
 * The refresh token was the whole story until a provider shipped a flow that
 * returns no refresh token at all. Every account then stored the same empty
 * envelope, collided on the index, and a second login was refused as a
 * duplicate of the first — the operator could never add the account they had
 * just authorized.
 *
 * Fallback order keeps the strongest available identity:
 *
 *  1. the refresh token, when it carries a secret — it is unique per grant and
 *     survives access-token rotation;
 *  2. the provider's own account label (email/org), scoped to the provider so
 *     the same address on two vendors is two accounts;
 *  3. the access credential itself, when the flow names nothing.
 */
import { hashSecret } from "../../../security/crypto";

export interface OAuthAccountIdentityInput {
  readonly label: string;
  readonly accountLabel?: string;
  readonly refresh: string;
  readonly access: string;
}

/**
 * Unwraps a refresh-token JSON envelope to the token it carries.
 *
 * Stores whose flow issued no token used to persist `{"refreshToken":""}` —
 * a non-empty *string* that is an empty *token*. Hashing the envelope kept
 * every such account identical on the identity index, so a second login was
 * refused as a duplicate. Reading through the envelope is what makes "no
 * token" mean the same thing on both sides.
 */
function refreshTokenOf(refresh: string): string {
  const trimmed = refresh.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && "refreshToken" in parsed) {
      const token = (parsed as { refreshToken?: unknown }).refreshToken;
      return typeof token === "string" ? token.trim() : "";
    }
  } catch {
    // Not an envelope — treat the raw value as the token.
  }
  return trimmed;
}

export function oauthAccountFingerprint(providerId: string, input: OAuthAccountIdentityInput): string {
  const refreshToken = refreshTokenOf(input.refresh);
  if (refreshToken.length > 0) return hashSecret(refreshToken);
  if (input.accountLabel !== undefined && input.accountLabel.trim().length > 0) {
    return hashSecret(`oauth-identity:${providerId}:${input.accountLabel.trim()}`);
  }
  return hashSecret(input.access);
}

/** Test seam: the store's own rule, exported rather than re-implemented. */
export const oauthAccountFingerprintForTest = oauthAccountFingerprint;
