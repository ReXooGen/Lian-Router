-- Adds `prompt_injections.excluded_client_ips` and
-- `prompt_injections.excluded_api_key_ids` to databases whose ledger already
-- records `0000_baseline.sql` from before these columns existed.
--
-- Both are exclusion lists, not allowlists: an entry applies unless the request
-- matches a listed client IP or authenticated API key. An empty list therefore
-- means "exclude nobody", which keeps every existing row's behavior unchanged.
--
-- `excluded_client_ips` stores normalized addresses (lowercase, IPv4-mapped
-- `::ffff:` prefix stripped) so one address cannot be listed twice in two
-- spellings. `excluded_api_key_ids` stores api_keys row ids as text, including
-- share children.
--
-- Databases created after these columns joined the baseline already have them;
-- `ADD COLUMN IF NOT EXISTS` makes this a no-op there, and the ledger records
-- it so it never runs twice.

ALTER TABLE prompt_injections
  ADD COLUMN IF NOT EXISTS excluded_client_ips jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS excluded_api_key_ids jsonb NOT NULL DEFAULT '[]';
