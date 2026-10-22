import { describe, expect, test } from "bun:test";
import { createDecipheriv, createHmac } from "node:crypto";
import { decodeKey, encryptCredential, hashSecret } from "./ops-import-grok-oauth.mjs";
import { decryptCredential, hashSecret as hashSecretFromSrc } from "../src/security/crypto";

// The operator script runs on the gateway host with no Bun and no checkout, so
// it carries its own copy of the credential crypto. These tests are the contract
// that keeps that copy byte-compatible with `src/security/crypto.ts`: if either
// side drifts, the rows it writes become undecryptable by the running gateway —
// a failure that would otherwise surface only as a provider 401 at dispatch time.
const KEY_HEX = "a".repeat(64);
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

describe("importer credential crypto matches src/security/crypto.ts", () => {
  test("decodeKey accepts the same hex and base64 forms", () => {
    expect(decodeKey(KEY_HEX).toString("hex")).toBe(KEY_HEX);
    expect(decodeKey(KEY_B64).toString("hex")).toBe(Buffer.alloc(32, 7).toString("hex"));
  });

  test("decodeKey rejects a key that is not exactly 32 bytes", () => {
    expect(() => decodeKey(Buffer.alloc(16, 1).toString("base64"))).toThrow("exactly 32 bytes");
  });

  test("ciphertext written by the importer decrypts with the application decryptor", () => {
    process.env.LIANROUTER_ENCRYPTION_KEY = KEY_HEX;
    const plaintext = "eyJhbGciOiJFUzI1NiJ9.grok-access-token";
    const ciphertext = encryptCredential(decodeKey(KEY_HEX), plaintext);
    expect(decryptCredential(ciphertext).toString("utf8")).toBe(plaintext);
  });

  test("importer ciphertext uses the iv || authTag || ciphertext layout", () => {
    const key = decodeKey(KEY_HEX);
    const plaintext = "layout-check";
    const buf = encryptCredential(key, plaintext);
    // Layout is load-bearing: the gateway reads the first 12 bytes as the IV and
    // the next 16 as the auth tag. A different order decrypts to garbage.
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const body = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    expect(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")).toBe(plaintext);
  });

  test("fingerprint agrees with the application hash for the same secret", () => {
    process.env.LIANROUTER_ENCRYPTION_KEY = KEY_HEX;
    const refresh = "refresh-token-value";
    const fromScript = hashSecret(decodeKey(KEY_HEX), refresh);
    expect(fromScript).toBe(hashSecretFromSrc(refresh));
    // And it is a plain HMAC-SHA256 under the decoded key, not something else.
    expect(fromScript).toBe(
      createHmac("sha256", Buffer.from(KEY_HEX, "hex")).update(refresh, "utf8").digest("hex"),
    );
  });

  test("a different key produces a different fingerprint", () => {
    const other = "b".repeat(64);
    expect(hashSecret(decodeKey(KEY_HEX), "x")).not.toBe(hashSecret(decodeKey(other), "x"));
  });
});
