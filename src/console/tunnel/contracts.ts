// Tunnel control-plane contracts.
//
// Tunnel state is process-local by design: the host is minted for the child
// process cloudflared starts, so it cannot be persisted, migrated, or shared
// between gateway instances. Everything here is therefore a read of the
// in-memory lifecycle in `service.ts`.

import type { ConsoleAccessResolver } from "../auth/access";
import type { AuditSink } from "../domains/audit/contracts";
import { errorResponse, requireTenantScope } from "../shared/errors";
import { Elysia } from "elysia";
import type { AccessDecision } from "../../security/access-control";
import type { TunnelService } from "./service";

/** What the dashboard renders for the tunnel row. */
export interface TunnelStatus {
  /** True only once a public host is being advertised. */
  readonly running: boolean;
  readonly publicUrl: string | null;
  readonly startedAt: string | null;
  /** Last start/exit failure, cleared by a successful start or a stop. */
  readonly error: string | null;
}

/** The access-checked operations the routes call; each takes the caller's decision. */
export interface TunnelOperations {
  status(access: AccessDecision | undefined): TunnelStatus;
  start(access: AccessDecision | undefined): Promise<TunnelStatus>;
  stop(access: AccessDecision | undefined): Promise<TunnelStatus>;
}

export interface TunnelRoutesConfig {
  readonly service: Pick<TunnelService, "status" | "start" | "stop">;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
}

/**
 * Access is tenant-scoped rather than instance-scoped: the tunnel forwards to
 * this one gateway process, which every tenant shares, but the switch belongs
 * to the operator's console. Requiring a tenant keeps an unscoped platform
 * decision from being the only thing standing between a caller and a public
 * exposure of the whole gateway.
 */
export function createTunnelOperations(config: TunnelRoutesConfig): TunnelOperations {
  return {
    status(access: AccessDecision | undefined): TunnelStatus {
      requireTenantScope(access, "dashboard:read");
      return config.service.status();
    },
    async start(access: AccessDecision | undefined): Promise<TunnelStatus> {
      const authorized = requireTenantScope(access, "dashboard:write");
      try {
        const status = await config.service.start();
        await config.auditSink?.record({
          access: authorized,
          action: "tunnel.started",
          target: authorized.tenantId,
          detail: { running: status.running, publicUrl: status.publicUrl },
        });
        return status;
      } catch (error) {
        // A failed attempt is the one an operator most needs to find later: it
        // says who tried to expose this gateway and why it did not work.
        await config.auditSink?.record({
          access: authorized,
          action: "tunnel.start_failed",
          target: authorized.tenantId,
          detail: { error: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      }
    },
    async stop(access: AccessDecision | undefined): Promise<TunnelStatus> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const status = await config.service.stop();
      await config.auditSink?.record({
        access: authorized,
        action: "tunnel.stopped",
        target: authorized.tenantId,
      });
      return status;
    },
  };
}

function tunnelErrorResponse(error: unknown, set: { status?: number | string }) {
  return errorResponse(error, set, "Tunnel operation failed", { detailsPolicy: "omit" });
}

export function createTunnelRoutes(config: TunnelRoutesConfig): Elysia {
  const factory = createTunnelOperations(config);
  return new Elysia({ prefix: "/tunnel" })
    .get("/", ({ request, set }) => {
      try {
        return factory.status(config.accessResolver(request));
      } catch (e) {
        return tunnelErrorResponse(e, set);
      }
    })
    .post("/start", async ({ request, set }) => {
      try {
        return await factory.start(config.accessResolver(request));
      } catch (e) {
        return tunnelErrorResponse(e, set);
      }
    })
    .post("/stop", async ({ request, set }) => {
      try {
        return await factory.stop(config.accessResolver(request));
      } catch (e) {
        return tunnelErrorResponse(e, set);
      }
    }) as unknown as Elysia;
}
