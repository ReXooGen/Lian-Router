// Appeal console routes.
//
// GET  /automation/appeal/accounts?providerId=cb   → banned accounts + counts
// POST /automation/appeal/send                     → appeal N banned accounts
// POST /automation/appeal/recheck                  → derive accepted/declined
//
// Reads are `dashboard:write`-gated reads sharing the report surface's shape:
// the list shows only what the health classifier itself disabled
// (`policy_blocked_banned`), never the whole account table. Sends are tenant
// -scoped like every console mutation and audited as `automation.appeal.send`.

import { Elysia } from "elysia";
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../../shared/errors";
import {
  APPEAL_ACCOUNT_PAGE_LIMIT,
  normalizeAppealLimit,
  normalizeAppealMessage,
  normalizeAppealModelId,
  normalizeAppealProviderId,
  normalizeAppealStatus,
  toAppealAccountRow,
  type AppealAccountsResponse,
  type AppealRecheckResponse,
  type AppealRoutesConfig,
  type AppealSendResponse,
} from "./contracts";
import { runAppealPass, runAppealRecheck } from "./service";

export function createAppealRoutes(config: AppealRoutesConfig): Elysia {
  return new Elysia({ prefix: "/automation/appeal" })
    .get("/accounts", async ({ request, set }) => {
      try {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:read");
        const params = new URL(request.url).searchParams;
        const providerId = normalizeAppealProviderId(params.get("providerId"));
        const status = normalizeAppealStatus(params.get("status"));

        // Two reads, mirroring the report surface: `counts` describes every
        // banned account while `accounts` is capped and filtered, so deriving
        // counts from the page would under-report.
        const [counts, accounts] = await Promise.all([
          config.store.countAccounts({ tenantId: access.tenantId, providerId }),
          config.store.listAccounts({
            tenantId: access.tenantId,
            providerId,
            limit: APPEAL_ACCOUNT_PAGE_LIMIT,
            status,
          }),
        ]);

        const response: AppealAccountsResponse = {
          providerId,
          counts,
          accounts: accounts.map(toAppealAccountRow),
        };
        return response;
      } catch (error) {
        return errorResponse(error, set, "Failed to read appeal accounts");
      }
    })
    .post("/send", async ({ request, body, set }) => {
      try {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new ConsoleDomainError("invalid_request", 400, "Provide providerId and limit");
        }
        const payload = body as Record<string, unknown>;
        const providerId = normalizeAppealProviderId(payload["providerId"]);
        const limit = normalizeAppealLimit(payload["limit"]);
        const message = normalizeAppealMessage(payload["message"]);
        // Re-send to already-appealed accounts must be explicit: a batch that
        // silently re-files dozens of duplicate tickets reads as abuse to the
        // same risk system that banned the accounts.
        const resend = payload["resend"] === true;

        const result: AppealSendResponse = await runAppealPass({
          deps: config,
          providerId,
          limit,
          tenantId: access.tenantId,
          message,
          onlyUnappealed: !resend,
        });
        await config.auditSink?.record({
          access,
          action: "automation.appeal.send",
          target: providerId,
          detail: { attempted: result.attempted, succeeded: result.succeeded, failed: result.failed },
        });
        return result;
      } catch (error) {
        return errorResponse(error, set, "Failed to send appeals");
      }
    })
    .post("/recheck", async ({ request, body, set }) => {
      try {
        const access = requireTenantScope(config.accessResolver(request), "dashboard:write");
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new ConsoleDomainError("invalid_request", 400, "Provide providerId and limit");
        }
        const payload = body as Record<string, unknown>;
        const providerId = normalizeAppealProviderId(payload["providerId"]);
        const limit = normalizeAppealLimit(payload["limit"]);
        const requestedModelId = normalizeAppealModelId(payload["modelId"]);
        // The probe needs a real model; fall back to the provider's first enabled
        // one so the common case needs no body field. No model is a request
        // error, not an empty result.
        const modelId = requestedModelId ?? (await config.store.defaultProbeModelId(providerId));
        if (modelId === null) {
          throw new ConsoleDomainError(
            "invalid_request",
            400,
            `No enabled model registered for provider "${providerId}"; pass modelId`,
          );
        }

        const result: AppealRecheckResponse = await runAppealRecheck({
          deps: config,
          providerId,
          tenantId: access.tenantId,
          modelId,
          limit,
        });
        await config.auditSink?.record({
          access,
          action: "automation.appeal.recheck",
          target: providerId,
          detail: {
            modelId,
            attempted: result.attempted,
            accepted: result.accepted,
            declined: result.declined,
            pending: result.pending,
          },
        });
        return result;
      } catch (error) {
        return errorResponse(error, set, "Failed to recheck appeals");
      }
    }) as unknown as Elysia;
}
