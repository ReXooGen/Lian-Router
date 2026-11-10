import { CalendarPlus, Loader2, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/state";
import { Inline } from "../../components/ui/inline";
import { Select } from "../../components/ui/select";
import { Stack } from "../../components/ui/stack";
import {
  useClaimProviderPlan,
  useProviderClaimVerification,
  useProviderClaims,
} from "../../lib/hooks/providers";
import { ClaimCaptchaDialog } from "./ClaimCaptchaDialog";
import { useAccountQuota } from "../../lib/hooks/quota";
import type { QuotaWindow } from "../../lib/hooks/quota";
import { getErrorMessage } from "../../lib/helpers";
import { pendingGrantLabel } from "../../lib/quota-formatters";

/** Providers whose accounts expose claimable campaigns. */
const CLAIM_PROVIDER_IDS: Readonly<Record<string, true>> = { zcode: true };

export function supportsPlanClaims(providerId: string): boolean {
  return CLAIM_PROVIDER_IDS[providerId] === true;
}

/**
 * Claimable campaigns for one start-plan account.
 *
 * The account picker is the whole point of the section: campaigns are per
 * account, so a provider with several logins must be read one account at a
 * time. The list is the union of both surfaces that advertise a campaign
 * (billing preview and marketing deliveries), and a claim the upstream gates
 * behind a captcha is reported as its own state rather than a generic failure —
 * it is finished in the desktop app, not here.
 */
export function ClaimPlansCard({
  providerId,
  accounts,
}: {
  readonly providerId: string;
  readonly accounts: readonly { readonly id: string; readonly label: string; readonly status: string }[];
}): ReactNode {
  const [selectedId, setSelectedId] = useState<string>("");
  const activeId = selectedId.length > 0 ? selectedId : (accounts[0]?.id ?? "");
  const claims = useProviderClaims(activeId, supportsPlanClaims(providerId));
  const claim = useClaimProviderPlan();
  // The captcha config is read lazily: it is only needed once a claim is
  // refused with the vendor's captcha code, and reading it on every render
  // would cost a vendor call for accounts that can claim directly.
  const [challenge, setChallenge] = useState<{ planId: string; planName: string } | null>(null);
  const verification = useProviderClaimVerification(
    activeId,
    supportsPlanClaims(providerId) && challenge !== null,
  );
  const plans = claims.data?.plans ?? [];
  const errors = claims.data?.errors ?? [];
  // An empty campaign list does not mean an empty account: the plans this
  // account already holds live on the quota route, and a card that showed only
  // "no claimable campaign" left an operator unable to tell a plan-holding
  // account from one with nothing at all.
  const quota = useAccountQuota(activeId, supportsPlanClaims(providerId));
  // A spent plan is still reported by the vendor, but it grants nothing, so
  // the card must not present it as a held plan. Hiding it here is what keeps
  // "Plan granted" honest: everything shown is capacity the account can draw.
  const quotaExhausted = quota.data?.quota?.exhausted === true;
  const grantedWindows = quotaExhausted ? [] : (quota.data?.quota?.windows ?? []);
  // Grants are grouped by their owning plan so two plans on one account read
  // as two plans. Without the split, a referral grant and a paid plan merged
  // into one list under one label and the operator could not tell which pool
  // a number came from.
  const grantedGroups = groupWindowsByPlan(grantedWindows);

  return (
    <Card>
      <CardHeader
        title="Claim plan"
        subtitle="Time-boxed campaigns this account can claim"
        icon={<CalendarPlus size={16} />}
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={13} className={claims.isFetching ? "animate-spin" : ""} />}
            disabled={claims.isFetching || activeId.length === 0}
            onClick={() => claims.refetch()}
          >
            {claims.isFetching ? "Checking..." : "Refresh"}
          </Button>
        }
      />
      <CardBody style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {accounts.length === 0 ? (
          <EmptyState
            title="No account to claim for"
            message="Connect an account first — campaigns are claimed per account."
          />
        ) : (
          <>
            <Inline gap="8px" align="center" style={{ flexWrap: "wrap" }}>
              <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>
                Account
              </span>
              <Select
                id="claim-account"
                value={activeId}
                onValueChange={setSelectedId}
                options={accounts.map((account) => ({
                  value: account.id,
                  label: `${account.label}${account.status === "active" ? "" : ` (${account.status})`}`,
                }))}
              />
            </Inline>

            {grantedGroups.length > 0 ? (
              <Stack gap="8px">
                {grantedGroups.map((group) => (
                  <Stack
                    key={group.plan}
                    gap="6px"
                    style={{
                      padding: "10px 12px",
                      border: "1px solid var(--inner-border)",
                      borderRadius: "8px",
                      background: "var(--surface-2)",
                    }}
                  >
                    <Inline gap="8px" align="center" style={{ flexWrap: "wrap" }}>
                      <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>
                        Plan granted
                      </span>
                      <Badge tone="ok">{group.plan}</Badge>
                      {group.pending !== null ? <Badge tone="info">{group.pending}</Badge> : null}
                      {group.exhausted ? <Badge tone="warn">spent</Badge> : null}
                    </Inline>
                    <div
                      style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: "11.5px", color: "var(--text-tertiary)" }}
                    >
                      {group.windows.map((window, index) => {
                        const pending = pendingGrantLabel(window.availableAt);
                        return (
                          <span key={`${window.kind ?? "grant"}-${index}`}>
                            {window.label}
                            {pending !== null
                              ? ` · ${pending}`
                              : window.remainingPercent !== null
                                ? ` · ${Math.round(window.remainingPercent)}% left`
                                : ""}
                          </span>
                        );
                      })}
                    </div>
                  </Stack>
                ))}
              </Stack>
            ) : null}

            {claims.isPending ? (
              <Inline gap="8px" align="center">
                <Loader2 size={14} className="animate-spin" style={{ color: "var(--accent)" }} />
                <span style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
                  Reading campaigns…
                </span>
              </Inline>
            ) : claims.isError ? (
              <p style={{ fontSize: "12.5px", color: "var(--text-secondary)" }}>
                Could not read campaigns for this account.
              </p>
            ) : plans.length === 0 && errors.length > 0 ? (
              // A read failure is not "nothing to claim": one surface may have
              // answered while the other rate-limited, and the operator needs
              // to see that difference rather than a settled empty state.
              <Stack gap="6px">
                <EmptyState
                  title="Could not read campaigns"
                  message="The vendor refused or the request timed out — this is not a confirmation that nothing is claimable."
                />
                <ClaimErrors errors={errors} />
              </Stack>
            ) : plans.length === 0 ? (
              <EmptyState
                title="No claimable campaign"
                message="This account has nothing to claim right now. Campaigns appear when the vendor runs one."
              />
            ) : (
              <Stack gap="8px">
                {plans.map((plan) => (
                  <div
                    key={plan.planId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "10px",
                      padding: "10px 12px",
                      border: "1px solid var(--inner-border)",
                      borderRadius: "8px",
                      background: "var(--surface-2)",
                      flexWrap: "wrap",
                    }}
                  >
                    <Stack gap="4px" style={{ minWidth: 0 }}>
                      <Inline gap="8px" align="center" style={{ flexWrap: "wrap" }}>
                        <span style={{ fontSize: "13px", fontWeight: 600 }}>{plan.name}</span>
                        <Badge tone="accent">{plan.source}</Badge>
                        {plan.priority !== null ? (
                          <Badge tone="default">priority {plan.priority}</Badge>
                        ) : null}
                      </Inline>
                      <span style={{ fontSize: "11.5px", color: "var(--text-tertiary)" }}>
                        {plan.planId}
                        {plan.startsAt !== null ? ` · from ${plan.startsAt.slice(0, 10)}` : ""}
                        {plan.endsAt !== null ? ` · until ${plan.endsAt.slice(0, 10)}` : ""}
                      </span>
                    </Stack>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={claim.isPending}
                      onClick={() =>
                        claim.mutate(
                          { accountId: activeId, planId: plan.planId },
                          {
                            onError: (error) => {
                              // The vendor answered "solve the captcha" rather
                              // than "you may not have this". Sending the
                              // operator to another app was the old answer;
                              // the challenge can be solved right here.
                              if (error.code === "claim_captcha_required") {
                                setChallenge({ planId: plan.planId, planName: plan.name });
                              }
                            },
                          },
                        )
                      }
                    >
                      {claim.isPending && claim.variables?.planId === plan.planId ? "Claiming..." : "Claim"}
                    </Button>
                  </div>
                ))}
                {errors.length > 0 ? <ClaimErrors errors={errors} /> : null}
              </Stack>
            )}
          </>
        )}
      </CardBody>
      <ClaimCaptchaDialog
        open={challenge !== null}
        planName={challenge?.planName ?? ""}
        config={verification.data?.config ?? null}
        submitting={claim.isPending}
        error={
          claim.isError && challenge !== null && claim.error?.code !== "claim_captcha_required"
            ? getErrorMessage(claim.error)
            : null
        }
        onSolved={(solved) => {
          if (challenge === null) return;
          claim.mutate({ accountId: activeId, planId: challenge.planId, captchaParam: solved.param, captchaRegion: solved.region }, {
            onSuccess: () => setChallenge(null),
          });
        }}
        onClose={() => setChallenge(null)}
      />
    </Card>
  );
}

/**
 * Splits one account's grants into per-plan groups.
 *
 * An account can hold several plans at once, and the vendor reports their
 * grants in one flat window list. Grouping by the window's owning plan is what
 * lets the card show two plans as two plans; a window whose plan the vendor did
 * not name falls under the account label so it is never dropped from the
 * display.
 */
function groupWindowsByPlan(
  windows: readonly QuotaWindow[],
): readonly {
  readonly plan: string;
  readonly windows: readonly QuotaWindow[];
  readonly exhausted: boolean;
  /** Set when the plan's units are granted but not yet spendable. */
  readonly pending: string | null;
}[] {
  const groups = new Map<string, QuotaWindow[]>();
  for (const window of windows) {
    const plan = window.group ?? "Plan";
    const bucket = groups.get(plan);
    if (bucket === undefined) groups.set(plan, [window]);
    else bucket.push(window);
  }
  return [...groups].map(([plan, planWindows]) => ({
    plan,
    windows: planWindows,
    // One exhausted pool does not spend a plan: a plan is spent only when
    // every pool under it is at or below zero.
    exhausted: planWindows.every(
      (window) => window.remainingPercent !== null && window.remainingPercent <= 0,
    ),
    // A plan is pending while any of its pools is still scheduled: the units
    // exist but the vendor refuses them until the scheduled instant, which is
    // what the vendor's own app shows as "Pending".
    pending: planWindows.map((window) => pendingGrantLabel(window.availableAt)).find((label) => label !== null) ?? null,
  }));
}

/** Non-fatal surface read failures, shown so a short list is not mistaken for "nothing exists". */
function ClaimErrors({ errors }: { readonly errors: readonly string[] }): ReactNode {
  return (
    <Stack gap="2px">
      {errors.map((error) => (
        <span key={error} style={{ fontSize: "11.5px", color: "var(--warning)" }}>
          {error}
        </span>
      ))}
    </Stack>
  );
}
