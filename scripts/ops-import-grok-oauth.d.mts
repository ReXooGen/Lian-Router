/**
 * Types for the operator import script.
 *
 * `tsconfig.json` runs with `allowJs: false`, so the `.mjs` next to this file
 * has no inferred types. Declaring the three primitives the contract test
 * exercises keeps that test typechecked instead of excluded.
 */
export declare function decodeKey(raw: string): Buffer;
export declare function encryptCredential(key: Buffer, plaintext: string): Buffer;
export declare function hashSecret(key: Buffer, secret: string): string;
