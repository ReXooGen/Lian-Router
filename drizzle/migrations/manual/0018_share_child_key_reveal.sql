-- Hand-run once on any database created from the previous baseline.
--
-- Lets an enrollment page show a shared child key to the same device again.
--
-- Before this change a child key's secret was shown exactly once at issue time
-- and only its authentication hash was kept (`key_encrypted` had to be NULL on
-- children). A visitor who reloaded the page lost the key forever, and the
-- one-child-per-IP rule then locked them out with "An active child key has
-- already been issued from this IP" and no way forward.
--
-- Two changes fix that without weakening the one-child-per-IP guarantee:
--
-- 1. `enrollment_device_key`: an identifier the enrollment page generates once
--    in localStorage and sends on every issue/reveal call. It identifies the
--    device, not the person; the canonical client IP stays the hard security
--    boundary and is unchanged. A device key alone cannot reveal anything —
--    the reveal endpoint also requires the canonical IP to match the issued
--    row, so a stolen device key from a different network reveals nothing.
--
-- 2. Child rows may now carry `key_encrypted` (AES-256-GCM under
--    LIANROUTER_ENCRYPTION_KEY, same format as personal keys). The check
--    constraint previously forced it to NULL on children; that arm is removed
--    instead of being inverted so older children (NULL ciphertext) stay valid.
--    A child without a device key or without ciphertext still works for
--    routing; it simply cannot be re-revealed.
--
-- The parent share template keeps `key_encrypted IS NULL` (its arm of the
-- check now also requires `enrollment_device_key IS NULL`) so a template row
-- remains non-secret as before.
--
-- `0000_baseline.sql` carries the column and the new constraint shape, so a
-- database created today has both. `test/integration/isolated-db.test.ts`
-- asserts the live schema matches `src/persistence/schema.ts` exactly and
-- fails on a mismatch until this is applied.
--
-- Idempotent: safe to run more than once.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS enrollment_device_key text;

-- Rebuild the mode-shape check: drop by name, re-add with the new shape.
-- Guarded on the new column's presence so an already-migrated database skips
-- the drop/re-add cycle (the old constraint name may still exist there under
-- a partially applied state).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'enrollment_device_key'
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_mode_shape_check'
  ) THEN
    ALTER TABLE api_keys DROP CONSTRAINT "api_keys_mode_shape_check";
    ALTER TABLE api_keys ADD CONSTRAINT "api_keys_mode_shape_check" CHECK (
      (
        ("key_mode" = 'personal' AND "key_hash" IS NOT NULL AND "parent_key_id" IS NULL
          AND "issued_client_ip" IS NULL AND "issued_client_ip_key" IS NULL)
        OR
        ("key_mode" = 'share' AND (
          ("parent_key_id" IS NULL AND "key_hash" IS NULL
            AND "key_encrypted" IS NULL
            AND "issued_client_ip" IS NULL AND "issued_client_ip_key" IS NULL
            AND "enrollment_device_key" IS NULL)
          OR
          ("parent_key_id" IS NOT NULL AND "key_hash" IS NOT NULL
            AND "issued_client_ip" IS NOT NULL AND "issued_client_ip_key" IS NOT NULL)
        ))
      )
    );
  END IF;
END $$;
