import { Elysia } from "elysia";
import { createCliToolsRoutes } from "./cli-tools/routes";
import { createAccountQuotaRoutes } from "./quota/account-quota";
import { createApiKeyRoutes } from "./domains/api-keys/routes";
import { createProviderCatalogRoutes } from "./providers/catalog/routes";
import {
  createProviderDetailRoutes,
} from "./providers/detail/routes";
import {
  createOAuthLoginRoutes,
  DrizzleOAuthAccountStore,
} from "./providers/oauth/routes";
import {
  DrizzleProviderCatalogStore,
} from "./providers/catalog/store";
import { DrizzleProviderDetailStore } from "./providers/detail/store";
import { createProviderOutboundResolver } from "./providers/outbound-binding";
import { createGenerationRoutes } from "./generation/routes";
import { DrizzleGenerationStore } from "./generation/store";
import { createModelRoutingRoutes } from "./routing/model/contracts";
import { createNetworkPoolRoutes } from "./routing/pools/contracts";
import { DrizzleModelRoutingStore } from "./routing/model/store";
import { DrizzleNetworkPoolStore } from "./routing/pools/store";
import { createRuntimeSettingsRoutes } from "./settings/contracts";
import { createUpdateRoutes } from "./update/routes";
import { createTunnelRoutes } from "./tunnel/contracts";
import { getTunnelService } from "./tunnel/service";
import { DrizzleRuntimeSettingsStore } from "./settings/store";
import { createPromptInjectionRoutes } from "./prompt-injection/routes";
import { createAppealRoutes } from "./automation/appeal/routes";
import { DrizzleAppealStore } from "./automation/appeal/store";
import { createReportRoutes } from "./automation/report/routes";
import { DrizzleReportStore } from "./automation/report/store";
import { DrizzlePromptInjectionStore } from "../persistence/prompt-injection-store";
import { createObservabilityRoutes } from "./domains/stats/contracts";
import { DrizzleObservabilityStore } from "./domains/stats/store";
import { createLiveRoutes } from "./domains/live";
import { createLogRoutes } from "./domains/logs";
import { createAuditRoutes } from "./domains/audit/contracts";
import { DrizzleAuditReadStore } from "./domains/audit/store";
import { createModelAbuseRoutes } from "./domains/model-abuse/routes";
import { createSecurityRoutes } from "./domains/security/routes";
import { createStudioRoutes } from "./domains/studio/routes";
import { DrizzleStudioSessionStore } from "./domains/studio/store";
import { createPerformanceRoutes } from "./domains/performance/routes";
import { createBackupRoutes } from "./backup/routes";
import { BackupService } from "./backup/service";
import type { ConsoleCredentialService } from "./auth/service";

import { OAuthFlowStore } from "../providers/authentication/oauth-flow-store";
import { createAccountSecretResolver } from "../providers/operations/provider-credential-service";
import { syncByokProvider } from "../providers/operations/provider-catalog-service";
import { recoverAccount } from "../providers/operations/account-health-service";
import { DrizzleApiKeyStore } from "../persistence/api-key-store";
import { DrizzleShareLinkStore } from "../persistence/share-store";
import { createShareUsagePort } from "./share/share-usage";
import { resolveSsrfPolicy } from "../config";
import { flagPoolCooldown } from "../network/pool-health";
import type { AuditRecorder } from "./auth/service";
import type { CliToolService } from "./cli-tools/service";
import type { NetworkPoolSelector } from "../network/pool/selector";
import type { RouteSnapshotService } from "../transport/routing/route-model";
import type { ApiKeyAdmissionService } from "../security/admission";
import type { ProbeDispatchFn } from "../providers/discovery/probe-dispatch";
import type { ModelStrikeService } from "../security/model-abuse";
import type { IpAbuseProtectionService } from "../security/abuse";
import type { ConsoleLockoutService } from "./auth/service";
import type { TelemetryBatchBuffer } from "../observability/telemetry-buffer";
import type { OAuthRefreshService } from "../providers/authentication/oauth-refresh-service";
import type { RedisClient } from "../persistence/redis";
import type { ProviderRegistry } from "../providers/provider-registry";
import type { BundledProviderCatalog } from "../providers/operations/provider-catalog-service";
import type { ValidatedNetworkBindingFactory } from "../network/pool/resolver";
import type { LianRouterDatabase } from "../persistence/postgres";
import type { ConsoleAccessResolver } from "./auth/access";

export interface ConsoleDomainContext {
  readonly db: LianRouterDatabase;
  readonly accessResolver: ConsoleAccessResolver;
  readonly providerRegistry: ProviderRegistry;
  readonly bundledModelCatalog: BundledProviderCatalog;
  readonly networkBindingFactory: ValidatedNetworkBindingFactory;
  readonly oauthRefreshService: OAuthRefreshService;
  readonly auditRecorder: AuditRecorder;
  readonly cliToolService: CliToolService;
  readonly redis: RedisClient;
  readonly routeSnapshotService: RouteSnapshotService;
  readonly poolSelector: NetworkPoolSelector;
  readonly telemetryBuffer: TelemetryBatchBuffer;
  readonly admissionService: Pick<ApiKeyAdmissionService, "purgeKey">;
  /** The paid probe path; see `ConsoleApiCompositionDeps.probeDispatcher`. */
  readonly probeDispatcher: ProbeDispatchFn;
  /** Graduated model-abuse strikes, for the ban list and its lift action. */
  readonly modelStrikes?: ModelStrikeService;
  /** The `/v1/*` admission layer: the operator-facing IP-unban clears its store. */
  readonly ipAbuseProtection?: IpAbuseProtectionService;
  /** Console login lockouts (per-IP rows in `console_lockouts`); the unban lifts these too. */
  readonly consoleLockouts?: ConsoleLockoutService;
  /**
   * Loads the signed-in console user, for surfaces that re-authenticate the
   * operator rather than trusting the session alone (backup export/restore).
   */
  readonly loadConsoleUser: (request: Request) => Promise<{ readonly passwordHash: string } | null>;
  /** Password verification against the console user's stored hash. */
  readonly credentialService: Pick<ConsoleCredentialService, "verifyPassword">;
}


export function registerConsoleDomains(
  console: Elysia<any, any, any, any, any, any, any, any>,
  ctx: ConsoleDomainContext,
): void {
  const observabilityStore = new DrizzleObservabilityStore(ctx.db, ctx.redis);
  const auditReadStore = new DrizzleAuditReadStore(ctx.db);
  /** Refresh-aware credential resolution shared by the catalog export and quota routes. */
  const resolveCredential = createAccountSecretResolver({
    db: ctx.db,
    resolveRefresher: (id) => ctx.providerRegistry.resolveRefresher(id),
    refreshService: ctx.oauthRefreshService,
  });
  const providerOutbound = createProviderOutboundResolver({
    db: ctx.db,
    poolSelector: ctx.poolSelector,
    networkBindingFactory: ctx.networkBindingFactory,
  });
  const providerCatalogStore = new DrizzleProviderCatalogStore(ctx.db, {
    telemetryBuffer: ctx.telemetryBuffer,
    bundledModelCatalog: ctx.bundledModelCatalog,
    providerRegistry: ctx.providerRegistry,
    outboundFetchFor: providerOutbound,
    snapshotInvalidator: ctx.routeSnapshotService,
    poolSelector: ctx.poolSelector,
    coolPool: (poolId, providerId, error) => flagPoolCooldown(ctx.poolSelector, ctx.db, poolId, providerId, error),
    dispatchProbe: ctx.probeDispatcher,
  });
  const generationStore = new DrizzleGenerationStore(ctx.db, {
    outboundFetchFor: providerOutbound,
    oauth: {
      resolveRefresher: (id) => ctx.providerRegistry.resolveRefresher(id),
      refreshService: ctx.oauthRefreshService,
    },
  });
  const providerDetailStore = new DrizzleProviderDetailStore(ctx.db);
  const networkPoolStore = new DrizzleNetworkPoolStore(
    ctx.db,
    resolveSsrfPolicy(),
    ctx.routeSnapshotService,
  );
  const runtimeSettingsStore = new DrizzleRuntimeSettingsStore(ctx.db);
  const modelRoutingStore = new DrizzleModelRoutingStore(ctx.db);
  const apiKeyStore = new DrizzleApiKeyStore(ctx.db);
  const shareStore = new DrizzleShareLinkStore(ctx.db);
  const shareActivity = createShareUsagePort(ctx.db);


  console.use(createObservabilityRoutes({ store: observabilityStore, accessResolver: ctx.accessResolver }));
  console.use(createLiveRoutes({
    accessResolver: ctx.accessResolver,
    poolSelector: ctx.poolSelector,
    db: ctx.db,
  }));
  console.use(createStudioRoutes({
    sessionStore: new DrizzleStudioSessionStore(ctx.db),
    keyStore: apiKeyStore,
    accessResolver: ctx.accessResolver,
    webFetch: (tenantId) => ctx.networkBindingFactory.fetch(undefined, tenantId),
    auditSink: ctx.auditRecorder,
  }));
  if (ctx.modelStrikes !== undefined) {
    console.use(createModelAbuseRoutes({
      strikes: ctx.modelStrikes,
      accessResolver: ctx.accessResolver,
      auditSink: ctx.auditRecorder,
    }));
  }
  if (ctx.ipAbuseProtection !== undefined || ctx.consoleLockouts !== undefined) {
    console.use(createSecurityRoutes({
      ...(ctx.ipAbuseProtection !== undefined ? { ipAbuseProtection: ctx.ipAbuseProtection } : {}),
      ...(ctx.consoleLockouts !== undefined ? { consoleLockouts: ctx.consoleLockouts } : {}),
      accessResolver: ctx.accessResolver,
      auditSink: ctx.auditRecorder,
    }));
  }
  console.use(createLogRoutes({ accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder }));
  console.use(createPerformanceRoutes({ accessResolver: ctx.accessResolver }));
  console.use(createAuditRoutes({ store: auditReadStore, accessResolver: ctx.accessResolver }));
  console.use(
    createGenerationRoutes({
      store: generationStore,
      accessResolver: ctx.accessResolver,
      auditSink: ctx.auditRecorder,
    }),
  );
  console.use(createProviderCatalogRoutes({
    store: providerCatalogStore,
    accessResolver: ctx.accessResolver,
    auditSink: ctx.auditRecorder,
    providerRegistry: ctx.providerRegistry,
    snapshotInvalidator: ctx.routeSnapshotService,
    resolveCredential,
    // Without this, a custom provider only becomes dispatchable after a
    // restart: boot registers BYOK rows once, and the catalog routes are the
    syncByokProvider: (providerId) =>
      syncByokProvider(ctx.providerRegistry, ctx.db, providerId, resolveSsrfPolicy()),
    listRoutingTargets: async (tenantId) => ({
      aliases: await modelRoutingStore.listAliases(tenantId),
      combos: await modelRoutingStore.listCombos(tenantId),
    }),
  }));
  console.use(createProviderDetailRoutes({
    store: providerDetailStore,
    accessResolver: ctx.accessResolver,
    auditSink: ctx.auditRecorder,
    snapshotInvalidator: ctx.routeSnapshotService,
  }));
  console.use(createNetworkPoolRoutes({
    store: networkPoolStore,
    accessResolver: ctx.accessResolver,
    auditSink: ctx.auditRecorder,
    poolSelector: ctx.poolSelector,
    snapshotInvalidator: ctx.routeSnapshotService,
  }));
  console.use(createRuntimeSettingsRoutes({ store: runtimeSettingsStore, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder }));
  // The launcher home comes from the child's own environment, read inside the
  // domain per request: a cached value would outlive a launcher restart, and the
  // context object has no business carrying launcher state.
  console.use(createUpdateRoutes({ accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder }));
  console.use(
    createTunnelRoutes({
      service: getTunnelService(),
      accessResolver: ctx.accessResolver,
      auditSink: ctx.auditRecorder,
    }),
  );
  console.use(
    createPromptInjectionRoutes({
      store: new DrizzlePromptInjectionStore(ctx.db),
      accessResolver: ctx.accessResolver,
      auditSink: ctx.auditRecorder,
    }),
  );
  // The growth-report control plane shares its credential resolver with the
  // quota routes: both need a refreshed OAuth token, and two resolvers would
  // mean two refresh paths for the same account.
  console.use(
    createReportRoutes({
      store: new DrizzleReportStore(ctx.db),
      accessResolver: ctx.accessResolver,
      auditSink: ctx.auditRecorder,
      resolveCredential,
    }),
  );
  console.use(
    createAppealRoutes({
      store: new DrizzleAppealStore(ctx.db),
      accessResolver: ctx.accessResolver,
      auditSink: ctx.auditRecorder,
      resolveCredential,
      // The recheck judges an appeal by whether the account works again, so it
      // must ask the same question live traffic asks: the catalog store's
      // probeModel runs the real adapter, identity headers and health recorder.
      probeAccount: async ({ tenantId, providerId, accountId, modelId }) => {
        const result = await providerCatalogStore.probeModel(tenantId, providerId, {
          modelId,
          accountId,
        });
        return {
          ok: result.ok,
          ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      },
      // An accepted appeal is the operator-visible proof that the ban is gone.
      recoverAccount: async (accountId) => {
        await recoverAccount(ctx.db, accountId, "appeal_accepted");
      },
    }),
  );
  console.use(
    createBackupRoutes({
      accessResolver: ctx.accessResolver,
      // The service is built per request: re-authenticating the operator needs
      // the request's session, and holding a request-bound closure in a
      // long-lived object would leak one request's identity into the next.
      backupFor: (request: Request) =>
        new BackupService({
          db: ctx.db,
          verifyPassword: async (password: string) => {
            const user = await ctx.loadConsoleUser(request);
            if (user === null) return false;
            return ctx.credentialService.verifyPassword(password, user.passwordHash);
          },
        }),
      snapshotInvalidator: ctx.routeSnapshotService,
    }),
  );
  console.use(createModelRoutingRoutes({ store: modelRoutingStore, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder, snapshotInvalidator: ctx.routeSnapshotService }));
  console.use(createApiKeyRoutes({ store: apiKeyStore, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder, shareStore, shareActivity, admissionService: ctx.admissionService, poolLookup: networkPoolStore }));
  console.use(createCliToolsRoutes({ service: ctx.cliToolService, accessResolver: ctx.accessResolver, auditSink: ctx.auditRecorder, snapshotInvalidator: ctx.routeSnapshotService }));
  console.use(createAccountQuotaRoutes({
    db: ctx.db,
    accessResolver: ctx.accessResolver,
    auditRecorder: ctx.auditRecorder,
    redis: ctx.redis,
    snapshotInvalidator: ctx.routeSnapshotService,
    providerRegistry: ctx.providerRegistry,
    resolveCredential,
  }));
  console.use(createOAuthLoginRoutes({ providerRegistry: ctx.providerRegistry, oauthFlowStore: new OAuthFlowStore(ctx.redis), accountStore: new DrizzleOAuthAccountStore(ctx.db), accessResolver: ctx.accessResolver, snapshotInvalidator: ctx.routeSnapshotService }));
}
