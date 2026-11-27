import type { ProviderNotification } from "../../../src/console/notifications/contracts";

export const MAX_READ_NOTIFICATION_IDS = 1_000;

export function notificationReadStorageKey(userId: string): string {
  return `lianrouter:notifications:read:v1:${encodeURIComponent(userId)}`;
}

/** Old identities expire first; reading an identity again keeps it in the cap. */
export function markNotificationsRead(
  previous: readonly string[],
  ids: readonly string[],
): string[] {
  const next = new Set(previous);
  for (const id of ids) {
    if (!id) continue;
    next.delete(id);
    next.add(id);
  }
  return Array.from(next).slice(-MAX_READ_NOTIFICATION_IDS);
}

export function parseReadNotificationIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return markNotificationsRead([], parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return [];
  }
}

export function uniqueNotifications(items: readonly ProviderNotification[]): ProviderNotification[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function unreadNotificationCount(
  items: readonly ProviderNotification[],
  readIds: readonly string[],
): number {
  const seen = new Set(readIds);
  let count = 0;
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    count += 1;
  }
  return count;
}
