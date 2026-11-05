-- 012_users_no_orphan_visibility: organization admins no longer see accounts that belong to no organization or team.
--
-- 011 let any org admin read "orphan" users so `INSERT ... RETURNING` worked during admin user creation. Orphans include pending
-- self-registered accounts, and in public mode anyone can create an organization, so that enumerated every unaffiliated email.
-- Admin user creation now runs its insert in a system transaction after the authorization check, so the read path needs no exception.

DROP POLICY visible ON users;
CREATE POLICY visible ON users FOR SELECT
	USING (app_is_operator() OR app_visible_user(id));

DROP FUNCTION app_orphan_user(text);
