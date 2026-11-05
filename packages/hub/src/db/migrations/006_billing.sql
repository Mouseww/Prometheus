-- 006_billing: plans, subscriptions, credit grants, orders, redeem codes, model prices (block 4B); user gateway isolation (block 4C).
-- A billing subject is a user or an organization: (subject_type, subject_id). Balance = sum of unexpired credit_grants.remaining.

CREATE TABLE plans (
	id text PRIMARY KEY,
	name text NOT NULL,
	period text NOT NULL CHECK (period IN ('month', 'year')),
	price_cents bigint NOT NULL CHECK (price_cents >= 0),
	currency text NOT NULL DEFAULT 'cny',
	-- Credits granted at the start of every month of the plan.
	monthly_credits bigint NOT NULL CHECK (monthly_credits >= 0),
	-- e.g. {"max_runtime_minutes_per_day": 120}
	features jsonb NOT NULL DEFAULT '{}'::jsonb,
	active boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
-- Every user and organization has the free plan: it grants credits each calendar month and cannot be bought or removed.
INSERT INTO plans (id, name, period, price_cents, currency, monthly_credits, features)
VALUES ('free', 'Free', 'month', 0, 'cny', 10000, '{"max_runtime_minutes_per_day": 120}'::jsonb);

CREATE TABLE subscriptions (
	id text PRIMARY KEY,
	subject_type text NOT NULL CHECK (subject_type IN ('user', 'org')),
	subject_id text NOT NULL,
	plan_id text NOT NULL REFERENCES plans (id),
	status text NOT NULL CHECK (status IN ('active', 'past_due', 'canceled')),
	current_period_start timestamptz NOT NULL,
	current_period_end timestamptz NOT NULL,
	provider text NOT NULL,
	provider_ref text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	-- One paid subscription per subject; renewing or changing plan updates the row.
	UNIQUE (subject_type, subject_id)
);
CREATE INDEX subscriptions_provider_idx ON subscriptions (provider, provider_ref);

CREATE TABLE credit_grants (
	id text PRIMARY KEY,
	subject_type text NOT NULL CHECK (subject_type IN ('user', 'org')),
	subject_id text NOT NULL,
	source text NOT NULL CHECK (source IN ('free', 'plan', 'topup', 'redeem', 'admin')),
	amount bigint NOT NULL CHECK (amount >= 0),
	remaining bigint NOT NULL CHECK (remaining >= 0 AND remaining <= amount),
	expires_at timestamptz,
	-- Periodic grants (free, plan): the start of the period they were issued for.
	period_start timestamptz,
	-- Order id (topup) or code and subject (redeem): makes fulfilment idempotent.
	ref text,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_grants_subject_idx ON credit_grants (subject_type, subject_id, expires_at);
CREATE UNIQUE INDEX credit_grants_period_uq ON credit_grants (subject_type, subject_id, source, period_start) WHERE period_start IS NOT NULL;
CREATE UNIQUE INDEX credit_grants_ref_uq ON credit_grants (source, ref) WHERE ref IS NOT NULL;

CREATE TABLE orders (
	id text PRIMARY KEY,
	subject_type text NOT NULL CHECK (subject_type IN ('user', 'org')),
	subject_id text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('topup', 'subscription')),
	amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
	currency text NOT NULL,
	credits bigint NOT NULL DEFAULT 0 CHECK (credits >= 0),
	plan_id text REFERENCES plans (id),
	status text NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'canceled')),
	provider text NOT NULL,
	provider_ref text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	paid_at timestamptz
);
CREATE INDEX orders_subject_idx ON orders (subject_type, subject_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status, created_at DESC);
CREATE UNIQUE INDEX orders_provider_ref_uq ON orders (provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- Webhook deduplication: one row per provider reference and event type (plus a discriminator for recurring events such as renewals).
CREATE TABLE payment_events (
	provider text NOT NULL,
	provider_ref text NOT NULL,
	event_type text NOT NULL,
	discriminator text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (provider, provider_ref, event_type, discriminator)
);

CREATE TABLE redeem_codes (
	id text PRIMARY KEY,
	-- SHA-256 of the normalized code; the plaintext is only shown once, at generation.
	code_hash text NOT NULL UNIQUE,
	-- Last characters of the code, to recognize it in the operator list.
	hint text NOT NULL,
	credits bigint NOT NULL CHECK (credits > 0),
	max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
	used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
	expires_at timestamptz,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- A user can redeem a given code once.
CREATE TABLE redeem_redemptions (
	code_id text NOT NULL REFERENCES redeem_codes (id) ON DELETE CASCADE,
	user_id text NOT NULL,
	subject_type text NOT NULL,
	subject_id text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (code_id, user_id)
);

-- Credits per million tokens. gateway_id null = any gateway; model '*' = fallback for models without a price.
CREATE TABLE model_prices (
	id text PRIMARY KEY,
	model text NOT NULL,
	gateway_id text REFERENCES model_gateways (id) ON DELETE CASCADE,
	input_price numeric(20, 6) NOT NULL CHECK (input_price >= 0),
	output_price numeric(20, 6) NOT NULL CHECK (output_price >= 0),
	currency_note text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX model_prices_uq ON model_prices (model, coalesce(gateway_id, ''));

ALTER TABLE usage_ledger ADD COLUMN cost_credits bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_ledger ADD COLUMN subject_type text;
ALTER TABLE usage_ledger ADD COLUMN subject_id text;
-- Credits the subject could not cover (balance was clamped to zero).
ALTER TABLE usage_ledger ADD COLUMN overdraft_credits bigint NOT NULL DEFAULT 0;
CREATE INDEX usage_ledger_subject_idx ON usage_ledger (subject_type, subject_id, at);

-- Row level security: a subject's rows are visible to that user, to members of that organization and to operators.
CREATE FUNCTION app_can_see_subject(t text, id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
	SELECT app_is_operator()
		OR (t = 'user' AND id = current_setting('app.user_id', true))
		OR (t = 'org' AND id IN (SELECT app_user_orgs()))
$$;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subject_isolation ON subscriptions USING (app_can_see_subject(subject_type, subject_id));
ALTER TABLE credit_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY subject_isolation ON credit_grants USING (app_can_see_subject(subject_type, subject_id));
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY subject_isolation ON orders USING (app_can_see_subject(subject_type, subject_id));

-- Catalogues everyone may read; writes go through operator-only services.
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON plans USING (true);
ALTER TABLE model_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON model_prices USING (true);

-- Secrets and bookkeeping: operators only (the Hub itself works in system scope).
ALTER TABLE redeem_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_only ON redeem_codes USING (app_is_operator());
ALTER TABLE redeem_redemptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_only ON redeem_redemptions USING (app_is_operator());
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_only ON payment_events USING (app_is_operator());

-- User gateways (block 4C) have no org_id, which the 004 policy treats as visible to everyone: restrict them to their owner.
DROP POLICY org_isolation ON model_gateways;
CREATE POLICY org_isolation ON model_gateways USING (
	CASE WHEN scope = 'user'
		THEN scope_id = current_setting('app.user_id', true)
		ELSE org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs())
	END
);
