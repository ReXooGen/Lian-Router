// Security surface: lift the network-layer IP bans.
//
// Two stores hold a locked-out client, and both must be reachable from one
// place or the operator fixes half the problem:
//
//  - `IpAbuseProtectionService` (Redis) — the `/v1/*` admission layer. Its ban
//    marker plus the identity-wide escalation counter decide every gateway
//    request; this is the lockout behind the dashboard's "Access Restricted"
//    page.
//  - `ConsoleLockoutService` (Postgres `console_lockouts`) — the console login
//    lockout after repeated bad passwords.
//
// Both ban by client address, both lapse on their own, and a false positive
// (a shared NAT, a test harness, a misconfigured health checker) must be
// liftable without SQL. Platform-admin only: a ban is a cross-tenant security
// decision.

import { Elysia, t } from "elysia";
import { ConsoleDomainError, errorResponse, requireGlobalAdmin } from "../../shared/errors";
import type { AuditSink } from "../audit/contracts";
import type { ConsoleAccessResolver } from "../../auth/access";
import type { IpAbuseProtectionService } from "../../../security/abuse";
import type { ConsoleLockoutService } from "../../auth/service";

export interface SecurityRoutesConfig {
  readonly ipAbuseProtection?: IpAbuseProtectionService | undefined;
  readonly consoleLockouts?: ConsoleLockoutService | undefined;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink | undefined;
}

const unbanBody = t.Object({
  ip: t.String({ minLength: 1, maxLength: 45 }),
});

export function createSecurityRoutes(config: SecurityRoutesConfig): Elysia {
  return new Elysia()
    .post(
      "/security/ip-unban",
      { body: unbanBody },
      async ({ request, body, set }) => {
        try {
          const access = requireGlobalAdmin(config.accessResolver(request));
          const ip = body.ip.trim();
          if (config.ipAbuseProtection === undefined && config.consoleLockouts === undefined) {
            throw new ConsoleDomainError(
              "security_surface_unavailable",
              503,
              "No ban store is wired into this composition",
            );
          }
          const lifted: string[] = [];
          const failures: string[] = [];
          if (config.ipAbuseProtection !== undefined) {
            try {
              if (await config.ipAbuseProtection.unban(ip)) lifted.push("gateway_admission");
              else failures.push("gateway_admission:not_banned");
            } catch (error) {
              failures.push(
                `gateway_admission:${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (config.consoleLockouts !== undefined) {
            try {
              if (await config.consoleLockouts.liftLockout(ip)) lifted.push("console_login");
              else failures.push("console_login:not_locked");
            } catch (error) {
              failures.push(
                `console_login:${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          // At least one store must have carried the ban: "not banned" from
          // every store means the operator typed an address nothing locked,
          // which is a caller mistake, not a success.
          if (lifted.length === 0) {
            const notFound = failures.every((f) => f.endsWith(":not_banned"));
            throw new ConsoleDomainError(
              "ban_not_found",
              notFound ? 404 : 502,
              notFound ? "That address holds no active ban" : failures.join("; "),
            );
          }
          await config.auditSink?.record({
            access,
            action: "security.ip_unbanned",
            target: `ip:${ip}`,
            detail: { lifted, ...(failures.length > 0 ? { failures } : {}) },
          });
          return { success: true, lifted, ...(failures.length > 0 ? { failures } : {}) };
        } catch (error) {
          return errorResponse(error, set, "IP unban failed");
        }
      },
    ) as unknown as Elysia;
}
