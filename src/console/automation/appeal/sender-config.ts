/** Shared constants for the appeal sender, kept dependency-free for tests. */

/**
 * Default appeal body. `{label}` is substituted with the account label so the
 * message stays truthful about which tenant is appealing.
 */
export const APPEAL_DEFAULT_MESSAGE =
  "This account ({label}) was restricted by mistake. It is used by my own automated gateway on my own infrastructure for personal development workloads, never for abuse, resale, or unusual scale. I have reviewed the usage policies and request that access be restored. Thank you for reviewing this appeal.";
