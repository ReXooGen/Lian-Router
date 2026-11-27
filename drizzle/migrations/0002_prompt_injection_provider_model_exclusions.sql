-- Adds `prompt_injections.excluded_providers` and
-- `prompt_injections.excluded_models` so one saved injection can skip a
-- provider, or a single model, without splitting the persona into per-target
-- copies.
--
-- Both are exclusion lists, not allowlists: an entry applies unless the
-- request resolves to a listed provider or model name. An empty list therefore
-- means "exclude nobody", which keeps every existing row's behavior unchanged.
--
-- `excluded_providers` stores provider ids as the console shows them.
-- `excluded_models` stores model names in the spellings a request can arrive
-- under (bare id, `provider/model`, and an alias), matched at dispatch against
-- every name the gateway could bill the request under.
--
-- Databases created after these columns joined the baseline already have them;
-- `ADD COLUMN IF NOT EXISTS` makes this a no-op there, and the ledger records
-- it so it never runs twice.

ALTER TABLE prompt_injections
  ADD COLUMN IF NOT EXISTS excluded_providers jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS excluded_models jsonb NOT NULL DEFAULT '[]';
