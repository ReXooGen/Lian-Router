-- Prompt Injection: several named personas per target, one active.
--
-- Apply by hand on databases created before this baseline edit.
ALTER TABLE "prompt_injections" ADD COLUMN IF NOT EXISTS "active" boolean NOT NULL DEFAULT true;
DROP INDEX IF EXISTS "prompt_injections_tenant_scope_target_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_injections_tenant_scope_target_name_idx"
  ON "prompt_injections" USING btree ("tenant_id", "scope", "target", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_injections_active_target_uidx"
  ON "prompt_injections" USING btree ("tenant_id", "scope", "target") WHERE "active";
