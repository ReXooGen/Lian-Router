/**
 * Centralized query-key factory for every dashboard server-state resource.
 *
 * Keys are readonly tuples so query readers and mutation invalidations share one
 * authority. Feature code must not create inline TanStack Query keys.
 */
export const queryKeys = {
  session: {
    current: ["console", "session"] as const,
  },
  system: {
    health: ["console", "system", "health"] as const,
    usage: ["console", "system", "usage"] as const,
    usageByPeriod: (period: string) => ["console", "system", "usage", period] as const,
  },
  usageAnalytics: {
    summary: (period: string) => ["console", "usage", "summary", period] as const,
    chart: (period: string) => ["console", "usage", "chart", period] as const,
    by: (period: string, dimension: string) => ["console", "usage", "by", period, dimension] as const,
    requests: (
      period: string,
      limit: number,
      httpStatus?: number | null,
      shared?: boolean,
      parentKeyId = "",
      childKeyId = "",
    ) =>
      [
        "console",
        "usage",
        "requests",
        period,
        limit,
        httpStatus ?? "all",
        shared ?? "any",
        parentKeyId,
        childKeyId,
      ] as const,
    requestDetail: (requestId: string) => ["console", "usage", "requests", requestId] as const,
  },
  modelBans: {
    all: ["console", "model-bans"] as const,
  },
  generation: {
    catalog: ["console", "generation", "catalog"] as const,
    imageTask: (providerId: string, taskId: string) =>
      ["console", "generation", "images", providerId, taskId] as const,
    videoTask: (providerId: string, taskId: string) =>
      ["console", "generation", "videos", providerId, taskId] as const,
  },
  promptInjection: {
    all: ["console", "prompt-injection"] as const,
    preview: (keyId: string | null, model: string) =>
      ["console", "prompt-injection", "preview", keyId ?? "", model] as const,
  },
  providers: {
    all: ["console", "providers"] as const,
    detail: (providerId: string) => ["console", "providers", providerId] as const,
    models: (providerId: string | undefined) =>
      ["console", "providers", providerId, "models"] as const,
    flatAll: ["console", "providers", "models-flat-all"] as const,
    accounts: (providerId: string | undefined) =>
      ["console", "providers", providerId, "accounts"] as const,
    routing: (providerId: string | undefined) =>
      ["console", "providers", providerId, "routing"] as const,
    claims: (accountId: string | undefined) =>
      ["console", "providers", "accounts", accountId, "claims"] as const,
    claimVerification: (accountId: string | undefined) =>
      ["console", "providers", "accounts", accountId, "claims", "verification"] as const,
    healthEvents: (providerId: string | undefined, accountId: string | undefined) =>
      [
        "console",
        "providers",
        providerId,
        "accounts",
        accountId,
        "health-events",
      ] as const,
  },
  modelRouting: {
    all: ["console", "model-routing"] as const,
    aliases: ["console", "model-routing", "aliases"] as const,
    combos: ["console", "model-routing", "combos"] as const,
  },
  network: {
    pools: ["console", "network", "pools"] as const,
    poolStrategy: ["console", "network", "pool-strategy"] as const,
  },
  apiKeys: {
    all: ["console", "api-keys"] as const,
    sharedKeys: (keyId: string) => ["console", "api-keys", keyId, "shared-keys"] as const,
    sharedKeyActivity: (parentKeyId: string, childKeyId: string) =>
      ["console", "api-keys", parentKeyId, "shared-keys", childKeyId, "activity"] as const,
  },
  settings: {

    runtime: ["console", "settings", "runtime"] as const,
  },
  tunnel: {
    status: ["console", "tunnel"] as const,
  },
  update: {
    status: ["console", "update", "status"] as const,
  },
  cliTools: {
    registry: ["console", "cli-tools", "registry"] as const,
    statuses: ["console", "cli-tools", "statuses"] as const,
    mappings: (toolId: string) => ["console", "cli-tools", toolId, "mappings"] as const,
  },
  audit: {
    list: (filters: { action?: string; actor?: string; cursor?: string; limit?: number }) =>
      ["console", "audit", "list", filters] as const,
  },
  automation: {
    all: ["console", "automation"] as const,
    // Status is part of the key because the server filters the list; each
    // filter gets its own cache entry instead of overwriting the last one.
    reportAccounts: (providerId: string, status: string) =>
      ["console", "automation", "report", "accounts", providerId, status] as const,
    // Prefix for invalidating every filtered account list at once.
    reportAccountsAll: (providerId: string) =>
      ["console", "automation", "report", "accounts", providerId] as const,
    reportSchedule: (providerId: string) =>
      ["console", "automation", "report", "schedule", providerId] as const,
    appealAccounts: (providerId: string, status: string) =>
      ["console", "automation", "appeal", "accounts", providerId, status] as const,
    appealAccountsAll: (providerId: string) =>
      ["console", "automation", "appeal", "accounts", providerId] as const,
  },
  quota: {
    all: ["console", "quota"] as const,
    account: (accountId: string) => ["console", "quota", "account", accountId] as const,
    resets: (accountId: string) => ["console", "quota", "account", accountId, "resets"] as const,
  },
  studio: {
    sessions: ["console", "studio", "sessions"] as const,
    session: (sessionId: string) => ["console", "studio", "sessions", sessionId] as const,
  },
} as const;
