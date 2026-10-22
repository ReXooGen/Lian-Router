-- Prompt Injection: operator-facing name for a saved entry.
--
-- Apply by hand on databases created before this baseline edit; the ledger
-- runner only consumes the top-level baseline.
ALTER TABLE "prompt_injections" ADD COLUMN IF NOT EXISTS "name" text NOT NULL DEFAULT '';
