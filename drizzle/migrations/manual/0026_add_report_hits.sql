-- Hand-run once on any database created from the previous baseline.
--
-- Adds the growth-activity report control plane: per-account bookkeeping for
-- `POST {base}/v2/report` and a per-provider recurring schedule.
--
-- `provider_report_hits` holds ONE row per account, not a log of attempts. The
-- upstream scores a login streak, so the durable fact is "when was this account
-- last successfully reported". `hit_at` is written only on success and is never
-- cleared by a later failure: a transient error must not make an
-- already-credited account look uncredited and send the sweep at it again for a
-- day the provider already counted. `last_state`/`last_error` describe the most
-- recent attempt instead, which is what the console renders.
--
-- The primary key is the account id because there is exactly one report state
-- per account, and `ON DELETE CASCADE` means deleting an account takes its
-- bookkeeping with it rather than leaving an orphan row to filter.
--
-- `provider_report_schedule.last_run_at` is the scheduler's cursor and is
-- deliberately separate from `updated_at`: `updated_at` answers "when did the
-- operator last edit this", `last_run_at` answers "when did the sweep last fire
-- it". Deriving the interval from `updated_at` would let a settings edit
-- silently postpone a run that was already due.
--
-- `0000_baseline.sql` carries both tables, so a database created today has
-- them. A database created before that edit does not: the ledger
-- (`lianrouter_schema_migrations`) records `0000_baseline.sql` as applied, so
-- `bun run db:migrate` will NOT re-run the edited baseline.
--
-- Idempotent: safe to run more than once, and safe on a database that already
-- has the tables or the constraint.

CREATE TABLE IF NOT EXISTS provider_report_hits (
    account_id uuid PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
    provider_id text NOT NULL,
    hit_at timestamp with time zone,
    hit_count integer NOT NULL DEFAULT 0,
    last_state text,
    last_error text,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT provider_report_hits_last_state_check
        CHECK (last_state IS NULL OR last_state IN ('reported', 'error'))
);

-- `provider_id` is not a foreign key to `providers`: the row records which
-- surface was called, and a provider row can be re-seeded or replaced by a BYOK
-- slug without invalidating the history of what was already reported.
CREATE INDEX IF NOT EXISTS provider_report_hits_provider_hit_idx
    ON provider_report_hits (provider_id, hit_at);

CREATE TABLE IF NOT EXISTS provider_report_schedule (
    provider_id text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT false,
    accounts_per_run integer NOT NULL DEFAULT 5,
    interval_minutes integer NOT NULL DEFAULT 60,
    last_run_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT provider_report_schedule_accounts_per_run_check
        CHECK (accounts_per_run BETWEEN 1 AND 100),
    CONSTRAINT provider_report_schedule_interval_minutes_check
        CHECK (interval_minutes BETWEEN 15 AND 1440)
);
