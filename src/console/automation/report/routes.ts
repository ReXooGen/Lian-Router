// Growth-activity report console routes.
//
// GET  /automation/report/accounts?providerId=cb  → accounts + counts + schedule
// POST /automation/report/hit                     → fire N unhit accounts
// GET  /automation/report/schedule?providerId=cb  → saved schedule
// PUT  /automation/report/schedule                → replace the schedule
//
// Reads are `dashboard:read`, writes `dashboard:write`. Every route is
// tenant-scoped: an operator sees and reports their own accounts, never another
// tenant's, even though the background sweep is deliberately tenant-wide.

import { Elysia } from "elysia";
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../../shared/errors";
import {
  REPORT_ACCOUNT_PAGE_LIMIT,
  normalizeReportLimit,
  normalizeReportProviderId,
  normalizeReportScheduleInput,
  normalizeReportStatus,
  toReportAccountRow,
  toReportSchedule,
  type ReportAccountsResponse,
  type ReportScheduleResponse,
  type ReportRoutesConfig,
} from "./contracts";
import { runReportPass } from "./service";

export function createReportRoutes(config: ReportRoutesConfig): Elysia {
  return new Elysia({ prefix: "/automation/report" })
    .get("/accounts", async ({ request, set }) => {
      try {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:read");
        const params = new URL(request.url).searchParams;
        const providerId = normalizeReportProviderId(params.get("providerId"));
        const status = normalizeReportStatus(params.get("status"));

        // Two reads, not one: `counts` must describe every account of the
        // provider while `accounts` is capped and filtered, so deriving counts
        // from the page would under-report in two different ways.
        const [counts, accounts, schedule] = await Promise.all([
          config.store.countAccounts(access.tenantId, providerId),
          config.store.listAccounts(access.tenantId, providerId, REPORT_ACCOUNT_PAGE_LIMIT, status),
          config.store.readSchedule(providerId),
        ]);

        const response: ReportAccountsResponse = {
          providerId,
          counts,
          accounts: accounts.map(toReportAccountRow),
          schedule: toReportSchedule(schedule),
        };
        return response;
      } catch (error) {
        return errorResponse(error, set, "Failed to read report accounts");
      }
    })
    .post("/hit", async ({ request, body, set }) => {
      try {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new ConsoleDomainError("invalid_request", 400, "Provide providerId and limit");
        }
        const payload = body as Record<string, unknown>;
        const providerId = normalizeReportProviderId(payload["providerId"]);
        const limit = normalizeReportLimit(payload["limit"]);

        const result = await runReportPass({
          deps: config,
          providerId,
          limit,
          tenantId: access.tenantId,
        });
        await config.auditSink?.record({
          access,
          action: "automation.report.hit",
          target: providerId,
          detail: { attempted: result.attempted, succeeded: result.succeeded, failed: result.failed },
        });
        return result;
      } catch (error) {
        return errorResponse(error, set, "Failed to run the activity report");
      }
    })
    .get("/schedule", async ({ request, set }) => {
      try {
        requireTenantScope(config.accessResolver(request), "dashboard:read");
        const params = new URL(request.url).searchParams;
        const providerId = normalizeReportProviderId(params.get("providerId"));
        const schedule = await config.store.readSchedule(providerId);
        const response: ReportScheduleResponse = { providerId, ...toReportSchedule(schedule) };
        return response;
      } catch (error) {
        return errorResponse(error, set, "Failed to read the report schedule");
      }
    })
    .put("/schedule", async ({ request, body, set }) => {
      try {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new ConsoleDomainError("invalid_request", 400, "Provide the schedule fields");
        }
        const payload = body as Record<string, unknown>;
        const providerId = normalizeReportProviderId(payload["providerId"]);
        const input = normalizeReportScheduleInput(payload);
        const saved = await config.store.saveSchedule({
          providerId,
          ...input,
          at: new Date(),
        });
        await config.auditSink?.record({
          access,
          action: "automation.report.schedule.updated",
          target: providerId,
          detail: { ...input },
        });
        const response: ReportScheduleResponse = { providerId, ...toReportSchedule(saved) };
        return response;
      } catch (error) {
        return errorResponse(error, set, "Failed to save the report schedule");
      }
    }) as unknown as Elysia;
}
