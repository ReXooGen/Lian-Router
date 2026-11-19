-- Custom providers carry the operator's display label. Null for bundled
-- providers, whose labels come from the catalog spec. Rows predating this
-- column keep whatever label the console projected in memory only.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS label text;
