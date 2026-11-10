-- Adds `prompt_injections.excluded_client_ips` and
-- `prompt_injections.excluded_api_key_ids`.
--
-- Both are exclusion lists, not allowlists: an entry applies unless the
-- request matches a listed client IP or authenticated API key. An empty list
-- therefore means "exclude nobody", which keeps every existing row's behavior
-- unchanged after this migration.
--
-- `excluded_client_ips` stores normalized addresses (lowercase, IPv4-mapped
-- `::ffff:` prefix stripped) so one address cannot be listed twice in two
-- spellings. `excluded_api_key_ids` stores api_keys row ids as text, including
-- share children.
--
-- Idempotent: safe to run more than once.
ALTER TABLE prompt_injections
  ADD COLUMN IF NOT EXISTS excluded_client_ips jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS excluded_api_key_ids jsonb NOT NULL DEFAULT '[]';
