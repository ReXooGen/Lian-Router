/**
 * Public model-status readout.
 *
 * Answers "is this model working right now" from data the gateway already
 * records, instead of probing upstream: telemetry events hold per-attempt
 * outcomes, and `provider_accounts.model_cooldowns` holds the per-model
 * cooling state the health service writes. A status page that dialled every
 * provider would turn a passive readout into load, and would itself be the
 * thing that fails under the traffic it is meant to describe.
 *
 * The surface is unauthenticated, so it reports aggregates only: model ids,
 * bucket outcomes, and cooling deadlines. Account labels, credentials,
 * provider endpoints, tenant ids, and error bodies never cross this boundary.
 */
import { and, gte, sql } from "drizzle-orm";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { providerAccounts, telemetryEvents } from "../../persistence/schema";

/** Buckets one timeline row is split into. 60 buckets over 24h = a 24-minute step. */
export const STATUS_BUCKET_COUNT = 60;

/** The timeline window. */
export const STATUS_WINDOW_HOURS = 24;

/** Bucket colours the page renders. */
export type StatusBucketState = "ok" | "degraded" | "down" | "idle";

/** One time bucket of one model. */
export interface StatusBucket {
  /** ISO timestamp of the bucket's start. */
  readonly at: string;
  /** `idle` means no request landed in this window — not a failure. */
  readonly state: StatusBucketState;
  /** Requests observed in the bucket. */
  readonly requests: number;
  /** Failed requests in the bucket. */
  readonly failures: number;
}

/** One model's 24-hour health. */
export interface StatusModelRow {
  /** `provider/model`, the id a caller passes to the gateway. */
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  /** Success percentage over the window, or null when no request landed. */
  readonly successPercent: number | null;
  /** Headline state: `down` for a cooling model, else derived from failures. */
  readonly state: StatusBucketState;
  /** When the cooling window ends, if the model is cooling. */
  readonly coolingUntil: string | null;
  readonly requests: number;
  readonly failures: number;
  /**
   * Per-bucket timeline, omitted when the model saw no traffic in the window.
   *
   * A published catalog is hundreds of models and most see nothing in a day;
   * shipping sixty empty buckets each made the report megabytes wide for no
   * information. Absent means "nothing happened", which the page draws as one
   * flat grey bar — the same thing sixty idle buckets would say.
   */
  readonly buckets?: readonly StatusBucket[];
}

export interface StatusReport {
  /** Window length the buckets cover. */
  readonly windowHours: number;
  readonly bucketMinutes: number;
  readonly generatedAt: string;
  /** Aggregate headline for the banner. */
  readonly summary: {
    readonly models: number;
    readonly healthy: number;
    readonly degraded: number;
    readonly down: number;
  };
  readonly models: readonly StatusModelRow[];
}

/**
 * Classifies a failure share into a state.
 *
 * Exported because it is the one decision a reader will argue about: the two
 * thresholds are the contract between this file and the page, and a test that
 * asserts the drawn colours without asserting these numbers would lock in the
 * painting rather than the policy.
 */
export function classifyFailureShare(failureShare: number): StatusBucketState {
  if (failureShare >= DOWN_FAILURE_SHARE) return "down";
  if (failureShare >= DEGRADED_FAILURE_SHARE) return "degraded";
  return "ok";
}

/**
 * Headline state for one model.
 *
 * A cooling model is reported `down` regardless of its recent traffic: the
 * cooling deadline is the gateway's own decision to stop routing to it, and a
 * page that said "operational" for a model the router refuses would be lying
 * about the thing it exists to report.
 */
export function classifyModelState(
  requests: number,
  failures: number,
  coolingUntil: string | null,
): StatusBucketState {
  if (coolingUntil !== null) return "down";
  if (requests === 0) return "idle";
  return classifyFailureShare(failures / requests);
}

/** Failure share above which a bucket or a row reads as degraded. */
const DEGRADED_FAILURE_SHARE = 0.05;

/** Failure share at or above which a row reads as down (not merely degraded). */
const DOWN_FAILURE_SHARE = 0.5;

/**
 * Builds the public status report.
 *
 * Reads every model the gateway publishes (the `models` rows the caller passes
 * in) and joins telemetry for the window. Models with no traffic still render:
 * an absent bar is information, and dropping them would make a broken model
 * vanish from the page that exists to show it.
 */
export async function buildStatusReport(
  db: LianRouterDatabase,
  published: readonly { readonly providerId: string; readonly modelId: string }[],
  now: Date = new Date(),
): Promise<StatusReport> {
  const stepMs = Math.round((STATUS_WINDOW_HOURS * 60 * 60_000) / STATUS_BUCKET_COUNT);
  const windowStartMs = Math.floor(now.getTime() / stepMs) * stepMs - stepMs * (STATUS_BUCKET_COUNT - 1);
  const windowStart = new Date(windowStartMs);

  // One grouped read: per (provider, model, bucket) outcome counts. Grouping in
  // SQL keeps the response size independent of traffic — an ungrouped read of
  // a 24h window would ship hundreds of thousands of rows to build 60 bars.
  // The bucket index is selected and grouped by the same expression: wrapping
  // it in `to_char` for the select while grouping the bare `floor(...)` makes
  // Postgres reject the query, because the wrapped form is a different
  // expression over a non-grouped column. Grouping the epoch bucket keeps the
  // value a plain number, and the ISO stamp is derived in JS.
  const bucketRows = await db
    .select({
      providerId: telemetryEvents.providerId,
      requestedModel: telemetryEvents.requestedModel,
      bucket: sql<number>`floor(extract(epoch from ${telemetryEvents.createdAt}) * 1000 / ${stepMs})`,
      requests: sql<number>`count(*)`,
      failures: sql<number>`count(*) filter (where ${telemetryEvents.status} = 'failed')`,
    })
    .from(telemetryEvents)
    .where(
      and(
        gte(telemetryEvents.createdAt, windowStart),
        sql`${telemetryEvents.providerId} is not null`,
        sql`${telemetryEvents.requestedModel} is not null`,
      ),
    )
    // Ordinals, not repeated expressions: Drizzle renders each `sql` fragment
    // with its own bind placeholder, so a fragment interpolated twice produces
    // `$1` and `$4` — two distinct expressions to Postgres, which then rejects
    // the select's non-grouped column. `1,2,3` names the projected columns
    // exactly once each.
    .groupBy(sql`1, 2, 3`);

  // Cooling state is per account, so one model can be cooling for one credential
  // and healthy for another. `min()` takes the soonest recovery: the model is
  // usable again as soon as any account leaves cooldown, and reporting the
  // latest would overstate the outage.
  const coolingRows = await db
    .select({
      providerId: providerAccounts.providerId,
      modelCooldowns: providerAccounts.modelCooldowns,
    })
    .from(providerAccounts)
    .where(sql`${providerAccounts.modelCooldowns} <> '{}'::jsonb`);

  const coolingUntilByKey = new Map<string, number>();
  for (const row of coolingRows) {
    const cooldowns = (row.modelCooldowns ?? {}) as Record<string, string>;
    for (const [modelId, iso] of Object.entries(cooldowns)) {
      const until = new Date(iso).getTime();
      if (!Number.isFinite(until) || until <= now.getTime()) continue;
      const key = `${row.providerId}\u0000${modelId}`;
      const existing = coolingUntilByKey.get(key);
      if (existing === undefined || until < existing) coolingUntilByKey.set(key, until);
    }
  }

  // Telemetry records the model the *caller* asked for, which is either
  // `provider/model` (a pinned route) or a bare id. Both forms resolve to the
  // same published row, so the index carries both spellings.
  const traffic = new Map<
    string,
    { requests: number; failures: number; buckets: Map<number, { requests: number; failures: number }> }
  >();
  for (const row of bucketRows) {
    const providerId = row.providerId;
    const requestedModel = row.requestedModel;
    if (providerId === null || requestedModel === null) continue;
    const modelId = requestedModel.includes("/")
      ? requestedModel.slice(requestedModel.indexOf("/") + 1)
      : requestedModel;
    const key = `${providerId}\u0000${modelId}`;
    // `bucket` is the epoch-milliseconds bucket index the query grouped by.
    const at = Number(row.bucket) * stepMs;
    if (!Number.isFinite(at)) continue;
    const entry = traffic.get(key) ?? { requests: 0, failures: 0, buckets: new Map() };
    const requests = Number(row.requests);
    const failures = Number(row.failures);
    entry.requests += requests;
    entry.failures += failures;
    const prior = entry.buckets.get(at);
    entry.buckets.set(at, {
      requests: (prior?.requests ?? 0) + requests,
      failures: (prior?.failures ?? 0) + failures,
    });
    traffic.set(key, entry);
  }

  const modelRows: StatusModelRow[] = [];
  for (const model of published) {
    const key = `${model.providerId}\u0000${model.modelId}`;
    const entry = traffic.get(key);
    const coolingUntil = coolingUntilByKey.get(key) ?? null;
    const requests = entry?.requests ?? 0;
    const failures = entry?.failures ?? 0;
    const failureShare = requests === 0 ? 0 : failures / requests;
    const buckets: StatusBucket[] = [];
    for (let index = 0; index < STATUS_BUCKET_COUNT; index += 1) {
      const atMs = windowStartMs + index * stepMs;
      const counts = entry?.buckets.get(atMs);
      const bucketRequests = counts?.requests ?? 0;
      const bucketFailures = counts?.failures ?? 0;
      const share = bucketRequests === 0 ? 0 : bucketFailures / bucketRequests;
      buckets.push({
        at: new Date(atMs).toISOString(),
        state: bucketRequests === 0 ? "idle" : classifyFailureShare(share),
        requests: bucketRequests,
        failures: bucketFailures,
      });
    }
    modelRows.push({
      id: `${model.providerId}/${model.modelId}`,
      providerId: model.providerId,
      modelId: model.modelId,
      successPercent: requests === 0 ? null : Math.round((1 - failureShare) * 1000) / 10,
      state: classifyModelState(requests, failures, coolingUntil === null ? null : new Date(coolingUntil).toISOString()),
      coolingUntil: coolingUntil === null ? null : new Date(coolingUntil).toISOString(),
      requests,
      failures,
      ...(requests > 0 ? { buckets } : {}),
    });
  }

  modelRows.sort((left, right) => left.id.localeCompare(right.id));
  return {
    windowHours: STATUS_WINDOW_HOURS,
    bucketMinutes: Math.round(stepMs / 60_000),
    generatedAt: now.toISOString(),
    summary: {
      models: modelRows.length,
      healthy: modelRows.filter((row) => row.state === "ok").length,
      degraded: modelRows.filter((row) => row.state === "degraded").length,
      down: modelRows.filter((row) => row.state === "down").length,
    },
    models: modelRows,
  };
}
