/**
 * Public model-status routes.
 *
 * Registered beside the share router so it is reachable without a session: a
 * status page exists for people who cannot log in, and putting it behind the
 * console would defeat it. The payload is aggregate-only (see
 * `model-status.ts`) — no account labels, credentials, or upstream error text.
 *
 * Responses are cached briefly in-process. The page polls, and a page that is
 * itself cheap is the one an operator can leave open during an incident; the
 * cache also means a burst of visitors collapses onto one database read
 * instead of one read per viewer.
 */
import { Elysia } from "elysia";
import { and, eq, isNull } from "drizzle-orm";
import type { LianRouterDatabase } from "../../persistence/postgres";
import { apiKeys, models } from "../../persistence/schema";
import { API_CONTENT_SECURITY_POLICY, X_FRAME_OPTIONS } from "../../security/outbound-headers";
import { buildStatusReport, type StatusReport } from "./model-status";

/** How long one computed report is reused. */
const REPORT_TTL_MS = 30_000;

export interface ModelStatusRoutesOptions {
  readonly db: LianRouterDatabase;
  /** Clock seam so tests can pin the window. */
  readonly now?: () => Date;
}

/**
 * Models a visitor can actually reach without their own credential.
 *
 * This page answers "is the shared access working", so it reports the models a
 * share link hands out — not the operator's private catalog. Enumerating the
 * share keys' allowlists is the same set the enrollment page advertises; a
 * status page listing four hundred private model ids would both leak the
 * operator's routing choices and answer a question nobody visiting it asked.
 *
 * Keys whose `modelAllowlist` is empty are skipped rather than expanded into
 * the whole catalog: an empty allowlist means "whatever is enabled", which on
 * a large deployment is the leak this function exists to avoid.
 */
async function publishedShareModels(
  db: LianRouterDatabase,
): Promise<readonly { providerId: string; modelId: string }[]> {
  const shareKeys = await db
    .select({ modelAllowlist: apiKeys.modelAllowlist })
    .from(apiKeys)
    // Every live share key, parents and issued children alike: they hold
    // different allowlists (a link template and the keys handed out from it can
    // diverge), and both are credentials somebody can actually call with.
    .where(and(eq(apiKeys.keyMode, "share"), isNull(apiKeys.revokedAt)));

  const wanted = new Set<string>();
  for (const key of shareKeys) {
    for (const slug of key.modelAllowlist ?? []) {
      if (typeof slug === "string" && slug.length > 0) wanted.add(slug);
    }
  }
  if (wanted.size === 0) return [];

  const rows = await db
    .select({ providerId: models.providerId, modelId: models.modelId })
    .from(models)
    .where(eq(models.enabled, true));

  // Join in memory: the allowlist holds `provider/model` strings while `models`
  // stores the pair, and a compound `in` over two columns would need a tuple
  // expression that no index here serves.
  return rows.filter((row) => wanted.has(`${row.providerId}/${row.modelId}`));
}

function responseHeaders(): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    // Short cache, matching the in-process TTL: a client polls, and a stale
    // minute is worse than a repeated read.
    "cache-control": "public, max-age=15",
    "content-security-policy": API_CONTENT_SECURITY_POLICY,
    "x-frame-options": X_FRAME_OPTIONS,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "access-control-allow-origin": "*",
  };
}

// Return type inferred: Elysia carries the registered routes in a type
// parameter, and annotating a plain `Elysia` rejects them under
// `exactOptionalPropertyTypes`. `app.use(...)` accepts the instance directly.
export function createModelStatusRoutes(options: ModelStatusRoutesOptions) {
  const now = options.now ?? (() => new Date());
  let cached: { report: StatusReport; expiresAt: number } | undefined;

  // Full path, not a `prefix`: Elysia's prefix narrows the instance generic
  // and the router is returned as a plain `Elysia`, which the annotated return
  // type rejects under `exactOptionalPropertyTypes`.
  return new Elysia().get("/status/models", async () => {
    const at = now();
    if (cached !== undefined && cached.expiresAt > at.getTime()) {
      return new Response(JSON.stringify(cached.report), { status: 200, headers: responseHeaders() });
    }
    const published = await publishedShareModels(options.db);
    const report = await buildStatusReport(options.db, published, at);
    cached = { report, expiresAt: at.getTime() + REPORT_TTL_MS };
    return new Response(JSON.stringify(report), { status: 200, headers: responseHeaders() });
  });
}
