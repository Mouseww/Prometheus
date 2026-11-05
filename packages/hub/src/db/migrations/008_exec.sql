-- 008_exec: execution mode of team sessions (block 3B). `exec_location` already exists since 003.

ALTER TABLE sessions ADD COLUMN exec_mode text NOT NULL DEFAULT 'local-first' CHECK (exec_mode IN ('local-first', 'team-first'));
-- Id of the session inside the tenant instance while exec_location = 'team'.
ALTER TABLE sessions ADD COLUMN tenant_session_id text;
ALTER TABLE sessions ADD CONSTRAINT sessions_exec_location_check CHECK (exec_location IN ('local', 'team'));
