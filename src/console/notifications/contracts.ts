/** Browser-safe notification contract. No provider credentials or raw errors cross this boundary. */
export type ProviderNotificationKind =
  | "checkin_due"
  | "checkin_completed"
  | "plan_claimable"
  | "status_unknown";

export interface ProviderNotification {
  readonly id: string;
  readonly kind: ProviderNotificationKind;
  readonly providerId: string;
  readonly accountId: string;
  readonly accountLabel: string;
  readonly title: string;
  readonly message: string;
  /** Console-relative route; navigation remains inside this gateway. */
  readonly href: string;
  readonly occurredAt: string;
  readonly dayKey: string | null;
  readonly planId?: string;
}

export interface ProviderNotificationsResponse {
  readonly items: readonly ProviderNotification[];
  readonly checkedAt: string;
  readonly pending: boolean;
}
