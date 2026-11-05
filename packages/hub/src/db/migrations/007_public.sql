-- 007_public: online service account extensions (block 4A): email verification, password reset, disposable domains, team transfers.
-- Tokens are stored as SHA-256 hashes only; a token is single use (`used_at`) and expires.

CREATE TABLE email_verifications (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	token_hash text NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	used_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verifications_user_idx ON email_verifications (user_id);

CREATE TABLE password_resets (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	token_hash text NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	used_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- Operator-extendable blocklist; the Hub also ships a small built-in list.
CREATE TABLE disposable_email_domains (
	domain text PRIMARY KEY CHECK (domain = lower(domain)),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- A personal team asking to move under an organization; an organization admin accepts or rejects.
CREATE TABLE team_transfers (
	id text PRIMARY KEY,
	team_id text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
	from_user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	to_org_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'canceled')),
	decided_by text REFERENCES users (id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	decided_at timestamptz
);
CREATE INDEX team_transfers_org_idx ON team_transfers (to_org_id, status);
CREATE INDEX team_transfers_user_idx ON team_transfers (from_user_id);
-- At most one open request per team.
CREATE UNIQUE INDEX team_transfers_pending_uidx ON team_transfers (team_id) WHERE status = 'pending';

INSERT INTO platform_settings (key, value) VALUES ('allow_self_create_org', 'true'::jsonb);
