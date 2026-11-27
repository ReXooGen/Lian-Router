import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProviderNotificationsResponse } from "../../../../src/console/notifications/contracts";
import type { ApiErrorShape } from "../api";
import { consoleRequest } from "../api";
import { queryKeys } from "../query-keys";
import { markNotificationsRead, notificationReadStorageKey, parseReadNotificationIds } from "../notification-state";
import { querySignal } from "./common";

/** Poll the authenticated shell, with a shorter cadence while probes are pending. */
export function useProviderNotifications(userId: string) {
  return useQuery<ProviderNotificationsResponse, ApiErrorShape>({
    queryKey: queryKeys.notifications.feed(userId),
    queryFn: (context) => consoleRequest<ProviderNotificationsResponse>("/notifications", {
      signal: querySignal(context),
    }),
    staleTime: 30_000,
    refetchInterval: (query) => query.state.data?.pending ? 5_000 : 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

function loadReadIds(key: string): string[] {
  try {
    return typeof window === "undefined" ? [] : parseReadNotificationIds(window.localStorage.getItem(key));
  } catch {
    return [];
  }
}

/** The shell keys the component by user id so identities cannot cross sessions. */
export function useNotificationReadState(userId: string) {
  const key = notificationReadStorageKey(userId);
  const [readIds, setReadIds] = useState(() => loadReadIds(key));
  const [storageUnavailable, setStorageUnavailable] = useState(false);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        setReadIds(loadReadIds(key));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);

  const markRead = useCallback((ids: readonly string[]) => {
    // Merge other tabs' latest reads before saving this tab's changes.
    const next = markNotificationsRead(markNotificationsRead(loadReadIds(key), readIds), ids);
    setReadIds(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
      setStorageUnavailable(false);
    } catch {
      setStorageUnavailable(true);
    }
  }, [key, readIds]);

  return { readIds, markRead, storageUnavailable };
}
