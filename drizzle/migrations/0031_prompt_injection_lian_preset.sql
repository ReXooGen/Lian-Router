-- The operator's "Lian" persona joins the built-in injection presets. The
-- CHECK constraint predates it, so the allowed set widens in place: drop the
-- old constraint and re-add it with the new member. IF EXISTS keeps the
-- migration idempotent for installs where the constraint name differs.
ALTER TABLE prompt_injections DROP CONSTRAINT IF EXISTS prompt_injections_preset_check;
ALTER TABLE prompt_injections ADD CONSTRAINT prompt_injections_preset_check
  CHECK ((preset = ANY (ARRAY['custom'::text, 'assistant'::text, 'uncensored'::text, 'lian'::text])));
