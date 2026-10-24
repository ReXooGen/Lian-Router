// Console surface for model-abuse bans: HTTP routes.
//
// Owns validation, access, and audit; reads and writes bans only through the
// strike service. A ban is keyed on the client address, so these routes are
// platform-admin only — a tenant operator must never see, or lift, an address
// ban that applies to other tenants' traffic.

import { Elysia, t } from "elysia";
import { ConsoleDomainError, errorResponse, requireGlobalAdmin } from "../../shared/errors";
import type { ModelAbuseRoutesConfig } from "./contracts";

const banBody = t.Object({
  ip: t.String({ minLength: 1, maxLength: 45 }),
});

const unbanBody = t.Object({
  ip: t.String({ minLength: 1, maxLength: 45 }),
});

export function createModelAbuseRoutes(config: ModelAbuseRoutesConfig): Elysia {
  return new Elysia()
    .get("/model-bans", async ({ request, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        return { bans: await config.strikes.listBans() };
      } catch (error) {
        return errorResponse(error, set, "Model ban read failed");
      }
    })
    .post("/model-bans", { body: banBody }, async ({ request, body, set }) => {
      try {
        const access = requireGlobalAdmin(config.accessResolver(request));
        const ban = await config.strikes.ban(body.ip);
        await config.auditSink?.record({
          access,
          action: "model_ban.created",
          target: ban.ip,
          detail: { expiresAt: ban.expiresAt, reason: ban.reason },
        });
        return { ban };
      } catch (error) {
        return errorResponse(error, set, "Model ban failed");
      }
    })
    .delete("/model-bans", { body: unbanBody }, async ({ request, body, set }) => {
      try {
        const access = requireGlobalAdmin(config.accessResolver(request));
        const removed = await config.strikes.unban(body.ip);
        if (!removed) throw new ConsoleDomainError("ban_not_found", 404, "No such ban");
        await config.auditSink?.record({
          access,
          action: "model_ban.lifted",
          target: body.ip,
        });
        return { success: true };
      } catch (error) {
        return errorResponse(error, set, "Model unban failed");
      }
    }) as unknown as Elysia;
}
