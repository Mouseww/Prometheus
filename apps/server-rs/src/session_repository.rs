use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    database::Database,
    error::AppError,
    models::{Actor, AppendEventInput, Session, SessionEvent},
};

const EVENT_TYPES: &[&str] = &[
    "message.user",
    "message.agent",
    "session.status",
    "agent.spawned",
    "agent.status",
    "agent.message",
    "tool.call.started",
    "tool.call.completed",
    "approval.requested",
    "approval.resolved",
    "permission.rule.matched",
    "system.notice",
    "agent.run.started",
    "agent.run.completed",
    "agent.run.failed",
    "agent.run.cancelled",
    "team.workspace.created",
    "team.changes.detected",
    "team.changes.applied",
    "team.changes.conflicted",
    "team.workspace.discarded",
    "team.workspace.cleaned",
];

const ACTOR_KINDS: &[&str] = &["user", "agent", "system", "tool"];

#[derive(Clone)]
pub struct SessionRepository {
    database: Database,
}

impl SessionRepository {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub async fn create(&self, raw_title: &str) -> Result<Session, AppError> {
        let title = raw_title.trim();
        if title.is_empty() || title.chars().count() > 160 {
            return Err(AppError::invalid_request(
                "Title must contain between 1 and 160 characters",
            ));
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        sqlx::query(
            "INSERT INTO sessions (id, title, status, created_at, updated_at) VALUES (?, ?, 'idle', ?, ?)",
        )
        .bind(&id)
        .bind(title)
        .bind(&now)
        .bind(&now)
        .execute(self.database.pool())
        .await?;
        Ok(Session {
            id,
            title: title.to_owned(),
            status: "idle".to_owned(),
            created_at: now.clone(),
            updated_at: now,
            last_sequence: 0,
        })
    }

    pub async fn list(&self) -> Result<Vec<Session>, AppError> {
        let rows = sqlx::query_as::<_, SessionRow>(
            r#"
            SELECT s.id, s.title, s.status, s.created_at, s.updated_at,
              COALESCE(MAX(e.sequence), 0) AS last_sequence
            FROM sessions s
            LEFT JOIN session_events e ON e.session_id = s.id
            GROUP BY s.id
            ORDER BY s.updated_at DESC
            "#,
        )
        .fetch_all(self.database.pool())
        .await?;
        Ok(rows.into_iter().map(Session::from).collect())
    }

    pub async fn get(&self, id: &str) -> Result<Option<Session>, AppError> {
        let row = sqlx::query_as::<_, SessionRow>(
            r#"
            SELECT s.id, s.title, s.status, s.created_at, s.updated_at,
              COALESCE(MAX(e.sequence), 0) AS last_sequence
            FROM sessions s
            LEFT JOIN session_events e ON e.session_id = s.id
            WHERE s.id = ?
            GROUP BY s.id
            "#,
        )
        .bind(id)
        .fetch_optional(self.database.pool())
        .await?;
        Ok(row.map(Session::from))
    }

    pub async fn list_events(
        &self,
        session_id: &str,
        after_sequence: i64,
    ) -> Result<Vec<SessionEvent>, AppError> {
        if self.get(session_id).await?.is_none() {
            return Err(AppError::session_not_found(session_id));
        }
        let after_sequence = after_sequence.max(0);
        let rows = sqlx::query_as::<_, EventRow>(
            r#"
            SELECT sequence, event_id, session_id, type, actor_json, payload_json, created_at
            FROM session_events
            WHERE session_id = ? AND sequence > ?
            ORDER BY sequence ASC
            "#,
        )
        .bind(session_id)
        .bind(after_sequence)
        .fetch_all(self.database.pool())
        .await?;
        rows.into_iter().map(SessionEvent::try_from).collect()
    }

    pub async fn append_event(
        &self,
        session_id: &str,
        input: AppendEventInput,
    ) -> Result<SessionEvent, AppError> {
        if self.get(session_id).await?.is_none() {
            return Err(AppError::session_not_found(session_id));
        }

        let event_id = parse_uuid(&input.event_id, "eventId")?;
        validate_event_type(&input.event_type)?;
        validate_actor(&input.actor)?;
        if !input.payload.is_object() {
            return Err(AppError::invalid_request(
                "payload must be a JSON object",
            ));
        }

        let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let actor_json = serde_json::to_string(&input.actor)
            .map_err(|error| AppError::invalid_request(error.to_string()))?;
        let payload_json = serde_json::to_string(&input.payload)
            .map_err(|error| AppError::invalid_request(error.to_string()))?;

        let result = sqlx::query(
            r#"
            INSERT OR IGNORE INTO session_events (
              event_id, session_id, type, actor_json, payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&event_id)
        .bind(session_id)
        .bind(&input.event_type)
        .bind(&actor_json)
        .bind(&payload_json)
        .bind(&created_at)
        .execute(self.database.pool())
        .await?;

        let stored = sqlx::query_as::<_, EventRow>(
            r#"
            SELECT sequence, event_id, session_id, type, actor_json, payload_json, created_at
            FROM session_events WHERE event_id = ?
            "#,
        )
        .bind(&event_id)
        .fetch_one(self.database.pool())
        .await?;

        if result.rows_affected() == 0
            && (stored.session_id != session_id
                || stored.event_type != input.event_type
                || stored.actor_json != actor_json
                || stored.payload_json != payload_json)
        {
            return Err(AppError::event_conflict(&event_id));
        }

        sqlx::query("UPDATE sessions SET updated_at = ? WHERE id = ?")
            .bind(&created_at)
            .bind(session_id)
            .execute(self.database.pool())
            .await?;

        SessionEvent::try_from(stored)
    }
}

fn parse_uuid(value: &str, field: &str) -> Result<String, AppError> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| AppError::invalid_request(format!("{field} must be a UUID")))
}

fn validate_event_type(value: &str) -> Result<(), AppError> {
    if EVENT_TYPES.contains(&value) {
        Ok(())
    } else {
        Err(AppError::invalid_request(format!(
            "Unsupported event type: {value}"
        )))
    }
}

fn validate_actor(actor: &Actor) -> Result<(), AppError> {
    if !ACTOR_KINDS.contains(&actor.kind.as_str()) {
        return Err(AppError::invalid_request(format!(
            "Unsupported actor kind: {}",
            actor.kind
        )));
    }
    let id = actor.id.trim();
    let label = actor.label.trim();
    if id.is_empty() || id.chars().count() > 128 {
        return Err(AppError::invalid_request(
            "actor.id must contain between 1 and 128 characters",
        ));
    }
    if label.is_empty() || label.chars().count() > 128 {
        return Err(AppError::invalid_request(
            "actor.label must contain between 1 and 128 characters",
        ));
    }
    Ok(())
}

#[derive(FromRow)]
struct SessionRow {
    id: String,
    title: String,
    status: String,
    created_at: String,
    updated_at: String,
    last_sequence: i64,
}

impl From<SessionRow> for Session {
    fn from(row: SessionRow) -> Self {
        Self {
            id: row.id,
            title: row.title,
            status: row.status,
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_sequence: row.last_sequence,
        }
    }
}

#[derive(FromRow)]
struct EventRow {
    sequence: i64,
    event_id: String,
    session_id: String,
    #[sqlx(rename = "type")]
    event_type: String,
    actor_json: String,
    payload_json: String,
    created_at: String,
}

impl TryFrom<EventRow> for SessionEvent {
    type Error = AppError;

    fn try_from(row: EventRow) -> Result<Self, Self::Error> {
        let actor: Actor = serde_json::from_str(&row.actor_json).map_err(|error| {
            AppError::invalid_request(format!("Stored actor_json is invalid: {error}"))
        })?;
        let payload: Value = serde_json::from_str(&row.payload_json).map_err(|error| {
            AppError::invalid_request(format!("Stored payload_json is invalid: {error}"))
        })?;
        Ok(Self {
            sequence: row.sequence,
            event_id: row.event_id,
            session_id: row.session_id,
            event_type: row.event_type,
            actor,
            payload: if payload.is_object() {
                payload
            } else {
                json!({})
            },
            created_at: row.created_at,
        })
    }
}
