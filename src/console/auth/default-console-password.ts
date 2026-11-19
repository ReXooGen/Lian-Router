/**
 * The shipped default console password, as its own module.
 *
 * The launcher (`cli/`) writes this value into a fresh `.env` and repairs an
 * install that lacks it. Keeping it here — instead of importing it from
 * `password-gate.ts` — keeps that import chain free of `pino`, the database
 * schema, and every other gateway-only dependency: the launcher bundle must
 * resolve at runtime on an install that ships no `node_modules` beyond its own
 * two dependencies.
 */

/**
 * The password a fresh local install starts with, and the one the login screen
 * advertises while it is still in use.
 *
 * The hint describes a credential the operator can actually type, so it is only
 * shown while the environment value is both the default *and* the effective
 * password. Once the console owns the secret the environment value is a
 * rotation trigger, not a credential, and the hint must disappear even if the
 * configured value never changed.
 */
export const DEFAULT_CONSOLE_PASSWORD = "local-console-2026";
