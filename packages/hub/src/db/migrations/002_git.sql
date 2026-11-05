-- 002_git: team workspaces (bare main copy, optional upstream remote) and merge requests.
-- RLS follows 001: rows with org_id are visible to that organization's members and operators; personal teams (org_id NULL) are filtered in the service layer.

CREATE TABLE workspaces (
	id text PRIMARY KEY,
	team_id text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	name text NOT NULL,
	-- Bare repository directory, relative to the Hub data directory (e.g. repos/<id>.git).
	repo_dir text NOT NULL,
	default_branch text NOT NULL DEFAULT 'main',
	daily_report_time text NOT NULL DEFAULT '09:00',
	daily_report_tz text NOT NULL DEFAULT 'Asia/Shanghai',
	daily_report_enabled boolean NOT NULL DEFAULT true,
	-- Optional upstream remote (spec 12.5 item 3). The token is sealed with the Hub secret box.
	upstream_url text,
	upstream_token_enc text,
	-- NULL, 'ok', 'push_failed', 'fetch_failed' or 'upstream_diverged'.
	upstream_status text CHECK (upstream_status IN ('ok', 'push_failed', 'fetch_failed', 'upstream_diverged')),
	upstream_error text,
	upstream_checked_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (team_id, name)
);
CREATE INDEX workspaces_team_idx ON workspaces (team_id);
CREATE INDEX workspaces_org_idx ON workspaces (org_id);

CREATE TABLE merge_requests (
	id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	-- Hub session id; the sessions table belongs to a later migration, so no foreign key.
	session_id text,
	author_id text NOT NULL REFERENCES users (id),
	title text NOT NULL,
	description text NOT NULL DEFAULT '',
	branch text NOT NULL,
	base_commit text NOT NULL,
	head_commit text NOT NULL,
	-- 'approved' is the transient state while a merge is being executed.
	status text NOT NULL CHECK (status IN ('open', 'approved', 'merged', 'rejected', 'conflict', 'closed')),
	reviewer_id text REFERENCES users (id),
	skipped_review boolean NOT NULL DEFAULT false,
	conflict_files jsonb,
	merged_commit text,
	decided_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merge_requests_workspace_idx ON merge_requests (workspace_id, status);
CREATE INDEX merge_requests_author_idx ON merge_requests (author_id);

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON workspaces
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE merge_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON merge_requests
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));
