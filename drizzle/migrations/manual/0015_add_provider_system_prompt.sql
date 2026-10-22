-- Hand-run once on any database created from the previous baseline.
--
-- Moves the per-provider system prompt from `providers.system_prompt` to
-- `provider_routing_settings.system_prompt`. It is optional text prepended to
-- every request routed to that provider, as a canonical `system` part; NULL
-- injects nothing, which is the default for every row.
--
-- Why per provider: the reason to add one is a property of the upstream — it
-- wants a nudge, a format reminder, or a routing hint — and a single global
-- prompt would corrupt every model that did not expect it.
--
-- Why the column moved: `providers` is the catalog row, and for a built-in
-- provider that row is seeded and owned by the build — the console refuses to
-- write it (`provider_is_builtin`). A setting an operator is expected to edit
-- cannot live where the operator is refused, and `grok`/`codex` are exactly
-- the providers that need a hint. `provider_routing_settings` already holds the
-- other per-provider operator settings and is written per tenant, so the
-- prompt moves beside them.
--
-- `0000_baseline.sql` carries the column on `provider_routing_settings` and no
-- longer on `providers`, so a database created today never has the old one. A
-- database created before that edit still does: the ledger
-- (`lianrouter_schema_migrations`) records `0000_baseline.sql` as applied, so
-- `bun run db:migrate` will NOT re-run the edited baseline.
--
-- Idempotent: safe to run more than once, and safe on a database that never
-- had the old column.

ALTER TABLE provider_routing_settings ADD COLUMN IF NOT EXISTS system_prompt text;

-- The move is guarded on the old column existing. A database created from the
-- current baseline has no `providers.system_prompt`, and an unguarded
-- `SELECT p.system_prompt` would fail there with `42703 undefined_column`
-- instead of being the no-op this file promises.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'providers'
      AND column_name = 'system_prompt'
  ) THEN
    RETURN;
  END IF;

  -- A NULL `tenant_id` on a `providers` row means a bundled provider (custom
  -- ones are always tenant-owned), so the prompt becomes that provider's
  -- global routing row — which every tenant inherits until it sets its own,
  -- matching the reach the column had while it lived on the catalog row.
  --
  -- Written as an upsert because a global routing row usually already exists
  -- for a provider the operator configured. A row with no routing settings at
  -- all is still created rather than dropped: losing the operator's text to a
  -- missing row would be worse than materializing defaults that the router
  -- already assumes.
  INSERT INTO provider_routing_settings (provider_id, tenant_id, system_prompt)
  SELECT p.id, NULL, p.system_prompt
  FROM providers p
  WHERE p.system_prompt IS NOT NULL
    AND p.tenant_id IS NULL
  ON CONFLICT (provider_id) WHERE tenant_id IS NULL
  DO UPDATE SET system_prompt = EXCLUDED.system_prompt
  WHERE provider_routing_settings.system_prompt IS NULL;

  -- A tenant-owned provider keeps its text on that tenant's routing row. The
  -- conflict target is the tenant-scoped unique index, which is a plain
  -- (tenant_id, provider_id) pair.
  INSERT INTO provider_routing_settings (provider_id, tenant_id, system_prompt)
  SELECT p.id, p.tenant_id, p.system_prompt
  FROM providers p
  WHERE p.system_prompt IS NOT NULL
    AND p.tenant_id IS NOT NULL
  ON CONFLICT (tenant_id, provider_id)
  DO UPDATE SET system_prompt = EXCLUDED.system_prompt
  WHERE provider_routing_settings.system_prompt IS NULL;
END $$;

ALTER TABLE providers DROP COLUMN IF EXISTS system_prompt;
