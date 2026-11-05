-- 001_core: accounts, organizations, teams, registration policy, invitations, tokens, audit, platform settings.
-- Numbers 002 (git), 003 (sessions) and 004 (models) are reserved for other blocks; the runner applies files in name order.

CREATE TABLE users (
	id text PRIMARY KEY,
	email text NOT NULL UNIQUE CHECK (email = lower(email)),
	display_name text NOT NULL,
	password_hash text NOT NULL,
	status text NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
	email_verified_at timestamptz,
	platform_role text CHECK (platform_role IN ('operator')),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
	id text PRIMARY KEY,
	name text NOT NULL,
	slug text NOT NULL UNIQUE,
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
	settings jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
	org_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
	status text NOT NULL CHECK (status IN ('active', 'pending')),
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user_idx ON org_members (user_id);

CREATE TABLE teams (
	id text PRIMARY KEY,
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	owner_user_id text REFERENCES users (id) ON DELETE CASCADE,
	name text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CHECK ((org_id IS NULL) <> (owner_user_id IS NULL))
);
CREATE INDEX teams_org_idx ON teams (org_id);

CREATE TABLE team_members (
	team_id text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	role text NOT NULL CHECK (role IN ('admin', 'reviewer', 'member')),
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members (user_id);

CREATE TABLE registration_policies (
	scope text NOT NULL CHECK (scope IN ('platform', 'org')),
	scope_id text NOT NULL,
	allow_open boolean NOT NULL DEFAULT false,
	allowed_domains text[] NOT NULL DEFAULT '{}',
	require_approval boolean NOT NULL DEFAULT true,
	allow_invite boolean NOT NULL DEFAULT true,
	closed boolean NOT NULL DEFAULT false,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (scope, scope_id)
);

CREATE TABLE invitations (
	id text PRIMARY KEY,
	scope text NOT NULL CHECK (scope IN ('org', 'team')),
	scope_id text NOT NULL,
	email text NOT NULL CHECK (email = lower(email)),
	role text NOT NULL,
	token_hash text NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	accepted_at timestamptz,
	created_by text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	token_hash text NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	revoked_at timestamptz,
	user_agent text,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE audit_log (
	id text PRIMARY KEY,
	actor_id text,
	org_id text REFERENCES organizations (id) ON DELETE SET NULL,
	action text NOT NULL,
	target_type text,
	target_id text,
	detail jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON audit_log (org_id, id DESC);

CREATE TABLE platform_settings (
	key text PRIMARY KEY,
	value jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Private deployment defaults (spec section 4): nobody self-registers until an admin sets a company domain.
INSERT INTO registration_policies (scope, scope_id, allow_open, allowed_domains, require_approval, allow_invite, closed)
VALUES ('platform', 'platform', false, '{}', true, true, false);
INSERT INTO platform_settings (key, value) VALUES ('allow_personal_teams', 'false'::jsonb);

-- Row level security. The helpers are SECURITY DEFINER so policies on org_members can consult org_members without recursing.
CREATE FUNCTION app_user_orgs() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT org_id FROM org_members
	WHERE user_id = current_setting('app.user_id', true) AND status = 'active'
$$;

CREATE FUNCTION app_is_operator() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.operator', true), '') = '1' $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organizations
	USING (app_is_operator() OR id IN (SELECT app_user_orgs()));

ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org_members
	USING (app_is_operator() OR user_id = current_setting('app.user_id', true) OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON teams
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON team_members
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_log
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));
