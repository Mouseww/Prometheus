use crate::{
    error::AppError,
    models::{AgentProfile, CreateTeamRunInput, TeamMessage, TeamRun},
    team_message_service::TeamMessageService,
    team_run_service::TeamRunService,
    tools::{AgentTool, ToolApprovalPolicy, ToolResult},
};
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn delegate_team_tool(
    team_runner: TeamRunService,
    messages: TeamMessageService,
    session_id: String,
    agent_id: String,
    eligible_agents: Vec<AgentProfile>,
) -> AgentTool {
    let eligible_ids: Vec<String> = eligible_agents.iter().map(|agent| agent.id.clone()).collect();
    let eligible_id_set: HashSet<String> = eligible_ids.iter().cloned().collect();
    let roster = eligible_agents
        .iter()
        .map(|agent| {
            let detail = if agent.description.trim().is_empty() {
                agent.model.as_str()
            } else {
                agent.description.as_str()
            };
            format!("{} ({}): {detail}", agent.name, agent.id)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let description = [
        "Delegate one team goal to one or more configured agents with isolated contexts.".to_owned(),
        "Independent agents run in parallel up to maxConcurrency. Subagents cannot delegate recursively.".to_owned(),
        "The default workspaceMode is readonly. Use worktree only with one non-overlapping path assignment per Agent.".to_owned(),
        "mergeStrategy=manual preserves reviewed patches for a user; auto applies only conflict-free patches.".to_owned(),
        "Include all context each agent needs in the goal because parent chat history is not copied.".to_owned(),
        "Available agents:".to_owned(),
        roster,
    ]
    .join("\n");

    let input_schema = json!({
        "type": "object",
        "properties": {
            "goal": { "type": "string", "minLength": 1, "maxLength": 12_000 },
            "agentIds": {
                "type": "array",
                "minItems": 1,
                "maxItems": 8,
                "uniqueItems": true,
                "items": { "type": "string", "enum": eligible_ids.clone() }
            },
            "maxConcurrency": { "type": "integer", "minimum": 1, "maximum": 4, "default": 4 },
            "workspaceMode": { "enum": ["readonly", "worktree"], "default": "readonly" },
            "mergeStrategy": { "enum": ["manual", "auto"], "default": "manual" },
            "pathAssignments": {
                "type": "array",
                "maxItems": 8,
                "default": [],
                "description": "Required in worktree mode: exactly one entry per selected Agent with non-overlapping workspace-relative paths.",
                "items": {
                    "type": "object",
                    "properties": {
                        "agentId": { "type": "string", "enum": eligible_ids.clone() },
                        "paths": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 64,
                            "uniqueItems": true,
                            "items": { "type": "string", "minLength": 1, "maxLength": 2_048 }
                        }
                    },
                    "required": ["agentId", "paths"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["goal", "agentIds"],
        "additionalProperties": false
    });

    AgentTool {
        name: "delegate_team".into(),
        description,
        approval: ToolApprovalPolicy::Never,
        input_schema,
        summarize_arguments: Some(Box::new(|arguments| {
            match parse_delegate_input(arguments) {
                Ok(input) => json!({
                    "goal": input.goal,
                    "agentIds": input.agent_ids,
                    "maxConcurrency": input.max_concurrency,
                    "workspaceMode": input.workspace_mode,
                    "mergeStrategy": input.merge_strategy,
                    "pathAssignments": input.path_assignments,
                }),
                Err(_) => json!({ "summary": "Invalid autonomous team delegation request" }),
            }
        })),
        permission_target: None,
        execute: Box::new(move |call| {
            let input = match parse_delegate_input(&call.arguments) {
                Ok(input) => input,
                Err(message) => {
                    return Ok(ToolResult {
                        content: message,
                        is_error: true,
                    });
                }
            };
            for selected in &input.agent_ids {
                if !eligible_id_set.contains(selected) {
                    return Ok(ToolResult {
                        content: format!(
                            "Invalid tool arguments: Agent is not available for delegation ({selected})"
                        ),
                        is_error: true,
                    });
                }
            }
            if input.agent_ids.iter().any(|id| id == &agent_id) {
                return Ok(ToolResult {
                    content: "Invalid tool arguments: Agent is not available for delegation".into(),
                    is_error: true,
                });
            }

            let runtime = tokio::runtime::Handle::try_current().map_err(|_| {
                AppError::invalid_request("delegate_team requires a Tokio runtime")
            })?;
            let team = match tokio::task::block_in_place(|| {
                runtime.block_on(team_runner.start(&session_id, input))
            }) {
                Ok(team) => team,
                Err(error) => {
                    return Ok(ToolResult {
                        content: error.to_string().chars().take(2_000).collect(),
                        is_error: true,
                    });
                }
            };
            let listed = tokio::task::block_in_place(|| {
                runtime.block_on(messages.list(&team.id, 0))
            })
            .unwrap_or_default();
            Ok(ToolResult {
                content: render_team_result(&team, &listed),
                is_error: team.status != "completed",
            })
        }),
    }
}

fn parse_delegate_input(arguments: &Value) -> Result<CreateTeamRunInput, String> {
    serde_json::from_value::<CreateTeamRunInput>(arguments.clone()).map_err(|error| {
        format!("Invalid tool arguments: {error}")
    })
}

fn render_team_result(team: &TeamRun, messages: &[TeamMessage]) -> String {
    let results = team.tasks.iter().map(|task| {
        let body = task
            .output
            .as_deref()
            .or(task.error.as_deref())
            .unwrap_or("[No result]");
        format!(
            "### {} · {}\n{}",
            task.agent_label,
            task.status,
            preview(body, 4_000)
        )
    });
    let parent_messages: Vec<&TeamMessage> = messages
        .iter()
        .filter(|message| message.recipient_id == "parent" || message.recipient_id == "*")
        .collect();
    let completed = team
        .tasks
        .iter()
        .filter(|task| task.status == "completed")
        .count();
    let mut sections = vec![format!(
        "Team {}: {completed}/{} completed",
        team.status,
        team.tasks.len()
    )];
    sections.extend(results);
    if !parent_messages.is_empty() {
        sections.push(format!(
            "## Team messages\n{}",
            render_messages(&parent_messages)
        ));
    }
    sections.join("\n\n")
}

fn render_messages(messages: &[&TeamMessage]) -> String {
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
        format!(
            "{clipped}\n[truncated; chars={}]",
            text.chars().count()
        )
    }
}
