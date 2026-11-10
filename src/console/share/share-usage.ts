import { and, desc, eq, gt, gte, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { LianRouterDatabase } from "../../persistence/postgres";
import type { ApiKeyRecord } from "../../persistence/api-key-store";
import { CachedPreferencesReader, DrizzlePreferencesReader } from "../../persistence/tenant-preferences";
import { maskClientIp } from "../../observability/redaction";
import {
  extractPayloadFileReference,
  readPayloadFrames,
  type PayloadFileReference,
} from "../../observability/payload-store";
import { apiKeys, telemetryEvents, telemetryPayloads, telemetryUsageTotals } from "../../persistence/schema";
import { shouldMaskClientIp } from "../shared/ip-privacy";
import { extractPromptText, type ExtractedPrompt } from "./share-prompts";

/**
 * Normalizes a timestamp that arrived through a SQL aggregate.
 *
 * `max(column)` carries no column type for the driver to map, so the value is
 * raw Postgres text rather than a `Date`; calling `.toISOString()` on it threw
 * at runtime while the annotation promised a Date.
 */
function toIsoString(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

export interface SharedKeyTokenUsage {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface SharedKeySummary {
  readonly id: string;
  readonly label: string;
  readonly keyPrefix: string | null;
  readonly issuedClientIp: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly allTime: SharedKeyTokenUsage;
  readonly today: SharedKeyTokenUsage;
  readonly lastUsedAt: string | null;
}

export interface SharedKeyModelUsage {
  readonly providerId: string | null;
  readonly modelId: string;
  readonly retainedRequests: number;
  readonly retainedErrors: number;
  readonly retainedTokens: number;
  readonly todayRequests: number;
  readonly todayErrors: number;
  readonly todayTokens: number;
}

export interface SharedKeyRequestEvent {
  readonly requestId: string;
  readonly startedAt: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly status: string;
  readonly httpStatus?: number;
  readonly errorCategory?: string;
  readonly errorOrigin?: string;
  readonly clientIp?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface SharedKeyActivityDetail {
  readonly models: readonly SharedKeyModelUsage[];
  readonly requests: readonly SharedKeyRequestEvent[];
}

/**
 * One request row as the signed-in owner sees it: the base metadata plus the
 * latest user prompt captured for that same request.
 *
 * The prompt is optional because it exists only while payload capture is on and
 * the frame has not expired; an absent field means "nothing to show", never an
 * empty prompt the recipient might have typed.
 */
export interface OwnerSharedKeyRequestEvent extends SharedKeyRequestEvent {
  readonly prompt?: string;
  readonly promptTruncated?: boolean;
}

/**
 * The signed-in owner's view of one child key.
 *
 * Deliberately not `SharedKeyActivityDetail`: the public enrollment surface
 * returns that base shape to an unauthenticated caller. Keeping prompt text on
 * a separate request type means a change to the shared loader cannot expose a
 * recipient's prompts to the public page — the compiler rejects it.
 */
export interface OwnerSharedKeyActivityDetail extends Omit<SharedKeyActivityDetail, "requests"> {
  readonly requests: readonly OwnerSharedKeyRequestEvent[];
  readonly promptCaptureEnabled: boolean;
}

export interface SharedKeyUsageBucket {
  /** UTC calendar day (`YYYY-MM-DD`). */
  readonly day: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** Public, credential-free aggregate across every child issued by one share template. */
export interface PublicShareActivity extends SharedKeyActivityDetail {
  readonly allTime: SharedKeyTokenUsage;
  readonly lastUsedAt: string | null;
  readonly series: readonly SharedKeyUsageBucket[];
}

/** Read-only share-recipient telemetry; payloads and credential material never cross this boundary. */
export interface ShareActivityPort {
  getSharedKeySummaries(
    tenantId: string,
    children: readonly ApiKeyRecord[],
  ): Promise<readonly SharedKeySummary[]>;
  getSharedKeyDetail(tenantId: string, childKeyId: string): Promise<OwnerSharedKeyActivityDetail>;
  getPublicShareActivity(tenantId: string, parentKeyId: string): Promise<PublicShareActivity>;
}

function utcDayStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function tokenUsage(row: {
  readonly requests: number | string | null;
  readonly errors: number | string | null;
  readonly inputTokens: number | string | null;
  readonly outputTokens: number | string | null;
} | undefined): SharedKeyTokenUsage {
  const inputTokens = Number(row?.inputTokens ?? 0);
  const outputTokens = Number(row?.outputTokens ?? 0);
  return {
    requests: Number(row?.requests ?? 0),
    errors: Number(row?.errors ?? 0),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/**
 * Prompt history is a read over bounded payload capture. Without the tenant's
 * explicit opt-in there are no request bodies to read, and the caller must be
 * able to say so instead of rendering an empty list that reads like "no
 * activity".
 */
async function isPromptCaptureEnabled(
  preferences: CachedPreferencesReader,
  tenantId: string,
): Promise<boolean> {
  try {
    return (await preferences.readPreferences(tenantId))?.telemetryPayloads === "bounded";
  } catch {
    return false;
  }
}

async function readSharedKeyPrompts(
  db: LianRouterDatabase,
  tenantId: string,
  requestIds: readonly string[],
): Promise<ReadonlyMap<string, ExtractedPrompt>> {
  const promptByRequest = new Map<string, ExtractedPrompt>();
  if (requestIds.length === 0) return promptByRequest;
  const rows = await db
    .select({
      requestId: telemetryPayloads.requestId,
      requestBody: telemetryPayloads.requestBody,
    })
    .from(telemetryPayloads)
    .where(
      and(
        eq(telemetryPayloads.tenantId, tenantId),
        inArray(telemetryPayloads.requestId, requestIds),
        gt(telemetryPayloads.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(telemetryPayloads.capturedAt));
  const referenceByRequest = new Map<string, PayloadFileReference>();
  for (const row of rows) {
    if (row.requestId === null || referenceByRequest.has(row.requestId)) continue;
    const reference = extractPayloadFileReference(row.requestBody);
    if (reference !== undefined) referenceByRequest.set(row.requestId, reference);
  }
  const linked = requestIds.flatMap((requestId) => {
    const reference = referenceByRequest.get(requestId);
    return reference === undefined ? [] : [{ requestId, reference }];
  });
  if (linked.length === 0) return promptByRequest;
  const frames = await readPayloadFrames(linked.map((entry) => entry.reference));
  frames.forEach((frame, index) => {
    const requestId = linked[index]?.requestId;
    if (requestId === undefined) return;
    const prompt = extractPromptText(frame);
    if (prompt !== undefined) promptByRequest.set(requestId, prompt);
  });
  return promptByRequest;
}

export function createShareUsagePort(db: LianRouterDatabase): ShareActivityPort {
  const preferences = new CachedPreferencesReader(new DrizzlePreferencesReader(db));
  async function loadDetail(
    tenantId: string,
    apiKeyScope: SQL<unknown>,
    hideClientIp: boolean,
  ): Promise<SharedKeyActivityDetail> {
    const todayStart = utcDayStart(new Date());
    const modelScope = and(
      eq(telemetryEvents.tenantId, tenantId),
      apiKeyScope,
      isNotNull(telemetryEvents.requestedModel),
    );
    const requestScope = and(
      eq(telemetryEvents.tenantId, tenantId),
      apiKeyScope,
    );
    const [modelRows, requestRows] = await Promise.all([
      db
        .select({
          providerId: telemetryEvents.providerId,
          modelId: telemetryEvents.requestedModel,
          retainedRequests: sql<number>`count(*)`,
          retainedErrors: sql<number>`count(*) filter (where ${telemetryEvents.status} in ('failed', 'truncated'))`,
          retainedTokens: sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)), 0)`,
          todayRequests: sql<number>`count(*) filter (where ${telemetryEvents.createdAt} >= ${todayStart})`,
          todayErrors: sql<number>`count(*) filter (where ${telemetryEvents.createdAt} >= ${todayStart} and ${telemetryEvents.status} in ('failed', 'truncated'))`,
          todayTokens: sql<number>`coalesce(sum(coalesce(${telemetryEvents.inputTokens}, 0) + coalesce(${telemetryEvents.outputTokens}, 0)) filter (where ${telemetryEvents.createdAt} >= ${todayStart}), 0)`,
        })
        .from(telemetryEvents)
        .where(modelScope)
        .groupBy(telemetryEvents.providerId, telemetryEvents.requestedModel)
        .orderBy(desc(sql`count(*)`))
        .limit(10),
      db
        .select({
          requestId: telemetryEvents.requestId,
          startedAt: telemetryEvents.createdAt,
          providerId: telemetryEvents.providerId,
          modelId: telemetryEvents.requestedModel,
          status: telemetryEvents.status,
          httpStatus: telemetryEvents.httpStatus,
          errorCategory: telemetryEvents.errorCategory,
          errorOrigin: telemetryEvents.errorOrigin,
          clientIp: telemetryEvents.clientIp,
          inputTokens: telemetryEvents.inputTokens,
          outputTokens: telemetryEvents.outputTokens,
        })
        .from(telemetryEvents)
        .where(requestScope)
        .orderBy(desc(telemetryEvents.createdAt), desc(telemetryEvents.id))
        .limit(20),
    ]);
    return {
      models: modelRows.flatMap((row) =>
        typeof row.modelId !== "string"
          ? []
          : [{
              providerId: row.providerId,
              modelId: row.modelId,
              retainedRequests: Number(row.retainedRequests ?? 0),
              retainedErrors: Number(row.retainedErrors ?? 0),
              retainedTokens: Number(row.retainedTokens ?? 0),
              todayRequests: Number(row.todayRequests ?? 0),
              todayErrors: Number(row.todayErrors ?? 0),
              todayTokens: Number(row.todayTokens ?? 0),
            }],
      ),
      requests: requestRows.map((row) => {
        const inputTokens = row.inputTokens ?? 0;
        const outputTokens = row.outputTokens ?? 0;
        return {
          requestId: row.requestId,
          startedAt: row.startedAt.toISOString(),
          ...(row.providerId ? { providerId: row.providerId } : {}),
          ...(row.modelId ? { modelId: row.modelId } : {}),
          status: row.status ?? "unknown",
          ...(row.httpStatus === null ? {} : { httpStatus: row.httpStatus }),
          ...(row.errorCategory ? { errorCategory: row.errorCategory } : {}),
          ...(row.errorOrigin ? { errorOrigin: row.errorOrigin } : {}),
          ...(row.clientIp
            ? { clientIp: hideClientIp ? maskClientIp(row.clientIp) : row.clientIp }
            : {}),
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      }),
    };
  }

  return {
    async getSharedKeySummaries(tenantId, children) {
      if (children.length === 0) return [];
      const childIds = children.map((child) => child.id);
      const todayStart = utcDayStart(new Date());
      const [todayRows, lifetimeRows, hideClientIp] = await Promise.all([
        db
          .select({
            apiKeyId: telemetryEvents.apiKeyId,
            requests: sql<number>`count(*)`,
            errors: sql<number>`count(*) filter (where ${telemetryEvents.status} in ('failed', 'truncated'))`,
            inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
          })
          .from(telemetryEvents)
          .where(
            and(
              eq(telemetryEvents.tenantId, tenantId),
              inArray(telemetryEvents.apiKeyId, childIds),
              gte(telemetryEvents.createdAt, todayStart),
            ),
          )
          .groupBy(telemetryEvents.apiKeyId),
        db
          .select({
            apiKeyId: telemetryUsageTotals.entityId,
            requests: telemetryUsageTotals.requests,
            errors: telemetryUsageTotals.errors,
            inputTokens: telemetryUsageTotals.inputTokens,
            outputTokens: telemetryUsageTotals.outputTokens,
            lastUsedAt: telemetryUsageTotals.lastUsedAt,
          })
          .from(telemetryUsageTotals)
          .where(
            and(
              eq(telemetryUsageTotals.tenantId, tenantId),
              eq(telemetryUsageTotals.identityType, "api_key"),
              inArray(telemetryUsageTotals.entityId, childIds),
            ),
          ),
        shouldMaskClientIp(preferences, tenantId),
      ]);
      const todayByKey = new Map<string, (typeof todayRows)[number]>();
      for (const row of todayRows) {
        if (row.apiKeyId !== null) todayByKey.set(row.apiKeyId, row);
      }
      const lifetimeByKey = new Map(lifetimeRows.map((row) => [row.apiKeyId, row]));
      return children.map((child) => {
        const allTime = tokenUsage(lifetimeByKey.get(child.id));
        const today = tokenUsage(todayByKey.get(child.id));
        const issuedClientIp = child.issuedClientIp;
        const lastUsedAt = lifetimeByKey.get(child.id)?.lastUsedAt;
        return {
          id: child.id,
          label: child.label,
          keyPrefix: child.keyPrefix ?? null,
          issuedClientIp:
            issuedClientIp === undefined
              ? null
              : hideClientIp
                ? maskClientIp(issuedClientIp)
                : issuedClientIp,
          createdAt: child.createdAt.toISOString(),
          revokedAt: child.revokedAt?.toISOString() ?? null,
          allTime,
          today,
          lastUsedAt: toIsoString(lastUsedAt),
        };
      });
    },

    async getSharedKeyDetail(tenantId, childKeyId) {
      const [hideClientIp, promptCaptureEnabled] = await Promise.all([
        shouldMaskClientIp(preferences, tenantId),
        isPromptCaptureEnabled(preferences, tenantId),
      ]);
      const detail = await loadDetail(
        tenantId,
        eq(telemetryEvents.apiKeyId, childKeyId),
        hideClientIp,
      );
      const promptByRequest = promptCaptureEnabled
        ? await readSharedKeyPrompts(
            db,
            tenantId,
            detail.requests.map((event) => event.requestId),
          )
        : undefined;
      return {
        ...detail,
        requests: detail.requests.map((event) => {
          const prompt = promptByRequest?.get(event.requestId);
          return prompt === undefined
            ? event
            : { ...event, prompt: prompt.text, promptTruncated: prompt.truncated };
        }),
        promptCaptureEnabled,
      };
    },

    async getPublicShareActivity(tenantId, parentKeyId) {
      const todayStart = utcDayStart(new Date());
      const seriesStart = new Date(todayStart);
      seriesStart.setUTCDate(seriesStart.getUTCDate() - 6);
      const childIds = db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.parentKeyId, parentKeyId)));
      const childEventScope = inArray(telemetryEvents.apiKeyId, childIds);
      const scope = and(
        eq(telemetryEvents.tenantId, tenantId),
        childEventScope,
      );
      const [detail, lifetimeRows, seriesRows] = await Promise.all([
        // Public share responses always mask IPs. The tenant's admin privacy
        // preference cannot weaken an unauthenticated surface.
        loadDetail(tenantId, childEventScope, true),
        db
          .select({
            requests: sql<number>`coalesce(sum(${telemetryUsageTotals.requests}), 0)`,
            errors: sql<number>`coalesce(sum(${telemetryUsageTotals.errors}), 0)`,
            inputTokens: sql<number>`coalesce(sum(${telemetryUsageTotals.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${telemetryUsageTotals.outputTokens}), 0)`,
            lastUsedAt: sql<string | Date | null>`max(${telemetryUsageTotals.lastUsedAt})`,
          })
          .from(telemetryUsageTotals)
          .where(
            and(
              eq(telemetryUsageTotals.tenantId, tenantId),
              eq(telemetryUsageTotals.identityType, "api_key"),
              inArray(telemetryUsageTotals.entityId, childIds),
            ),
          ),
        db
          .select({
            day: sql<string>`to_char(date_trunc('day', ${telemetryEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
            requests: sql<number>`count(*)`,
            inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
            outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
          })
          .from(telemetryEvents)
          .where(and(scope, gte(telemetryEvents.createdAt, seriesStart)))
          .groupBy(sql`date_trunc('day', ${telemetryEvents.createdAt} at time zone 'UTC')`)
          .orderBy(sql`date_trunc('day', ${telemetryEvents.createdAt} at time zone 'UTC')`),
      ]);
      const byDay = new Map(seriesRows.map((row) => [row.day, row]));
      const series: SharedKeyUsageBucket[] = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const date = new Date(seriesStart);
        date.setUTCDate(date.getUTCDate() + offset);
        const day = date.toISOString().slice(0, 10);
        const row = byDay.get(day);
        const inputTokens = Number(row?.inputTokens ?? 0);
        const outputTokens = Number(row?.outputTokens ?? 0);
        series.push({
          day,
          requests: Number(row?.requests ?? 0),
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        });
      }
      return {
        ...detail,
        allTime: tokenUsage(lifetimeRows[0]),
        lastUsedAt: toIsoString(lifetimeRows[0]?.lastUsedAt),
        series,
      };
    },
  };
}
