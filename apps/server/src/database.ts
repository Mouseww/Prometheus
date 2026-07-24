import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }

  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON;");
  if (filename !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL;");
  }
  migrate(database);
  return database;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
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
  `);

  ensureColumn(database, "team_runs", "workspace_mode", "TEXT NOT NULL DEFAULT 'readonly'");
  ensureColumn(database, "team_runs", "merge_strategy", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(database, "team_run_tasks", "allowed_paths_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "team_run_tasks", "worktree_root", "TEXT");
  ensureColumn(database, "team_run_tasks", "worktree_branch", "TEXT");
  ensureColumn(database, "team_run_tasks", "base_commit", "TEXT");
  ensureColumn(database, "team_run_tasks", "changed_paths_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "team_run_tasks", "change_status", "TEXT NOT NULL DEFAULT 'not_applicable'");
  ensureColumn(database, "team_run_tasks", "conflict_paths_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "team_run_tasks", "patch_bytes", "INTEGER NOT NULL DEFAULT 0");
}

function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((candidate) => candidate.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
