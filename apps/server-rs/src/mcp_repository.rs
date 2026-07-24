use std::collections::BTreeMap;

use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

use crate::{
    database::Database,
    error::AppError,
    models::{CreateMcpServerInput, McpServer, UpdateMcpServerInput},
};

#[derive(Clone)]
pub struct McpRepository {
    database: Database,
}

impl McpRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn list(&self) -> Result<Vec<McpServer>, AppError> {
        let rows = sqlx::query(
            r#"
            SELECT id, name, command, args_json, env_json, enabled, created_at, updated_at
            FROM mcp_servers
            ORDER BY name COLLATE NOCASE ASC
            "#,
        )
        .fetch_all(self.database.pool())
        .await?;
        rows.into_iter().map(map_row).collect()
    }

    pub async fn list_enabled(&self) -> Result<Vec<McpServer>, AppError> {
        let rows = sqlx::query(
            r#"
            SELECT id, name, command, args_json, env_json, enabled, created_at, updated_at
            FROM mcp_servers
            WHERE enabled = 1
            ORDER BY name COLLATE NOCASE ASC
            "#,
        )
        .fetch_all(self.database.pool())
        .await?;
        rows.into_iter().map(map_row).collect()
    }

    pub async fn get(&self, id: &str) -> Result<Option<McpServer>, AppError> {
        let row = sqlx::query(
            r#"
            SELECT id, name, command, args_json, env_json, enabled, created_at, updated_at
            FROM mcp_servers
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(self.database.pool())
        .await?;
        row.map(map_row).transpose()
    }

    pub async fn create(&self, input: CreateMcpServerInput) -> Result<McpServer, AppError> {
        let name = validate_name(&input.name)?;
        let command = validate_command(&input.command)?;
        let args = input.args;
        let env = input.env;
        let now = Utc::now().to_rfc3339();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            INSERT INTO mcp_servers (
              id, name, command, args_json, env_json, enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&name)
        .bind(&command)
        .bind(serde_json::to_string(&args).unwrap_or_else(|_| "[]".into()))
        .bind(serde_json::to_string(&env).unwrap_or_else(|_| "{}".into()))
        .bind(if input.enabled { 1 } else { 0 })
        .bind(&now)
        .bind(&now)
        .execute(self.database.pool())
        .await
        .map_err(map_unique)?;
        self.get(&id)
            .await?
            .ok_or_else(|| AppError::configuration("Failed to load created MCP server"))
    }

    pub async fn update(
        &self,
        id: &str,
        input: UpdateMcpServerInput,
    ) -> Result<McpServer, AppError> {
        let existing = self
            .get(id)
            .await?
            .ok_or_else(|| AppError::configuration_not_found("MCP server not found"))?;
        let name = match input.name.as_deref() {
            Some(value) => validate_name(value)?,
            None => existing.name,
        };
        let command = match input.command.as_deref() {
            Some(value) => validate_command(value)?,
            None => existing.command,
        };
        let args = input.args.unwrap_or(existing.args);
        let env = input.env.unwrap_or(existing.env);
        let enabled = input.enabled.unwrap_or(existing.enabled);
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            UPDATE mcp_servers
            SET name = ?, command = ?, args_json = ?, env_json = ?, enabled = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .bind(&name)
        .bind(&command)
        .bind(serde_json::to_string(&args).unwrap_or_else(|_| "[]".into()))
        .bind(serde_json::to_string(&env).unwrap_or_else(|_| "{}".into()))
        .bind(if enabled { 1 } else { 0 })
        .bind(&now)
        .bind(id)
        .execute(self.database.pool())
        .await
        .map_err(map_unique)?;
        self.get(id)
            .await?
            .ok_or_else(|| AppError::configuration_not_found("MCP server not found"))
    }

    pub async fn delete(&self, id: &str) -> Result<(), AppError> {
        let result = sqlx::query("DELETE FROM mcp_servers WHERE id = ?")
            .bind(id)
            .execute(self.database.pool())
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::configuration_not_found("MCP server not found"));
        }
        Ok(())
    }
}

fn map_row(row: sqlx::sqlite::SqliteRow) -> Result<McpServer, AppError> {
    let args_json: String = row.try_get("args_json")?;
    let env_json: String = row.try_get("env_json")?;
    let args = serde_json::from_str(&args_json).unwrap_or_default();
    let env: BTreeMap<String, String> = serde_json::from_str(&env_json).unwrap_or_default();
    let enabled: i64 = row.try_get("enabled")?;
    Ok(McpServer {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        command: row.try_get("command")?,
        args,
        env,
        enabled: enabled != 0,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn validate_name(value: &str) -> Result<String, AppError> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(AppError::invalid_request(
            "MCP server name must be 1-80 characters",
        ));
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        return Err(AppError::invalid_request(
            "MCP server name may only contain letters, numbers, '.', '-' and '_'",
        ));
    }
    Ok(name.to_owned())
}

fn validate_command(value: &str) -> Result<String, AppError> {
    let command = value.trim();
    if command.is_empty() || command.chars().count() > 512 {
        return Err(AppError::invalid_request(
            "MCP command must be 1-512 characters",
        ));
    }
    Ok(command.to_owned())
}

fn map_unique(error: sqlx::Error) -> AppError {
    let message = error.to_string();
    if message.contains("UNIQUE") {
        AppError::invalid_request("MCP server name must be unique")
    } else {
        AppError::Database(error)
    }
}
