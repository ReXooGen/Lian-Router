-- Hand-run once on any database created from the previous baseline.
--
-- Adds `provider_accounts.bypass_proxy`: this account dials direct, ignoring the
-- tenant's provider-wide pool group. FALSE (the default, and what every existing
-- row gets) preserves today's behavior exactly — an unbound account still joins
-- the tenant group — so this migration changes no routing by itself.
--
-- Why a separate column rather than a sentinel in `network_pool_id`: NULL there
-- already means "join the tenant pool group", so before this there was no way to
-- express "no proxy" while the tenant owned any active pool. An operator with an
-- imported pool list still needs one account that must leave from the host
-- address — a provider that rejects the pool range, or a credential whose
-- upstream allowlist is the gateway IP.
--
-- `provider_routing_settings.bypass_proxy` is the same concept one level up (the
-- provider-wide default for unbound accounts); this is the per-account override,
-- which is why it carries the same name.
--
-- `0000_baseline.sql` carries the column, the check, and the mutual-exclusion
-- rule, so a database created today has all three. A database created before
-- that edit does not: the ledger (`lianrouter_schema_migrations`) records
-- `0000_baseline.sql` as applied, so `bun run db:migrate` will NOT re-run the
-- edited baseline.
--
-- `test/integration/isolated-db.test.ts` asserts the live schema matches
-- `src/persistence/schema.ts` exactly, so it fails on a column-count mismatch
-- until this is applied.
--
-- Idempotent: safe to run more than once, and safe on a database that already
-- has the column or the constraint.

ALTER TABLE provider_accounts ADD COLUMN IF NOT EXISTS bypass_proxy boolean NOT NULL DEFAULT false;

-- The two egress modes are mutually exclusive. A row carrying both has no
-- defined egress: the pool binding says "leave from this pool" and this flag
-- says "never use a pool". Dispatch would have to pick one and the other would
-- silently lose, so the pair is rejected at the storage boundary instead.
--
-- Guarded on `pg_constraint` because `ADD CONSTRAINT` has no `IF NOT EXISTS`
-- and a second run must not fail.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'provider_accounts_egress_exclusive_check'
  ) THEN
    ALTER TABLE provider_accounts
      ADD CONSTRAINT "provider_accounts_egress_exclusive_check"
      CHECK (NOT (bypass_proxy AND network_pool_id IS NOT NULL));
  END IF;
END $$;
