use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    database::Database,
    error::AppError,
    models::{TeamRun, TeamRunTask},
};

#[derive(Clone)]
pub struct TeamRunRepository {
    database: Database,
}

pub struct CreateTeamRunRecord {
    pub session_id: String,
    pub goal: String,
    pub max_concurrency: u32,
    pub workspace_mode: String,
    pub merge_strategy: String,
    pub tasks: Vec<CreateTeamTaskRecord>,
}

pub struct CreateTeamTaskRecord {
    pub agent_id: String,
    pub agent_label: String,
    pub prompt: String,
    pub allowed_paths: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct TeamTaskWorkspace {
    pub task_id: String,
    pub team_run_id: String,
    pub session_id: String,
    pub agent_id: String,
    pub allowed_paths: Vec<String>,
    pub worktree_root: Option<String>,
    pub worktree_branch: Option<String>,
    pub base_commit: Option<String>,
    pub changed_paths: Vec<String>,
    pub change_status: String,
    pub conflict_paths: Vec<String>,
    pub patch_bytes: u64,
}

#[derive(FromRow)]
struct TeamRunRow {
    id: String,
    session_id: String,
    goal: String,
    status: String,
    max_concurrency: i64,
    workspace_mode: String,
    merge_strategy: String,
    created_at: String,
    completed_at: Option<String>,
}

#[derive(FromRow)]
struct TeamTaskRow {
    id: String,
    team_run_id: String,
    session_id: String,
    agent_id: String,
    agent_label: String,
    prompt: String,
    status: String,
    output: Option<String>,
    error: Option<String>,
    allowed_paths_json: String,
    worktree_branch: Option<String>,
    base_commit: Option<String>,
    changed_paths_json: String,
    change_status: String,
    conflict_paths_json: String,
    patch_bytes: i64,
    created_at: String,
    started_at: Option<String>,
    completed_at: Option<String>,
}

impl TeamRunRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn create(&self, input: CreateTeamRunRecord) -> Result<TeamRun, AppError> {
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut tx = self.database.pool().begin().await?;
        sqlx::query(
            r#"
            INSERT INTO team_runs (
              id, session_id, goal, status, max_concurrency, workspace_mode,
              merge_strategy, created_at, completed_at
            ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, NULL)
            "#,
        )
        .bind(&id)
        .bind(&input.session_id)
        .bind(&input.goal)
        .bind(input.max_concurrency as i64)
        .bind(&input.workspace_mode)
        .bind(&input.merge_strategy)
        .bind(&created_at)
        .execute(&mut *tx)
        .await?;

        for (ordinal, task) in input.tasks.iter().enumerate() {
            let task_id = Uuid::new_v4().to_string();
            let allowed = serde_json::to_string(&task.allowed_paths).unwrap_or_else(|_| "[]".into());
            sqlx::query(
                r#"
                INSERT INTO team_run_tasks (
                  id, team_run_id, session_id, agent_id, agent_label, prompt, ordinal,
                  status, output, error, allowed_paths_json, worktree_root, worktree_branch,
                  base_commit, changed_paths_json, change_status, conflict_paths_json,
                  patch_bytes, created_at, started_at, completed_at
                ) VALUES (
                  ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, NULL, NULL,
                  NULL, '[]', 'not_applicable', '[]', 0, ?, NULL, NULL
                )
                "#,
            )
            .bind(&task_id)
            .bind(&id)
            .bind(&input.session_id)
            .bind(&task.agent_id)
            .bind(&task.agent_label)
            .bind(&task.prompt)
            .bind(ordinal as i64)
            .bind(&allowed)
            .bind(&created_at)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.get(&id)
            .await?
            .ok_or_else(|| AppError::team_run_not_found("Team run not found after create"))
    }

    pub async fn get(&self, id: &str) -> Result<Option<TeamRun>, AppError> {
        let row = sqlx::query_as::<_, TeamRunRow>(
            r#"
            SELECT id, session_id, goal, status, max_concurrency, workspace_mode,
                   merge_strategy, created_at, completed_at
            FROM team_runs
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(self.database.pool())
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let tasks = self.list_tasks(id).await?;
        Ok(Some(map_team(row, tasks)))
    }

    pub async fn list_for_session(&self, session_id: &str) -> Result<Vec<TeamRun>, AppError> {
        let rows = sqlx::query_as::<_, TeamRunRow>(
            r#"
            SELECT id, session_id, goal, status, max_concurrency, workspace_mode,
                   merge_strategy, created_at, completed_at
            FROM team_runs
            WHERE session_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(session_id)
        .fetch_all(self.database.pool())
        .await?;
        let mut teams = Vec::with_capacity(rows.len());
        for row in rows {
            let tasks = self.list_tasks(&row.id).await?;
            teams.push(map_team(row, tasks));
        }
        Ok(teams)
    }

    pub async fn mark_task_running(&self, task_id: &str) -> Result<(), AppError> {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let result = sqlx::query(
            r#"
            UPDATE team_run_tasks
            SET status = 'running', started_at = ?, error = NULL
            WHERE id = ?
            "#,
        )
        .bind(&now)
        .bind(task_id)
        .execute(self.database.pool())
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::team_task_not_found("Team task not found"));
        }
        Ok(())
    }

    pub async fn complete_task(&self, task_id: &str, output: &str) -> Result<(), AppError> {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let result = sqlx::query(
            r#"
            UPDATE team_run_tasks
            SET status = 'completed', output = ?, error = NULL, completed_at = ?
            WHERE id = ?
            "#,
        )
        .bind(output)
        .bind(&now)
        .bind(task_id)
        .execute(self.database.pool())
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::team_task_not_found("Team task not found"));
        }
        Ok(())
    }

    pub async fn fail_task(&self, task_id: &str, error: &str) -> Result<(), AppError> {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let result = sqlx::query(
            r#"
            UPDATE team_run_tasks
            SET status = 'failed', error = ?, completed_at = ?
            WHERE id = ?
            "#,
        )
        .bind(error)
        .bind(&now)
        .bind(task_id)
        .execute(self.database.pool())
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::team_task_not_found("Team task not found"));
        }
        Ok(())
    }

    pub async fn complete_run(&self, team_run_id: &str, status: &str) -> Result<(), AppError> {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let result = sqlx::query(
            r#"
            UPDATE team_runs
            SET status = ?, completed_at = ?
            WHERE id = ?
            "#,
        )
        .bind(status)
        .bind(&now)
        .bind(team_run_id)
        .execute(self.database.pool())
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::team_run_not_found("Team run not found"));
        }
        Ok(())
    }

    pub async fn interrupt_running(&self) -> Result<u64, AppError> {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let tasks = sqlx::query(
            r#"
            UPDATE team_run_tasks
            SET status = 'interrupted', completed_at = COALESCE(completed_at, ?)
            WHERE status IN ('queued', 'running')
            "#,
        )
        .bind(&now)
        .execute(self.database.pool())
        .await?
        .rows_affected();
        let runs = sqlx::query(
            r#"
            UPDATE team_runs
            SET status = 'interrupted', completed_at = COALESCE(completed_at, ?)
            WHERE status = 'running'
            "#,
        )
        .bind(&now)
        .execute(self.database.pool())
        .await?
        .rows_affected();
        Ok(tasks + runs)
    }


    pub async fn set_task_workspace(
        &self,
        task_id: &str,
        worktree_root: &str,
        worktree_branch: &str,
        base_commit: &str,
    ) -> Result<(), AppError> {
        let result = sqlx::query(
            r#"
            UPDATE team_run_tasks
            SET worktree_root = ?, worktree_branch = ?, base_commit = ?,
                change_status = 'isolated', changed_paths_json = '[]',
                conflict_paths_json = '[]', patch_bytes = 0
            WHERE id = ?
            "#,
        )
        .bind(worktree_root)
        .bind(worktree_branch)
        .bind(base_commit)
        .bind(task_id)
        .execute(self.database.pool())
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::team_task_not_found("Team task not found"));
        }
        Ok(())
    }

    pub async fn record_task_changes(
        &self,
        task_id: &str,
        changed_paths: &[String],
        change_status: &str,
        conflict_paths: &[String],
        patch_bytes: u64,
    ) -> Result<(), AppError> {
        let result = sqlx::query(
            r#"
            UPDATE team_run_tasks
            SET changed_paths_json = ?, change_status = ?, conflict_paths_json = ?, patch_bytes = ?
            WHERE id = ?
            "#,
        )
        .bind(serde_json::to_string(changed_paths).unwrap_or_else(|_| "[]".into()))
        .bind(change_status)
        .bind(serde_json::to_string(conflict_paths).unwrap_or_else(|_| "[]".into()))
        .bind(patch_bytes as i64)
        .bind(task_id)
        .execute(self.database.pool())
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::team_task_not_found("Team task not found"));
        }
        Ok(())
    }

    pub async fn clear_task_workspace_root(&self, task_id: &str) -> Result<(), AppError> {
        let result = sqlx::query(
            "UPDATE team_run_tasks SET worktree_root = NULL WHERE id = ?",
        )
        .bind(task_id)
        .execute(self.database.pool())
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::team_task_not_found("Team task not found"));
        }
        Ok(())
    }

    pub async fn get_task_workspace(
        &self,
        task_id: &str,
    ) -> Result<Option<TeamTaskWorkspace>, AppError> {
        #[derive(sqlx::FromRow)]
        struct Row {
            id: String,
            team_run_id: String,
            session_id: String,
            agent_id: String,
            allowed_paths_json: String,
            worktree_root: Option<String>,
            worktree_branch: Option<String>,
            base_commit: Option<String>,
            changed_paths_json: String,
            change_status: String,
            conflict_paths_json: String,
            patch_bytes: i64,
        }
        let row = sqlx::query_as::<_, Row>(
            r#"
            SELECT id, team_run_id, session_id, agent_id, allowed_paths_json,
                   worktree_root, worktree_branch, base_commit, changed_paths_json,
                   change_status, conflict_paths_json, patch_bytes
            FROM team_run_tasks
            WHERE id = ?
            "#,
        )
        .bind(task_id)
        .fetch_optional(self.database.pool())
        .await?;
        Ok(row.map(|row| TeamTaskWorkspace {
            task_id: row.id,
            team_run_id: row.team_run_id,
            session_id: row.session_id,
            agent_id: row.agent_id,
            allowed_paths: parse_paths(&row.allowed_paths_json),
            worktree_root: row.worktree_root,
            worktree_branch: row.worktree_branch,
            base_commit: row.base_commit,
            changed_paths: parse_paths(&row.changed_paths_json),
            change_status: row.change_status,
            conflict_paths: parse_paths(&row.conflict_paths_json),
            patch_bytes: row.patch_bytes.max(0) as u64,
        }))
    }

    async fn list_tasks(&self, team_run_id: &str) -> Result<Vec<TeamRunTask>, AppError> {
        let rows = sqlx::query_as::<_, TeamTaskRow>(
            r#"
            SELECT id, team_run_id, session_id, agent_id, agent_label, prompt, status,
                   output, error, allowed_paths_json, worktree_branch, base_commit,
                   changed_paths_json, change_status, conflict_paths_json, patch_bytes,
                   created_at, started_at, completed_at
            FROM team_run_tasks
            WHERE team_run_id = ?
            ORDER BY ordinal ASC
            "#,
        )
        .bind(team_run_id)
        .fetch_all(self.database.pool())
        .await?;
        Ok(rows.into_iter().map(map_task).collect())
    }
}

fn map_team(row: TeamRunRow, tasks: Vec<TeamRunTask>) -> TeamRun {
    TeamRun {
        id: row.id,
        session_id: row.session_id,
        goal: row.goal,
        status: row.status,
        max_concurrency: row.max_concurrency as u32,
        workspace_mode: row.workspace_mode,
        merge_strategy: row.merge_strategy,
        tasks,
        created_at: row.created_at,
        completed_at: row.completed_at,
    }
}

fn map_task(row: TeamTaskRow) -> TeamRunTask {
    TeamRunTask {
        id: row.id,
        team_run_id: row.team_run_id,
        session_id: row.session_id,
        agent_id: row.agent_id,
        agent_label: row.agent_label,
        prompt: row.prompt,
        status: row.status,
        output: row.output,
        error: row.error,
        allowed_paths: parse_paths(&row.allowed_paths_json),
        worktree_branch: row.worktree_branch,
        base_commit: row.base_commit,
        changed_paths: parse_paths(&row.changed_paths_json),
        change_status: row.change_status,
        conflict_paths: parse_paths(&row.conflict_paths_json),
        patch_bytes: row.patch_bytes.max(0) as u64,
        created_at: row.created_at,
        started_at: row.started_at,
        completed_at: row.completed_at,
    }
}

fn parse_paths(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw)
        .ok()
        .unwrap_or_default()
        .into_iter()
        .filter(|path| !path.trim().is_empty())
        .collect()
}

#[allow(dead_code)]
fn parse_value_paths(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
