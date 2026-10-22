/**
 * Types for the CodeBuddy JSONL import script.
 *
 * `tsconfig.json` runs with `allowJs: false`, so the `.mjs` next to this file
 * has no inferred types. Declaring the two entry points the contract test
 * exercises keeps that test typechecked instead of excluded — the same reason
 * `ops-import-grok-oauth.d.mts` exists for its script.
 */
export interface ImportedCredential {
  readonly label: string;
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: Date;
}

export declare function loadCredentials(path: string): ImportedCredential[];

export declare function accountStatement(
  key: Buffer,
  row: ImportedCredential,
  tenantId: string | null,
): string;
