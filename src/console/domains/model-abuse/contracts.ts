// Console surface for model-abuse bans: list active bans, lift one, or place
// one immediately.
//
// The strike layer (`security/model-abuse.ts`) bans a client address after
// repeated invalid-model requests. A ban lapses on its own after its TTL, and
// this is the escape hatch for lifting one early — a false positive (a shared
// NAT, a client that genuinely mistyped a model id) must be fixable without
// SQL. It is a platform-admin surface: a ban is a security decision and the
// identity values are cross-tenant.

import type { AuditSink } from "../audit/contracts";
import type { ConsoleAccessResolver } from "../../auth/access";
import type { ModelStrikeService } from "../../../security/model-abuse";

export interface ModelAbuseRoutesConfig {
  /** The strike service, narrowed to the operator-facing operations. */
  readonly strikes: Pick<ModelStrikeService, "listBans" | "unban" | "ban">;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
}
