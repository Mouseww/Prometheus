use chrono::{SecondsFormat, Utc};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    database::Database,
    error::AppError,
    models::TeamMessage,
};

#[derive(Clone)]
pub struct TeamMessageRepository {
    database: Database,
}

pub struct AppendTeamMessageInput {
    pub team_run_id: String,
    pub sender_agent_id: String,
    pub recipient_id: String,
    pub channel: String,
    pub subject: Option<String>,
    pub body: String,
    pub source_run_id: Option<String>,
    pub source_tool_call_id: Option<String>,
}

#[derive(FromRow)]
struct TeamMessageRow {
    sequence: i64,
    id: String,
    team_run_id: String,
    session_id: String,
    sender_agent_id: String,
    sender_label: String,
    recipient_id: String,
    recipient_label: String,
    channel: String,
    subject: Option<String>,
    body: String,
    source_run_id: Option<String>,
    source_tool_call_id: Option<String>,
    created_at: String,
}

#[derive(FromRow)]
struct TeamMemberRow {
    agent_id: String,
    agent_label: String,
    session_id: String,
}

impl TeamMessageRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn append(&self, input: AppendTeamMessageInput) -> Result<TeamMessage, AppError> {
        let recipient_id = validate_recipient(&input.recipient_id)?;
        let channel = validate_channel(&input.channel)?;
        let body = input.body.trim().to_owned();
        if body.is_empty() || body.chars().count() > 12_000 {
            return Err(AppError::invalid_request("Message body is invalid"));
        }
        let subject = input
            .subject
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if let Some(subject) = &subject
            && subject.chars().count() > 160
        {
            return Err(AppError::invalid_request("Message subject is too long"));
        }

        let members = self.members(&input.team_run_id).await?;
        if members.is_empty() {
            return Err(AppError::team_run_not_found("Team run not found"));
        }
        let sender = members
            .iter()
            .find(|member| member.agent_id == input.sender_agent_id)
            .ok_or_else(|| {
                AppError::invalid_request("Message sender is not a member of this team")
            })?;
        let recipient_label = match recipient_id.as_str() {
            "parent" => "Parent agent".to_owned(),
            "*" => "All agents".to_owned(),
            other => members
                .iter()
                .find(|member| member.agent_id == other)
                .map(|member| member.agent_label.clone())
                .ok_or_else(|| {
                    AppError::invalid_request("Message recipient is not a member of this team")
                })?,
        };

        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        sqlx::query(
            r#"
            INSERT INTO team_messages (
              id, team_run_id, session_id, sender_agent_id, sender_label,
              recipient_id, recipient_label, channel, subject, body,
              source_run_id, source_tool_call_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&input.team_run_id)
        .bind(&sender.session_id)
        .bind(&sender.agent_id)
        .bind(&sender.agent_label)
        .bind(&recipient_id)
        .bind(&recipient_label)
        .bind(&channel)
        .bind(&subject)
        .bind(&body)
        .bind(&input.source_run_id)
        .bind(&input.source_tool_call_id)
        .bind(&created_at)
        .execute(self.database.pool())
        .await?;

        self.get(&id)
            .await?
            .ok_or_else(|| AppError::invalid_request("Team message missing after insert"))
    }

    pub async fn list(
        &self,
        team_run_id: &str,
        after_sequence: i64,
    ) -> Result<Vec<TeamMessage>, AppError> {
        let rows = sqlx::query_as::<_, TeamMessageRow>(
            r#"
            SELECT sequence, id, team_run_id, session_id, sender_agent_id, sender_label,
                   recipient_id, recipient_label, channel, subject, body,
                   source_run_id, source_tool_call_id, created_at
            FROM team_messages
            WHERE team_run_id = ? AND sequence > ?
            ORDER BY sequence ASC
            LIMIT 200
            "#,
        )
        .bind(team_run_id)
        .bind(after_sequence)
        .fetch_all(self.database.pool())
        .await?;
        Ok(rows.into_iter().map(map_message).collect())
    }

    pub async fn list_visible_to(
        &self,
        team_run_id: &str,
        agent_id: &str,
        after_sequence: i64,
    ) -> Result<Vec<TeamMessage>, AppError> {
        let rows = sqlx::query_as::<_, TeamMessageRow>(
            r#"
            SELECT sequence, id, team_run_id, session_id, sender_agent_id, sender_label,
                   recipient_id, recipient_label, channel, subject, body,
                   source_run_id, source_tool_call_id, created_at
            FROM team_messages
            WHERE team_run_id = ? AND sequence > ?
              AND (recipient_id = '*' OR recipient_id = ? OR sender_agent_id = ?)
            ORDER BY sequence ASC
            LIMIT 200
            "#,
        )
        .bind(team_run_id)
        .bind(after_sequence)
        .bind(agent_id)
        .bind(agent_id)
        .fetch_all(self.database.pool())
        .await?;
        Ok(rows.into_iter().map(map_message).collect())
    }

    async fn get(&self, id: &str) -> Result<Option<TeamMessage>, AppError> {
        let row = sqlx::query_as::<_, TeamMessageRow>(
            r#"
            SELECT sequence, id, team_run_id, session_id, sender_agent_id, sender_label,
                   recipient_id, recipient_label, channel, subject, body,
                   source_run_id, source_tool_call_id, created_at
            FROM team_messages
            WHERE id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(self.database.pool())
        .await?;
        Ok(row.map(map_message))
    }

    async fn members(&self, team_run_id: &str) -> Result<Vec<TeamMemberRow>, AppError> {
        let rows = sqlx::query_as::<_, TeamMemberRow>(
            r#"
            SELECT agent_id, agent_label, session_id
            FROM team_run_tasks
            WHERE team_run_id = ?
            ORDER BY ordinal ASC
            "#,
        )
        .bind(team_run_id)
        .fetch_all(self.database.pool())
        .await?;
        Ok(rows)
    }
}

fn map_message(row: TeamMessageRow) -> TeamMessage {
    TeamMessage {
        id: row.id,
        sequence: row.sequence,
        team_run_id: row.team_run_id,
        session_id: row.session_id,
        sender_agent_id: row.sender_agent_id,
        sender_label: row.sender_label,
        recipient_id: row.recipient_id,
        recipient_label: row.recipient_label,
        channel: row.channel,
        subject: row.subject,
        body: row.body,
        source_run_id: row.source_run_id,
        source_tool_call_id: row.source_tool_call_id,
        created_at: row.created_at,
    }
}

fn validate_recipient(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value == "parent" || value == "*" {
        return Ok(value.to_owned());
    }
    if Uuid::parse_str(value).is_err() {
        return Err(AppError::invalid_request(
            "Message recipient must be parent, *, or an agent UUID",
        ));
    }
    Ok(value.to_owned())
}

fn validate_channel(value: &str) -> Result<String, AppError> {
    match value.trim() {
        "direct" | "shared" | "decision" | "question" => Ok(value.trim().to_owned()),
        _ => Err(AppError::invalid_request("Message channel is invalid")),
    }
}
