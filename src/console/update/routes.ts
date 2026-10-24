// Update control-plane routes.
//
// Thin transport over `createUpdateOperations`: the access check, the launcher
// call, and the wire shape live in `contracts.ts`, so this file only maps
// throws into the console error envelope.

import { Elysia } from "elysia";
import { errorResponse } from "../shared/errors";
import { createUpdateOperations, type UpdateRoutesConfig } from "./contracts";

function updateErrorResponse(error: unknown, set: { status?: number | string }) {
  return errorResponse(error, set, "Update operation failed", { detailsPolicy: "omit" });
}

export function createUpdateRoutes(config: UpdateRoutesConfig): Elysia {
  const factory = createUpdateOperations(config);
  return new Elysia({ prefix: "/update" })
    .get("/", async ({ request, set }) => {
      try {
        return await factory.status(config.accessResolver(request));
      } catch (e) {
        return updateErrorResponse(e, set);
      }
    })
    .post("/start", async ({ request, set }) => {
      try {
        const accepted = await factory.start(config.accessResolver(request));
        // 202: the install outlives the request, and the gateway is stopped
        // underneath it. The dashboard polls `GET /update` for progress.
        set.status = 202;
        return accepted;
      } catch (e) {
        return updateErrorResponse(e, set);
      }
    }) as unknown as Elysia;
}
