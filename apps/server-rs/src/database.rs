use std::{path::Path, str::FromStr};

use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};

use crate::error::AppError;

#[derive(Clone)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    pub async fn open(filename: &Path) -> Result<Self, AppError> {
        let memory = filename.as_os_str() == ":memory:";
        let options = if memory {
            SqliteConnectOptions::from_str("sqlite::memory:")?
                .foreign_keys(true)
        } else {
            if let Some(parent) = filename.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    AppError::configuration(format!("Unable to create data directory: {error}"))
                })?;
            }
            SqliteConnectOptions::new()
                .filename(filename)
                .create_if_missing(true)
                .foreign_keys(true)
                .journal_mode(SqliteJournalMode::Wal)
        };
        let pool = SqlitePoolOptions::new()
            .max_connections(if memory { 1 } else { 5 })
            .connect_with(options)
            .await?;
        sqlx::raw_sql(MIGRATION).execute(&pool).await?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

const MIGRATION: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_events_session_sequence
  ON session_events(session_id, sequence);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT,
  default_model TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_provider
  ON agent_profiles(provider_id);

CREATE TABLE IF NOT EXISTS permission_rules (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  effect TEXT NOT NULL,
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_permission_rules_tool_effect
  ON permission_rules(tool_name, effect);

CREATE TABLE IF NOT EXISTS team_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL,
  workspace_mode TEXT NOT NULL DEFAULT 'readonly',
  merge_strategy TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_team_runs_session_created
  ON team_runs(session_id, created_at);

CREATE TABLE IF NOT EXISTS team_run_tasks (
  id TEXT PRIMARY KEY,
  team_run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  agent_label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  output TEXT,
  error TEXT,
  allowed_paths_json TEXT NOT NULL DEFAULT '[]',
  worktree_root TEXT,
  worktree_branch TEXT,
  base_commit TEXT,
  changed_paths_json TEXT NOT NULL DEFAULT '[]',
  change_status TEXT NOT NULL DEFAULT 'not_applicable',
  conflict_paths_json TEXT NOT NULL DEFAULT '[]',
  patch_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_team_run_tasks_team_ordinal
  ON team_run_tasks(team_run_id, ordinal);

CREATE TABLE IF NOT EXISTS team_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  team_run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_agent_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  sender_label TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  recipient_label TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  source_run_id TEXT,
  source_tool_call_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_messages_team_sequence
  ON team_messages(team_run_id, sequence);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;
