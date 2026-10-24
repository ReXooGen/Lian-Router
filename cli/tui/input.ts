/**
 * Keyboard decoder for the terminal console.
 *
 * Raw mode hands over bytes, and one key press is not one chunk: an arrow is
 * `ESC [ A` and can be split across reads, and a fast typist or a paste can
 * deliver several keys at once. So the decoder is a small stateful scanner —
 * `parseKeys` takes the accumulated buffer and returns the keys it could
 * decode plus the undecoded tail, which the caller carries into the next read.
 * `parseKey` is the single-key convenience form the tests exercise directly.
 */

export type TuiKey =
  | { readonly type: "char"; readonly char: string }
  | { readonly type: "enter" }
  | { readonly type: "escape" }
  | { readonly type: "up" }
  | { readonly type: "down" }
  | { readonly type: "left" }
  | { readonly type: "right" }
  | { readonly type: "pageup" }
  | { readonly type: "pagedown" }
  | { readonly type: "home" }
  | { readonly type: "end" }
  | { readonly type: "ctrl-c" }
  | { readonly type: "backspace" }
  | { readonly type: "unknown"; readonly raw: string };

export interface ParsedKeys {
  readonly keys: readonly TuiKey[];
  /** Bytes that look like the start of a sequence but are not complete yet. */
  readonly pending: Buffer;
}

/** CSI sequences this console understands, longest first so prefixes cannot win. */
const CSI_KEYS: readonly (readonly [string, TuiKey])[] = [
  ["\x1b[5~", { type: "pageup" }],
  ["\x1b[6~", { type: "pagedown" }],
  ["\x1b[1~", { type: "home" }],
  ["\x1b[4~", { type: "end" }],
  ["\x1b[7~", { type: "home" }],
  ["\x1b[8~", { type: "end" }],
  ["\x1b[H", { type: "home" }],
  ["\x1b[F", { type: "end" }],
  ["\x1b[1;2H", { type: "home" }],
  ["\x1b[1;2F", { type: "end" }],
  ["\x1b[A", { type: "up" }],
  ["\x1b[B", { type: "down" }],
  ["\x1b[C", { type: "right" }],
  ["\x1b[D", { type: "left" }],
  ["\x1bOA", { type: "up" }],
  ["\x1bOB", { type: "down" }],
  ["\x1bOC", { type: "right" }],
  ["\x1bOD", { type: "left" }],
];

const SS3_PREFIX = "\x1bO";

/**
 * Decodes as many keys as the buffer allows.
 *
 * A trailing `ESC` with nothing after it is ambiguous — the user may have
 * pressed Escape, or the rest of an arrow sequence may still be in flight. It
 * is returned as `pending` and resolved by the caller: `flushPending` (called
 * on a short timer) turns a still-dangling escape into the Escape key, which
 * is how a real terminal does it without ever blocking on a lone ESC.
 */
export function parseKeys(buffer: Buffer): ParsedKeys {
  const keys: TuiKey[] = [];
  let index = 0;
  const text = buffer.toString("utf8");

  while (index < text.length) {
    const rest = text.slice(index);

    if (rest.startsWith("\x03")) {
      keys.push({ type: "ctrl-c" });
      index += 1;
      continue;
    }

    if (rest.startsWith("\r") || rest.startsWith("\n")) {
      keys.push({ type: "enter" });
      index += 1;
      continue;
    }

    if (rest.startsWith("\x7f") || rest.startsWith("\b")) {
      keys.push({ type: "backspace" });
      index += 1;
      continue;
    }

    if (rest.startsWith("\x1b")) {
      if (rest.length === 1) return { keys, pending: Buffer.from("\x1b", "utf8") };
      const match = CSI_KEYS.find(([sequence]) => rest.startsWith(sequence));
      if (match !== undefined) {
        keys.push(match[1]);
        index += match[0].length;
        continue;
      }
      if (rest.startsWith(SS3_PREFIX) && rest.length === 2) {
        return { keys, pending: Buffer.from(rest, "utf8") };
      }
      // An incomplete CSI parameter run (`\x1b[1;`) is also pending; anything
      // else that starts with ESC but matches nothing is a bare Escape press.
      if (rest.startsWith("\x1b[") && rest.length < 8 && !/[A-Za-z~]$/.test(rest)) {
        return { keys, pending: Buffer.from(rest, "utf8") };
      }
      keys.push({ type: "escape" });
      index += 1;
      continue;
    }

    const cp = rest.codePointAt(0);
    if (cp === undefined) break;
    const char = String.fromCodePoint(cp);
    keys.push({ type: "char", char });
    index += char.length;
  }

  return { keys, pending: Buffer.alloc(0) };
}

/** Single-chunk convenience wrapper; the tail of a split sequence is reported as unknown. */
export function parseKey(chunk: Buffer): TuiKey {
  const { keys } = parseKeys(chunk);
  return keys[0] ?? { type: "unknown", raw: chunk.toString("utf8") };
}

/**
 * Resolves a dangling escape into the Escape key. The app calls this on a
 * ~30ms timer after the last chunk, matching the escape-timeout behaviour of
 * a terminal in application mode.
 */
export function flushPending(pending: Buffer): TuiKey {
  return pending.length === 1 && pending[0] === 0x1b ? { type: "escape" } : { type: "unknown", raw: pending.toString("utf8") };
}
