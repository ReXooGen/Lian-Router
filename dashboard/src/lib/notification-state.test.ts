import { describe, expect, test } from "bun:test";
import {
  MAX_READ_NOTIFICATION_IDS,
  markNotificationsRead,
  notificationReadStorageKey,
  parseReadNotificationIds,
  unreadNotificationCount,
  uniqueNotifications,
} from "./notification-state";
import type { ProviderNotification } from "../../../src/console/notifications/contracts";

function notification(id: string, kind: ProviderNotification["kind"] = "checkin_due"): ProviderNotification {
  return {
    id,
    kind,
    providerId: "workbuddy",
    accountId: "account-1",
    accountLabel: "Daily account",
    title: "Daily check-in",
    message: "Check-in is available.",
    href: "/providers/workbuddy",
    occurredAt: "2026-11-27T00:00:00.000Z",
    dayKey: "2026-11-27",
  };
}

describe("notification read state", () => {
  test("deduplicates snapshots and keeps completion unread after reading a due item", () => {
    const due = notification("account-1:2026-11-27:due");
    const completed = notification("account-1:2026-11-27:completed", "checkin_completed");
    const read = markNotificationsRead([], [due.id]);
    expect(uniqueNotifications([due, due])).toEqual([due]);
    expect(unreadNotificationCount([due, due], read)).toBe(0);
    expect(unreadNotificationCount([completed, completed], read)).toBe(1);
    expect(unreadNotificationCount([notification("unknown", "status_unknown")], read)).toBe(1);
  });

  test("mark all reads only the current snapshot and does not swallow future events", () => {
    const items = [notification("due"), notification("campaign", "plan_claimable")];
    const read = markNotificationsRead(["older"], items.map((item) => item.id));
    expect(unreadNotificationCount(items, read)).toBe(0);
    expect(unreadNotificationCount([...items, notification("tomorrow")], read)).toBe(1);
    expect(read).toContain("older");
  });

  test("caps stored identities while keeping the most recently read ids", () => {
    const ids = Array.from({ length: MAX_READ_NOTIFICATION_IDS + 3 }, (_, index) => `event-${index}`);
    const read = markNotificationsRead(ids, ["event-0", "new", "new"]);
    expect(read).toHaveLength(MAX_READ_NOTIFICATION_IDS);
    expect(read.slice(-2)).toEqual(["event-0", "new"]);
    expect(new Set(read).size).toBe(read.length);
    expect(parseReadNotificationIds(JSON.stringify(ids))).toHaveLength(MAX_READ_NOTIFICATION_IDS);
  });

  test("ignores broken storage and scopes read state to the stable user id", () => {
    expect(parseReadNotificationIds(null)).toEqual([]);
    expect(parseReadNotificationIds("broken")).toEqual([]);
    expect(parseReadNotificationIds('{"id":"due"}')).toEqual([]);
    expect(parseReadNotificationIds('["due",null,2,"", "due"]')).toEqual(["due"]);
    expect(notificationReadStorageKey("user/a")).not.toBe(notificationReadStorageKey("user%2Fa"));
    expect(notificationReadStorageKey("user-a")).not.toBe(notificationReadStorageKey("user-b"));
  });
});
