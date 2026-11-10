-- Hand-run once on any database created from the previous baseline.
--
-- Adds the derived appeal verdict. The upstream does not report one: the appeal
-- POST answers only `{"code":0,…,"data":{"feedback_id":N}}`, and no verdict
-- endpoint is proven. The only honest signal is whether the account works
-- again, so the console stores what it inferred and when it looked:
--
--   verdict = 'accepted'  a probe of the account succeeded after the appeal;
--                         the ban is lifted and the account is put back in
--                         rotation by the same pass.
--   verdict = 'declined'  the probe still answers the ban after
--                         APPEAL_DECLINE_AFTER_MS (24 h) have passed since the
--                         appeal was acknowledged — the appeal was reviewed and
--                         did not lift the restriction.
--   verdict IS NULL       undecided: the appeal is younger than 24 h and still
--                         restricted, or the probe failed for a reason that says
--                         nothing about the ban (network, 5xx, timeout).
--
-- `verdict_checked_at` is the last derivation attempt's time, not a promise that
-- the same answer holds now; a later success overwrites `declined` with
-- `accepted`, because the account demonstrably works.
--
-- `0000_baseline.sql` carries both columns, so a database created today has
-- them. A database created before that edit does not: the ledger
-- (`lianrouter_schema_migrations`) records `0000_baseline.sql` as applied, so
-- `bun run db:migrate` will NOT re-run the edited baseline.
--
-- Idempotent: safe to run more than once, and safe on a database that already
-- has the columns or the constraint.

ALTER TABLE cb_appeals ADD COLUMN IF NOT EXISTS verdict text;
ALTER TABLE cb_appeals ADD COLUMN IF NOT EXISTS verdict_checked_at timestamp with time zone;

DO $$
BEGIN
    ALTER TABLE cb_appeals ADD CONSTRAINT cb_appeals_verdict_check
        CHECK (verdict IS NULL OR verdict IN ('accepted', 'declined'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
