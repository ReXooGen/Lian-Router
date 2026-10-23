-- Hand-run once on any database created from the previous baseline.
--
-- Adds `api_keys.network_pool_id`: the proxy pool this key's traffic must
-- egress through. NULL (the default, and what every existing row gets) leaves
-- egress entirely to the per-account and per-provider routing that decided it
-- before this column existed, so this migration changes no routing by itself.
--
-- Why per key rather than a second policy table: a key is already the unit an
-- operator hands out (a CI token, a share template and the children it mints),
-- and "this credential leaves from this pool" is the same narrow statement
-- `provider_accounts.network_pool_id` makes one level down. A key's pool is a
-- *narrowing* constraint on the account's egress, never a widening one: it can
-- only intersect with what the candidate account already allows, so a key can
-- never push a direct-pinned credential back through a proxy.
--
-- Children issued by a share template copy this column at insert time rather
-- than resolving it through the parent, so revoking or re-pointing the
-- template cannot retroactively move an already-issued child's traffic.
--
-- `0000_baseline.sql` carries the column and its foreign key, so a database
-- created today has both. A database created before that edit does not: the
-- ledger (`lianrouter_schema_migrations`) records `0000_baseline.sql` as
-- applied, so `bun run db:migrate` will NOT re-run the edited baseline.
--
-- Idempotent: safe to run more than once, and safe on a database that already
-- has the column or the constraint.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS network_pool_id uuid;

-- `set null` rather than `cascade`: deleting a pool must detach the keys that
-- used it, not revoke them. A dropped binding widens those keys back to
-- provider routing, which the operator can see in the console, instead of
-- taking their credentials (and every child minted from them) with it.
--
-- Guarded on `pg_constraint` because `ADD CONSTRAINT` has no `IF NOT EXISTS`
-- and a second run must not fail.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'api_keys_network_pool_id_network_pools_id_fk'
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT "api_keys_network_pool_id_network_pools_id_fk"
      FOREIGN KEY (network_pool_id) REFERENCES network_pools(id) ON DELETE set null;
  END IF;
END $$;
