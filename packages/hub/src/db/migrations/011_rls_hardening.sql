-- 011_rls_hardening: close the row level security gaps of 001 to 010.
--
-- 1. Tables the app role never touches (email_verifications, password_resets, disposable_email_domains, tenant_credentials,
--    schema_migrations) get no privileges for it: migrate.ts now grants the app role only the tables that have RLS enabled, so
--    these stay unreachable for user scoped transactions (system transactions and the Hub's own queries run as the owner).
-- 2. Tables the app role does use get policies that mirror the service layer rule: users, refresh_tokens, invitations,
--    registration_policies, platform_settings, executor_nodes, team_transfers.
-- 3. Rows with org_id NULL (personal teams and everything below them) were visible to every user at the database layer; they are
--    now visible only to the members of that team (and to operators).
--
-- Helpers are SECURITY DEFINER like app_user_orgs() so a policy can consult the table it protects without recursing.

CREATE FUNCTION app_user_id() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '') $$;

CREATE FUNCTION app_user_teams() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT team_id FROM team_members WHERE user_id = app_user_id()
$$;

CREATE FUNCTION app_owns_team(tid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (SELECT 1 FROM teams WHERE id = tid AND owner_user_id = app_user_id())
$$;

CREATE FUNCTION app_admin_orgs() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT org_id FROM org_members WHERE user_id = app_user_id() AND status = 'active' AND role IN ('owner', 'admin')
$$;

CREATE FUNCTION app_admin_teams() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT team_id FROM team_members WHERE user_id = app_user_id() AND role = 'admin'
$$;

CREATE FUNCTION app_user_email() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT email FROM users WHERE id = app_user_id()
$$;

-- A user is visible to themselves, to the members of organizations they belong to, and to the members of teams they share.
CREATE FUNCTION app_visible_user(uid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT uid = app_user_id()
		OR EXISTS (SELECT 1 FROM org_members m WHERE m.user_id = uid AND m.org_id IN (SELECT org_id FROM org_members WHERE user_id = app_user_id() AND status = 'active'))
		OR EXISTS (SELECT 1 FROM team_members t WHERE t.user_id = uid AND t.team_id IN (SELECT team_id FROM team_members WHERE user_id = app_user_id()))
$$;

CREATE FUNCTION app_orphan_user(uid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT NOT EXISTS (SELECT 1 FROM org_members WHERE user_id = uid) AND NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = uid)
$$;

-- users: own row, same organization, shared team, operators. An organization admin also sees accounts that belong to nothing yet,
-- so `INSERT ... RETURNING` works before the membership rows exist when they create a user.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY visible ON users FOR SELECT
	USING (app_is_operator() OR app_visible_user(id) OR (EXISTS (SELECT 1 FROM app_admin_orgs()) AND app_orphan_user(id)));
CREATE POLICY changeable ON users FOR UPDATE USING (app_is_operator() OR app_visible_user(id));
CREATE POLICY removable ON users FOR DELETE USING (app_is_operator() OR app_visible_user(id));
-- Accounts are created by operators and organization admins (registration itself runs as the system).
CREATE POLICY creatable ON users FOR INSERT WITH CHECK (app_is_operator() OR EXISTS (SELECT 1 FROM app_admin_orgs()));

-- refresh_tokens: own tokens; organization admins may revoke those of their members (disabling an account).
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_or_managed ON refresh_tokens
	USING (app_is_operator() OR user_id = app_user_id() OR user_id IN (SELECT user_id FROM org_members WHERE org_id IN (SELECT app_admin_orgs())));

-- invitations: the creator, the invitee (by email), operators, and the admins of the scope the invitation is for.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY involved ON invitations
	USING (
		app_is_operator()
		OR created_by = app_user_id()
		OR email = app_user_email()
		OR (scope = 'org' AND scope_id IN (SELECT app_admin_orgs()))
		OR (scope = 'team' AND scope_id IN (SELECT app_admin_teams()))
	);

-- registration_policies: everybody may read the platform policy and the policies of their organizations; only operators and
-- organization admins write.
ALTER TABLE registration_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON registration_policies FOR SELECT
	USING (scope = 'platform' OR app_is_operator() OR scope_id IN (SELECT app_user_orgs()));
CREATE POLICY writable ON registration_policies FOR ALL
	USING (app_is_operator() OR (scope = 'org' AND scope_id IN (SELECT app_admin_orgs())));

-- platform_settings: readable by every signed-in user (feature switches, no secrets), written by operators only.
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON platform_settings FOR SELECT USING (true);
CREATE POLICY operator_write ON platform_settings FOR ALL USING (app_is_operator());

-- executor_nodes hold Docker endpoints and TLS directories: operators only.
ALTER TABLE executor_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_only ON executor_nodes USING (app_is_operator());

-- team_transfers: the requester, the admins of the target organization, operators.
ALTER TABLE team_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY involved ON team_transfers
	USING (app_is_operator() OR from_user_id = app_user_id() OR to_org_id IN (SELECT app_admin_orgs()));

-- Personal teams (org_id NULL): members of the team only.
DROP POLICY org_isolation ON teams;
CREATE POLICY org_isolation ON teams USING (
	app_is_operator()
	OR (org_id IS NOT NULL AND org_id IN (SELECT app_user_orgs()))
	OR (org_id IS NULL AND (owner_user_id = app_user_id() OR id IN (SELECT app_user_teams())))
);

DROP POLICY org_isolation ON team_members;
CREATE POLICY org_isolation ON team_members USING (
	app_is_operator()
	OR (org_id IS NOT NULL AND org_id IN (SELECT app_user_orgs()))
	OR (org_id IS NULL AND (user_id = app_user_id() OR team_id IN (SELECT app_user_teams()) OR app_owns_team(team_id)))
);

DROP POLICY org_isolation ON workspaces;
CREATE POLICY org_isolation ON workspaces USING (
	app_is_operator()
	OR (org_id IS NOT NULL AND org_id IN (SELECT app_user_orgs()))
	OR (org_id IS NULL AND (team_id IN (SELECT app_user_teams()) OR app_owns_team(team_id)))
);

-- Everything below a workspace follows the workspace: a row without an organization is visible when its workspace (or session) is.
DROP POLICY org_isolation ON merge_requests;
CREATE POLICY org_isolation ON merge_requests USING (
	app_is_operator()
	OR (org_id IS NOT NULL AND org_id IN (SELECT app_user_orgs()))
	OR (org_id IS NULL AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_id))
);

DROP POLICY org_isolation ON sessions;
CREATE POLICY org_isolation ON sessions USING (
	app_is_operator()
	OR (org_id IS NOT NULL AND org_id IN (SELECT app_user_orgs()))
	OR (org_id IS NULL AND (owner_user_id = app_user_id() OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_id)))
);

DROP POLICY org_isolation ON session_events;
CREATE POLICY org_isolation ON session_events USING (
	app_is_operator()
	OR (org_id IS NOT NULL AND org_id IN (SELECT app_user_orgs()))
	OR (org_id IS NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_id))
);

DROP POLICY org_isolation ON session_transcripts;
CREATE POLICY org_isolation ON session_transcripts USING (
	app_is_operator()
	OR (org_id IS NOT NULL AND org_id IN (SELECT app_user_orgs()))
	OR (org_id IS NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_id))
);

DROP POLICY org_isolation ON session_grants;
CREATE POLICY org_isolation ON session_grants USING (
	app_is_operator()
	OR (org_id IS NOT NULL AND org_id IN (SELECT app_user_orgs()))
	OR (org_id IS NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_id))
);

DROP POLICY org_isolation ON daily_reports;
CREATE POLICY org_isolation ON daily_reports USING (
	app_is_operator()
	OR (org_id IS NOT NULL AND org_id IN (SELECT app_user_orgs()))
	OR (org_id IS NULL AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_id))
);

-- Notifications and runtime rows belong to one user, not to everybody who shares an organization.
DROP POLICY org_isolation ON notifications;
CREATE POLICY own_only ON notifications USING (app_is_operator() OR user_id = app_user_id());

DROP POLICY org_isolation ON tenant_runtimes;
CREATE POLICY org_isolation ON tenant_runtimes USING (
	app_is_operator()
	OR (org_id IS NOT NULL AND org_id IN (SELECT app_user_orgs()))
	OR (org_id IS NULL AND user_id = app_user_id())
);
