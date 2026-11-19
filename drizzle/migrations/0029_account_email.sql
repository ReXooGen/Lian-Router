-- Provider accounts carry the login email their vendor reports for OAuth
-- accounts. Null for API-key accounts and rows predating this column.
ALTER TABLE provider_accounts ADD COLUMN IF NOT EXISTS account_email text;
