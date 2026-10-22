-- Prompt Injection: one entry per (tenant, scope, target).
--
-- Apply by hand on databases created before this baseline edit; the ledger
-- runner only consumes the top-level baseline. Fresh installs get the same
-- shape from `0000_baseline.sql`.
CREATE TABLE IF NOT EXISTS "prompt_injections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "target" text NOT NULL DEFAULT '',
  "mode" text NOT NULL DEFAULT 'prompt',
  "preset" text NOT NULL DEFAULT 'custom',
  "content" text NOT NULL DEFAULT '',
  "turns" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "position" text NOT NULL DEFAULT 'append',
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "prompt_injections_scope_check" CHECK ("scope" in ('global', 'key', 'model')),
  CONSTRAINT "prompt_injections_mode_check" CHECK ("mode" in ('prompt', 'script')),
  CONSTRAINT "prompt_injections_preset_check" CHECK ("preset" in ('custom', 'assistant', 'uncensored')),
  CONSTRAINT "prompt_injections_position_check" CHECK ("position" in ('prepend', 'append'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "prompt_injections_tenant_scope_target_idx" ON "prompt_injections" USING btree ("tenant_id", "scope", "target");
CREATE INDEX IF NOT EXISTS "prompt_injections_tenant_idx" ON "prompt_injections" USING btree ("tenant_id");
