-- 003_sessions: session mirror, grants, transcripts, notifications, daily reports (block 2C).
-- Depends on workspaces from 002_git.

CREATE TABLE sessions (
	id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	owner_user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	-- Mapping back to the owner's machine. Empty until a fork has been imported locally.
	local_session_id text NOT NULL DEFAULT '',
	server_id text NOT NULL DEFAULT '',
	title text NOT NULL DEFAULT '',
	status text NOT NULL DEFAULT 'idle' CHECK (status IN ('running', 'waiting', 'idle', 'offline')),
	-- Inputs of the status machine: 'offline' overrides them, they decide what the session returns to.
	agent_running boolean NOT NULL DEFAULT false,
	pending_requests jsonb NOT NULL DEFAULT '[]'::jsonb,
	branch text NOT NULL DEFAULT '',
	base_commit text NOT NULL DEFAULT '',
	forked_from_session_id text REFERENCES sessions (id) ON DELETE SET NULL,
	exec_location text NOT NULL DEFAULT 'local',
	last_activity_at timestamptz NOT NULL DEFAULT now(),
	snapshot_commit text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_workspace_idx ON sessions (workspace_id, last_activity_at DESC);
CREATE INDEX sessions_owner_idx ON sessions (owner_user_id);
CREATE UNIQUE INDEX sessions_local_uidx ON sessions (owner_user_id, server_id, local_session_id) WHERE local_session_id <> '';

CREATE TABLE session_events (
	session_id text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	seq bigint NOT NULL,
	kind text NOT NULL,
	payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (session_id, seq)
);

CREATE TABLE session_transcripts (
	session_id text PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	format text NOT NULL,
	-- gzip, then base64.
	content text NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session_grants (
	session_id text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	granted_by text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (session_id, user_id)
);

CREATE TABLE notifications (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	kind text NOT NULL,
	payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	read_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);

CREATE TABLE daily_reports (
	id text PRIMARY KEY,
	workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	org_id text REFERENCES organizations (id) ON DELETE CASCADE,
	report_date date NOT NULL,
	content jsonb NOT NULL,
	generated_by text NOT NULL CHECK (generated_by IN ('model', 'digest')),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (workspace_id, report_date)
);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON sessions
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON session_events
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE session_transcripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON session_transcripts
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE session_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON session_grants
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON notifications
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));

ALTER TABLE daily_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON daily_reports
	USING (org_id IS NULL OR app_is_operator() OR org_id IN (SELECT app_user_orgs()));
