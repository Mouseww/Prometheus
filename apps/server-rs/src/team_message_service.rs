use serde_json::json;
use uuid::Uuid;

use crate::{
    error::AppError,
    event_hub::EventHub,
    models::{Actor, AppendEventInput, TeamMessage},
    session_repository::SessionRepository,
    team_message_repository::{AppendTeamMessageInput, TeamMessageRepository},
};

#[derive(Clone)]
pub struct TeamMessageService {
    sessions: SessionRepository,
    messages: TeamMessageRepository,
    event_hub: EventHub,
}

impl TeamMessageService {
    pub fn new(
        sessions: SessionRepository,
        messages: TeamMessageRepository,
        event_hub: EventHub,
    ) -> Self {
        Self {
            sessions,
            messages,
            event_hub,
        }
    }

    pub async fn send(&self, input: AppendTeamMessageInput) -> Result<TeamMessage, AppError> {
        let message = self.messages.append(input).await?;
        let event = self
            .sessions
            .append_event(
                &message.session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "agent.message".to_owned(),
                    actor: Actor {
                        kind: "agent".into(),
                        id: message.sender_agent_id.clone(),
                        label: message.sender_label.clone(),
                    },
                    payload: json!({
                        "teamRunId": message.team_run_id,
                        "messageId": message.id,
                        "messageSequence": message.sequence,
                        "recipientId": message.recipient_id,
                        "recipientLabel": message.recipient_label,
                        "channel": message.channel,
                        "subject": message.subject,
                        "text": message.body,
                        "sourceRunId": message.source_run_id,
                        "sourceToolCallId": message.source_tool_call_id,
                    }),
                },
            )
            .await?;
        self.event_hub.publish(event).await;
        Ok(message)
    }

    pub async fn list(
        &self,
        team_run_id: &str,
        after_sequence: i64,
    ) -> Result<Vec<TeamMessage>, AppError> {
        if after_sequence < 0 {
            return Err(AppError::invalid_request("afterSequence must be >= 0"));
        }
        // Ensure team exists by attempting list; empty could mean missing team.
        // Mirror Node: list without existence check returns []. App route checks team exists.
        self.messages.list(team_run_id, after_sequence).await
    }

    pub fn repository(&self) -> &TeamMessageRepository {
        &self.messages
    }
}
