-- Add the embeddings wire family.
--
-- The enum is shared by `providers.wire_family_default` and
-- `models.wire_family`; existing rows keep their values. The value is added
-- here rather than edited into the baseline so databases created from earlier
-- baselines converge on the same schema.
ALTER TYPE "wire_family" ADD VALUE IF NOT EXISTS 'embeddings';

-- Telemetry records the surface a request arrived on; embeddings requests are
-- persisted with their own value instead of being coerced to a chat surface.
ALTER TYPE "telemetry_source_surface" ADD VALUE IF NOT EXISTS 'embeddings';
