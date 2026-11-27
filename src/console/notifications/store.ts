import type { RedisClient } from "../../persistence/redis";
import { log } from "../../observability/logger";

export interface CheckinEvidence {
  readonly state: "due" | "completed";
  readonly dayKey: string;
  readonly observedAt: string;
  readonly credit: number | null;
  readonly streakDays: number | null;
}

export function notificationCacheKey(accountId: string): string {
  return `lianrouter:notifications:v1:${accountId}`;
}

function evidenceKey(providerId: string, accountId: string, dayKey: string): string {
  return `lianrouter:checkin-evidence:v1:${providerId}:${accountId}:${dayKey}`;
}

/** A reservation in the sweep ledger is deliberately never accepted as evidence. */
export async function recordCheckinEvidence(
  redis: Pick<RedisClient, "get" | "set" | "del">,
  providerId: string,
  accountId: string,
  evidence: CheckinEvidence,
): Promise<void> {
  try {
    await redis.set(evidenceKey(providerId, accountId, evidence.dayKey), JSON.stringify(evidence), "EX", 3 * 24 * 60 * 60);
    await redis.del(notificationCacheKey(accountId));
  } catch (error) {
    log.warn(`[notifications] check-in evidence unavailable account=${accountId}`, error as Error);
  }
}

export async function readCheckinEvidence(
  redis: Pick<RedisClient, "get">,
  providerId: string,
  accountId: string,
  dayKey: string,
): Promise<CheckinEvidence | null> {
  const raw = await redis.get(evidenceKey(providerId, accountId, dayKey));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as CheckinEvidence;
    if (value.dayKey !== dayKey || !["due", "completed"].includes(value.state) || !Number.isFinite(Date.parse(value.observedAt))) return null;
    return value;
  } catch {
    return null;
  }
}

/** Successful redemption suppresses a campaign still returned by an eventually consistent preview. */
export async function recordClaimedPlan(redis: Pick<RedisClient, "set" | "del">, accountId: string, planId: string, endsAt?: string | null): Promise<void> {
  try {
    const end = Date.parse(endsAt ?? "");
    const ttl = Number.isFinite(end) ? Math.max(60, Math.ceil((end - Date.now()) / 1000)) : 90 * 24 * 60 * 60;
    await redis.set(claimedPlanKey(accountId, planId), "1", "EX", ttl);
    await redis.del(notificationCacheKey(accountId));
  } catch (error) {
    log.warn(`[notifications] claimed-plan evidence unavailable account=${accountId}`, error as Error);
  }
}

export function claimedPlanKey(accountId: string, planId: string): string {
  return `lianrouter:claimed-plan:v1:${accountId}:${encodeURIComponent(planId)}`;
}
