-- Share IP blocks: refuse enrollment and invocation for a client IP.
--
-- `blocked_client_ip_key` carries the same normalized form the gateway writes
-- into `api_keys.issued_client_ip_key` ("v4:<uint32>" / "v6:<32 hex>"), so a
-- block matches every key issued from that address without re-parsing text.
--
-- `revoked_child_key_id` records which child key the operator blocked from the
-- dashboard; NULL means the block was created from the IP alone (or the key was
-- deleted afterwards). ON DELETE SET NULL keeps the block alive when a key is
-- hard-deleted, which is what "block this IP" is supposed to mean.
--
-- `release_at` is unused by the UI today; it exists so a temporary block can be
-- expressed without another migration.

CREATE TABLE IF NOT EXISTS share_ip_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    blocked_client_ip text NOT NULL,
    blocked_client_ip_key text NOT NULL,
    revoked_child_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
    reason text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    released_at timestamp with time zone,
    release_at timestamp with time zone,
    CONSTRAINT share_ip_blocks_ip_key_check CHECK (blocked_client_ip_key ~ '^(v4:[0-9]{1,10}|v6:[0-9a-f]{32})$')
);

CREATE UNIQUE INDEX IF NOT EXISTS share_ip_blocks_active_uidx
    ON share_ip_blocks (tenant_id, blocked_client_ip_key)
    WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS share_ip_blocks_tenant_created_idx
    ON share_ip_blocks (tenant_id, created_at DESC);
