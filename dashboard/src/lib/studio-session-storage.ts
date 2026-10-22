/**
 * Persistence for the Model Lab's active-session pointer and playground key.
 * Reads fall back from sessionStorage to localStorage; writes are explicit per
 * scope so the key can stay per-visit while the active session survives.
 */
export const ACTIVE_KEY = "lianrouter:studio:active-session";
export const STUDIO_KEY_STORAGE = "lianrouter:studio:key";
export const STUDIO_PREFIX_STORAGE = "lianrouter:studio:key-prefix";

/**
 * Set when the operator pasted a key themselves.
 *
 * Without it, a manual key is indistinguishable from a console-issued one, and
 * the next send that finds the cache empty asks the console for a key again —
 * discarding the operator's key and re-surfacing whatever error stopped the
 * console from issuing one. The flag makes "this key is mine" survive, so the
 * console is only consulted when the operator has not taken over.
 */
export const STUDIO_MANUAL_KEY_FLAG = "lianrouter:studio:key-manual";

export function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key) ?? window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is an optimization; the active session still remains usable.
  }
}
export function writeSession(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* private mode: key is re-issued per visit */
  }
}

/**
 * Drops the cached playground key from both scopes.
 *
 * Both, not just the write scope: {@link readStorage} falls back from session to
 * local storage, so clearing one leaves a key in the other that the next read
 * still finds. The cache is an optimization over the server's own record, and
 * that record is what decides whether the key works — a stale cache must never
 * outrank it.
 */
export function invalidateStorage(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* nothing to clear */
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}
