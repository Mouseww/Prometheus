-- 010_tenant_credentials: every credential the Hub hands to a tenant instance is recorded by its jti so it can be revoked.
-- kind 'tenant': the long-lived credential of the team plugin (aud prometheus-tenant, exchanged for scope=tenant access tokens).
-- kind 'gateway': the token the tenant's server presents to the LLM proxy (aud prometheus-llm).
-- Only the Hub itself (system transactions) touches this table; the app role gets no privileges (see 011).

CREATE TABLE tenant_credentials (
	jti text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	kind text NOT NULL CHECK (kind IN ('tenant', 'gateway')),
	expires_at timestamptz NOT NULL,
	revoked_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_credentials_user_idx ON tenant_credentials (user_id) WHERE revoked_at IS NULL;
