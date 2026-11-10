-- Hand-run once on any database created from the previous baseline.
--
-- Adds the appeal bookkeeping for upstream-banned accounts: one row per
-- account, keyed by the account id because there is exactly one appeal state
-- per account. `ON DELETE CASCADE` means deleting an account takes its appeal
-- history with it rather than leaving an orphan row to filter.
--
-- `appealed_at` is the acknowledgement cursor: written only when the upstream
-- returns a `feedback_id`, and never cleared by a later failed attempt. A
-- transient error must not make an acknowledged appeal look untouched and send
-- the sender at it again. `last_state`/`last_error` describe the most recent
-- attempt instead, which is what the console renders.
--
-- `provider_id` is not a foreign key to `providers`: like
-- `provider_report_hits`, the row records which surface was appealed to, and a
-- provider row can be re-seeded without invalidating that history.
--
-- `0000_baseline.sql` carries the table, so a database created today has it. A
-- database created before that edit does not: the ledger
-- (`lianrouter_schema_migrations`) records `0000_baseline.sql` as applied, so
-- `bun run db:migrate` will NOT re-run the edited baseline.
--
-- Idempotent: safe to run more than once, and safe on a database that already
-- has the table or the constraint.

CREATE TABLE IF NOT EXISTS cb_appeals (
    account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
    provider_id text NOT NULL,
    appealed_at timestamp with time zone,
    appeal_count integer NOT NULL DEFAULT 0,
    feedback_id bigint,
    last_state text,
    last_error text,
    message text,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT cb_appeals_last_state_check
        CHECK (last_state IS NULL OR last_state IN ('appealed', 'error'))
);

CREATE INDEX IF NOT EXISTS cb_appeals_provider_idx
    ON cb_appeals (provider_id, appealed_at);
