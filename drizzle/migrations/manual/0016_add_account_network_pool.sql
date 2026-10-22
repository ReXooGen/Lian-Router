-- Hand-run once on any database created from the previous baseline.
--
-- Adds `provider_accounts.network_pool_id`: the proxy pool an account must
-- egress through. NULL (the default, and what every existing row gets) means
-- the account joins the tenant's provider-wide pool group, which is exactly
-- how every account behaved before this column existed — so this migration
-- changes no routing by itself.
--
-- Why per account rather than per provider: egress identity is often the whole
-- reason an operator holds several accounts for one provider. A pool bound to
-- an account is that account's identity, and routing it through a different
-- pool would send the credential out from an address the upstream never saw it
-- from. Dispatch therefore treats a bound pool as mandatory: when it is
-- unavailable the account is skipped rather than dialed direct, because
-- falling back to the host address would expose the very IP the binding exists
-- to hide.
--
-- `0000_baseline.sql` carries the column and its foreign key, so a database
-- created today has both. A database created before that edit does not: the
-- ledger (`lianrouter_schema_migrations`) records `0000_baseline.sql` as
-- applied, so `bun run db:migrate` will NOT re-run the edited baseline.
--
-- Idempotent: safe to run more than once, and safe on a database that already
-- has the column or the constraint.

ALTER TABLE provider_accounts ADD COLUMN IF NOT EXISTS network_pool_id uuid;

-- `set null` rather than `cascade`: deleting a pool must detach the accounts
-- that used it, not delete them. A dropped binding reverts those accounts to
-- the tenant pool group, which the operator can see, instead of silently
-- taking their credentials with it.
--
-- Guarded on `pg_constraint` because `ADD CONSTRAINT` has no `IF NOT EXISTS`
-- and a second run must not fail.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'provider_accounts_network_pool_id_network_pools_id_fk'
  ) THEN
    ALTER TABLE provider_accounts
      ADD CONSTRAINT "provider_accounts_network_pool_id_network_pools_id_fk"
      FOREIGN KEY (network_pool_id) REFERENCES network_pools(id) ON DELETE set null;
  END IF;
END $$;
