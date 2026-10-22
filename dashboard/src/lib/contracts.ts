import type { healthStatus } from "../../../src/persistence/schema";
import type { SessionStatusResponse } from "../../../src/console/auth/session";
/**
 * Type-only projections of the console API contracts.
 *
 * These exports deliberately point at the existing backend contract modules; the
 * dashboard does not define a second set of endpoint request or response types.
 */
// `USAGE_DIMENSIONS` is re-exported as a value because the Usage page validates
// `?dim=` against it at runtime. The source is `usage-periods.ts`, not
// `stats/contracts.ts`: that module imports Elysia and pulls `node:crypto` into
// the browser bundle.
export { USAGE_DIMENSIONS, type UsageDimension } from "../../../src/console/domains/stats/usage-periods";
// `TENANT_KEY_SCOPES` is re-exported as a value so the API-key editor renders
// the backend's own assignable-scope list instead of a hand-kept copy. The
// module is pure (no imports), so it is safe in the browser bundle.
export { TENANT_KEY_SCOPES } from "../../../src/security/access-control";
export type { TenantScope } from "../../../src/security/access-control";

export type {
  SystemHealthResponse,
  UsageByResponse,
  UsageByRow,
  UsageChartResponse,
  UsageRequestDetail,
  UsageRequestItem,
  UsageRequestsResponse,
  UsageResponse,
  UsageSummaryResponse,
  UsageSummaryTotals,
} from "../../../src/console/domains/stats/contracts";

export type {
  ProviderResponse,
  CreateProviderRequest,
  UpdateProviderRequest,
  ModelCatalogResponse,
  ModelCatalogEntry,
  FlatModelCatalogEntry,
  OAuthDevicePollResponse,
  ProviderRoutingResponse,
  UpdateProviderRoutingRequest,
  CreateProviderAccountRequest,
  UpdateProviderAccountRequest,
  ProviderAccountResponse,
  ProviderAccountExport,
  ProviderAccountsExportResponse,
  ProbeAllAccountsResult,
  ProbeModelRequest,
  ProbeModelResult,
  ByokConnectionTestRequest,
  ByokConnectionTestResult,
  SetModelEnabledRequest,
} from "../../../src/console/providers/catalog/contracts";

export type { AccountHealthEventRecord } from "../../../src/providers/operations/account-health-service";
export type { ProviderPromotion } from "../../../src/providers/provider-metadata";

export type {
  ComboStrategy,
  ModelAliasRow,
  ModelAliasCreateInput,
  ModelAliasPatchInput,
  ModelComboRow,
  ModelComboCreateInput,
  ModelComboPatchInput,
} from "../../../src/console/routing/model/contracts";

export type {
  CreateApiKeyRequest,
  ApiKeyResponse,
  CreateApiKeyResponse,
  UpdateApiKeyResponse,
  RevealApiKeyResponse,
  ShareKeyResponse,
} from "../../../src/console/domains/api-keys/contracts";
export type {
  SharedKeySummary,
  SharedKeyActivityDetail,
  SharedKeyModelUsage,
  SharedKeyRequestEvent,
} from "../../../src/console/share/share-usage";

// Backup export returns the payload itself (it is the file the operator
// downloads); import returns the per-table counts plus the router-import
// report, so the page can show what was skipped and why.
export type { BackupPayload as BackupExportResponse } from "../../../src/console/backup/contracts";
export type { ImportResult as BackupImportResponse } from "../../../src/console/backup/service";
export type { ImportReport as BackupImportReport } from "../../../src/console/backup/nine-router";

export type { AuditEntry, AuditListPage } from "../../../src/console/domains/audit/contracts";

export type {
  StudioMessage,
  StudioAttachment,
  StudioMediaResult,
  StudioSessionView,
  StudioSessionSummary,
} from "../../../src/console/domains/studio/contracts";

export type {
  RuntimeSettingsResponse,
  UpdateRuntimeSettingsRequest,
} from "../../../src/console/settings/contracts";

export type { RedisMode } from "../../../src/persistence/readiness";

export type HealthStatus = (typeof healthStatus.enumValues)[number];

/**
 * The dashboard's session view: the wire `SessionStatusResponse`, narrowed to
 * its authenticated arm and renamed to the dashboard's camelCase convention.
 * Derived from the backend type rather than hand-written — the previous mirror
 * dropped `username` and made `display_name`/`is_first_boot`/
 * `session_expires_at` required, and nothing compared the two.
 */
export type SessionResponse = SessionStatusResponse;

export interface SessionUser {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly isFirstBoot: boolean;
  readonly sessionExpiresAt: string;
  readonly isPlatformAdmin: boolean;
}

export type {
  CreateNetworkPoolRequest,
  NetworkPoolResponse,
  HealthCheckResult,
  PoolStrategySetting,

} from "../../../src/console/routing/pools/contracts";
export type { PoolHealthEvent } from "../../../src/network/pool-health-machine";


export type {
  ToolDef,
  ToolRegistryEntry,
  ToolStatus,
  ApplyInput,
  ApplyConfigResult,
  DownloadResult,
  CliMappingInput,
  CliMappingSettings,
} from "../../../src/console/cli-tools/contracts";

// ── Prompt Injection ─────────────────────────────────────────────────────────
// Mirrors `src/console/prompt-injection/contracts.ts`; the backend DTO is the
// authority and `prompt-injection` parity stays structural because the page
// only reads and writes these shapes.
export type PromptInjectionMode = "prompt" | "script";
export type PromptInjectionPreset = "custom" | "assistant" | "uncensored";
export type PromptInjectionPosition = "prepend" | "append";

export interface PromptInjectionTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface PromptInjectionEntry {
  readonly name: string;
  readonly active: boolean;
  readonly mode: PromptInjectionMode;
  readonly preset: PromptInjectionPreset;
  readonly content: string;
  readonly turns: readonly PromptInjectionTurn[];
  readonly position: PromptInjectionPosition;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export interface PromptInjectionCatalogEntry extends PromptInjectionEntry {
  readonly scope: "global" | "key" | "model";
  readonly target: string;
}

export interface PromptInjectionCatalog {
  readonly entries: readonly PromptInjectionCatalogEntry[];
  readonly global: PromptInjectionEntry | null;
  readonly userPrompts: Readonly<Record<string, PromptInjectionEntry>>;
  readonly prompts: Readonly<Record<string, PromptInjectionEntry>>;
}

export interface PromptInjectionInput {
  readonly name: string;
  readonly active: boolean;
  readonly mode: PromptInjectionMode;
  readonly preset: PromptInjectionPreset;
  readonly content: string;
  readonly turns: readonly PromptInjectionTurn[];
  readonly position: PromptInjectionPosition;
  readonly enabled: boolean;
}

export interface PromptInjectionPreviewEntry {
  readonly scope: "global" | "key" | "model";
  readonly target: string;
  readonly mode: PromptInjectionMode;
  readonly preset: PromptInjectionPreset;
  readonly position: PromptInjectionPosition;
  readonly text?: string;
  readonly turns?: readonly PromptInjectionTurn[];
}
