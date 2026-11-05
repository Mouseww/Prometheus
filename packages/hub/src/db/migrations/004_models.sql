-- 004_models: model gateways, quotas, usage ledger (block 2C).
-- Quota subjects are 'user' and 'org' only (spec 12.5 item 5).

CREATE TABLE model_gateways (
	id text PRIMARY KEY,
	scope text NOT NULL CHECK (scope IN ('platform', 'org', 'user')),
	scope_id text NOT NULL,
	-- Equals scope_id for organization gateways so row level security can see it; null otherwise.
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	name text NOT NULL,
	format text NOT NULL CHECK (format IN ('openai', 'anthropic', 'gemini')),
	base_url text NOT NULL,
	-- AES-256-GCM sealed with the Hub master key.
	api_key_enc text NOT NULL,
	models jsonb NOT NULL DEFAULT '[]'::jsonb,
	enabled boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_gateways_scope_idx ON model_gateways (scope, scope_id);

CREATE TABLE quotas (
	id text PRIMARY KEY,
	subject_type text NOT NULL CHECK (subject_type IN ('user', 'org')),
	subject_id text NOT NULL,
	period text NOT NULL CHECK (period IN ('day', 'month')),
	limit_tokens bigint NOT NULL CHECK (limit_tokens >= 0),
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (subject_type, subject_id, period)
);

CREATE TABLE usage_ledger (
	id text PRIMARY KEY,
	-- A user id, or 'system' for Hub-initiated calls (daily reports); deliberately not a foreign key.
	user_id text NOT NULL,
	org_id text REFERENCES organizations (id) ON DELETE SET NULL,
	gateway_id text REFERENCES model_gateways (id) ON DELETE SET NULL,
	model text NOT NULL,
	input_tokens bigint NOT NULL DEFAULT 0,
	output_tokens bigint NOT NULL DEFAULT 0,
	source text NOT NULL CHECK (source IN ('platform', 'org', 'byok')),
	at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_user_idx ON usage_ledger (user_id, at);
CREATE INDEX usage_ledger_org_idx ON usage_ledger (org_id, at);

ALTER TABLE model_gateways ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON model_gateways
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE quotas ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON quotas
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE usage_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON usage_ledger
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));
