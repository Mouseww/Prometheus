use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use crate::{
    error::AppError,
    team_message_repository::AppendTeamMessageInput,
    team_message_service::TeamMessageService,
    tools::{AgentTool, ToolApprovalPolicy, ToolResult},
};

#[derive(Clone)]
pub struct TeamMessageToolContext {
    pub team_run_id: String,
    pub agent_id: String,
    pub run_id: String,
}

pub fn team_message_tools(
    service: TeamMessageService,
    context: TeamMessageToolContext,
) -> Vec<AgentTool> {
    vec![
        send_team_message_tool(service.clone(), context.clone()),
        read_team_messages_tool(service, context),
    ]
}

fn send_team_message_tool(service: TeamMessageService, context: TeamMessageToolContext) -> AgentTool {
    AgentTool {
        name: "send_team_message".into(),
        description: [
            "Send a durable message to parent, all agents (*), or one agent id in this team.",
            "Use channel=question for a requested reply and channel=decision for a shared durable decision.",
            "Do not use workspace files as an Agent communication channel.",
        ]
        .join(" "),
        approval: ToolApprovalPolicy::Never,
        input_schema: json!({
            "type": "object",
            "properties": {
                "to": {
                    "type": "string",
                    "description": "parent, *, or a team member agent UUID",
                    "default": "parent"
                },
                "message": { "type": "string", "minLength": 1, "maxLength": 12_000 },
                "channel": { "enum": ["direct", "shared", "decision", "question"] },
                "subject": { "type": "string", "maxLength": 160 }
            },
            "required": ["message"],
            "additionalProperties": false
        }),
        summarize_arguments: Some(Box::new(|arguments| {
            let to = string_arg(arguments, "to").unwrap_or("parent");
            let channel = normalize_channel(string_arg(arguments, "channel"), to);
            let message = string_arg(arguments, "message").unwrap_or_default();
            json!({
                "to": to,
                "channel": channel,
                "subject": string_arg(arguments, "subject"),
                "messagePreview": preview(message, 240),
            })
        })),
        permission_target: None,
        execute: Box::new(move |call| {
            let arguments = &call.arguments;
            let message = required_string(arguments, "message")?;
            let to = string_arg(arguments, "to").unwrap_or("parent");
            let channel = normalize_channel(string_arg(arguments, "channel"), to);
            let subject = string_arg(arguments, "subject").map(str::to_owned);
            let runtime = tokio::runtime::Handle::try_current().map_err(|_| {
                AppError::invalid_request("Team message tools require a Tokio runtime")
            })?;
            let sent = tokio::task::block_in_place(|| {
                runtime.block_on(service.send(AppendTeamMessageInput {
                    team_run_id: context.team_run_id.clone(),
                    sender_agent_id: context.agent_id.clone(),
                    recipient_id: to.to_owned(),
                    channel,
                    subject,
                    body: message.to_owned(),
                    source_run_id: Some(context.run_id.clone()),
                    source_tool_call_id: Some(call.id.clone()),
                }))
            })?;
            Ok(ToolResult {
                content: format!(
                    "Message sent to {}.\nsequence={}\nchannel={}",
                    sent.recipient_label, sent.sequence, sent.channel
                ),
                is_error: false,
            })
        }),
    }
}

fn read_team_messages_tool(
    service: TeamMessageService,
    context: TeamMessageToolContext,
) -> AgentTool {
    AgentTool {
        name: "read_team_messages".into(),
        description: "Read durable shared, direct and self-sent team messages after a sequence. Optionally wait briefly for another agent.".into(),
        approval: ToolApprovalPolicy::Never,
        input_schema: json!({
            "type": "object",
            "properties": {
                "afterSequence": { "type": "integer", "minimum": 0, "default": 0 },
                "waitMs": { "type": "integer", "minimum": 0, "maximum": 5_000, "default": 0 }
            },
            "additionalProperties": false
        }),
        summarize_arguments: None,
        permission_target: None,
        execute: Box::new(move |call| {
            let arguments = &call.arguments;
            let after_sequence = int_arg(arguments, "afterSequence").unwrap_or(0);
            if after_sequence < 0 {
                return Err(AppError::invalid_request("afterSequence must be >= 0"));
            }
            let wait_ms = int_arg(arguments, "waitMs").unwrap_or(0).clamp(0, 5_000) as u64;
            let runtime = tokio::runtime::Handle::try_current().map_err(|_| {
                AppError::invalid_request("Team message tools require a Tokio runtime")
            })?;
            let deadline = Instant::now() + Duration::from_millis(wait_ms);
            let messages = loop {
                let batch = tokio::task::block_in_place(|| {
                    runtime.block_on(service.repository().list_visible_to(
                        &context.team_run_id,
                        &context.agent_id,
                        after_sequence,
                    ))
                })?;
                if !batch.is_empty() || Instant::now() >= deadline {
                    break batch;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                thread::sleep(remaining.min(Duration::from_millis(100)));
            };
            let content = if messages.is_empty() {
                "[No team messages]".to_owned()
            } else {
                render_messages(&messages)
            };
            Ok(ToolResult {
                content,
                is_error: false,
            })
        }),
    }
}

fn normalize_channel(channel: Option<&str>, recipient_id: &str) -> String {
    if recipient_id == "*" {
        match channel {
            None | Some("direct") => "shared".to_owned(),
            Some(other) => other.to_owned(),
        }
    } else {
        match channel {
            Some("shared") => "direct".to_owned(),
            Some(other) => other.to_owned(),
            None => "direct".to_owned(),
        }
    }
}

fn render_messages(messages: &[crate::models::TeamMessage]) -> String {
    messages
        .iter()
        .map(|message| {
            let mut lines = vec![format!(
                "#{} {} -> {} [{}]",
                message.sequence,
                message.sender_label,
                message.recipient_label,
                message.channel
            )];
            if let Some(subject) = &message.subject {
                lines.push(format!("Subject: {subject}"));
            }
            lines.push(preview(&message.body, 2_400));
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

fn preview(value: &str, max_length: usize) -> String {
    let text = value.trim();
    if text.chars().count() <= max_length {
        text.to_owned()
    } else {
        let clipped: String = text.chars().take(max_length.saturating_sub(32)).collect();
        format!("{clipped}\n[truncated; chars={}]", text.chars().count())
    }
}

fn required_string<'a>(arguments: &'a Value, field: &str) -> Result<&'a str, AppError> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::invalid_request(format!("{field} is required")))
}

fn string_arg<'a>(arguments: &'a Value, field: &str) -> Option<&'a str> {
    arguments.get(field).and_then(Value::as_str)
}

fn int_arg(arguments: &Value, field: &str) -> Option<i64> {
    arguments.get(field).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().map(|n| n as i64))
            .or_else(|| value.as_f64().map(|n| n as i64))
    })
}
