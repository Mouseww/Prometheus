use std::collections::HashMap;

use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    active_run_hub::{ActiveRunHandle, ActiveRunHub},
    approval_coordinator::{ApprovalCoordinator, ApprovalDecision},
    config_repository::ConfigRepository,
    error::AppError,
    event_hub::EventHub,
    git_worktree_manager::GitWorktreeManager,
    mcp_client::load_mcp_tools,
    mcp_repository::McpRepository,
    models::{
        Actor, AgentRunResult, AppendEventInput, ChatMessage, ProviderUsage, SessionEvent,
    },
    providers,
    run_stream_hub::RunStreamHub,
    session_repository::SessionRepository,
    skill_service::SkillService,
    team_message_service::TeamMessageService,
    team_run_repository::TeamRunRepository,
    team_run_service::TeamRunService,
    tool_permission_policy::{PermissionDecision, evaluate_permission},
    tools::{
        AgentTool, SharedTools, ToolApprovalPolicy, ToolCall, ToolResult, compact_tool_arguments,
        delegate_team_tools::delegate_team_tool,
        skill_tools::skill_tools,
        team_message_tools::{TeamMessageToolContext, team_message_tools},
    },
};

#[derive(Clone, Debug)]
pub struct SubagentMetadata {
    pub team_run_id: String,
    pub team_task_id: String,
    pub workspace_mode: String,
    pub workspace_root: Option<String>,
    pub allowed_paths: Vec<String>,
}

const MAX_TURNS: u32 = 8;
const TOOL_OUTPUT_LIMIT: usize = 8_000;

#[derive(Clone)]
pub struct AgentRunService {
    sessions: SessionRepository,
    configuration: ConfigRepository,
    event_hub: EventHub,
    tools: SharedTools,
    approvals: ApprovalCoordinator,
    run_streams: RunStreamHub,
    active_runs: ActiveRunHub,
    team_messages: TeamMessageService,
    teams: TeamRunRepository,
    worktrees: Option<GitWorktreeManager>,
    skills: SkillService,
    mcp: McpRepository,
}

impl AgentRunService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        sessions: SessionRepository,
        configuration: ConfigRepository,
        event_hub: EventHub,
        tools: SharedTools,
        approvals: ApprovalCoordinator,
        run_streams: RunStreamHub,
        active_runs: ActiveRunHub,
        team_messages: TeamMessageService,
        teams: TeamRunRepository,
        worktrees: Option<GitWorktreeManager>,
        skills: SkillService,
        mcp: McpRepository,
    ) -> Self {
        Self {
            sessions,
            configuration,
            event_hub,
            tools,
            approvals,
            run_streams,
            active_runs,
            team_messages,
            teams,
            worktrees,
            skills,
            mcp,
        }
    }

    pub async fn run(&self, session_id: &str, agent_id: &str) -> Result<AgentRunResult, AppError> {
        if self.sessions.get(session_id).await?.is_none() {
            return Err(AppError::configuration_not_found("Session not found"));
        }

        let messages = build_history(&self.sessions.list_events(session_id, 0).await?);
        if messages.is_empty() || messages.last().map(|item| item.role.as_str()) != Some("user") {
            return Err(AppError::configuration_not_found(
                "A user message is required before starting an agent run",
            ));
        }
        self.execute(session_id, agent_id, messages, None).await
    }

    pub async fn run_task(
        &self,
        session_id: &str,
        agent_id: &str,
        task: &str,
        metadata: SubagentMetadata,
    ) -> Result<AgentRunResult, AppError> {
        if self.sessions.get(session_id).await?.is_none() {
            return Err(AppError::configuration_not_found("Session not found"));
        }
        let prompt = task.trim();
        if prompt.is_empty() || prompt.chars().count() > 12_000 {
            return Err(AppError::invalid_request("Subagent task is invalid"));
        }
        self.execute(
            session_id,
            agent_id,
            vec![ChatMessage::user(prompt)],
            Some(metadata),
        )
        .await
    }

    async fn execute(
        &self,
        session_id: &str,
        agent_id: &str,
        mut messages: Vec<ChatMessage>,
        subagent: Option<SubagentMetadata>,
    ) -> Result<AgentRunResult, AppError> {
        let agent = self
            .configuration
            .get_agent(agent_id)
            .await?
            .ok_or_else(|| AppError::configuration_not_found("Agent not found"))?;
        let provider = self
            .configuration
            .get_provider_runtime(&agent.provider_id)
            .await?
            .ok_or_else(|| AppError::configuration_not_found("Provider not found"))?;

        let run_id = Uuid::new_v4().to_string();
        let run_handle = self.active_runs.begin(session_id, &run_id)?;
        let actor = Actor {
            kind: "agent".to_owned(),
            id: agent.id.clone(),
            label: agent.name.clone(),
        };

        let mut started_payload = json!({
            "runId": run_id,
            "agentId": agent.id,
            "providerId": provider.id,
            "model": agent.model,
        });
        if let Some(meta) = &subagent {
            started_payload["isSubagent"] = json!(true);
            started_payload["teamRunId"] = json!(meta.team_run_id);
            started_payload["teamTaskId"] = json!(meta.team_task_id);
            started_payload["workspaceMode"] = json!(meta.workspace_mode);
            started_payload["allowedPaths"] = json!(meta.allowed_paths);
        }

        self.commit(
            session_id,
            AppendEventInput {
                event_id: Uuid::new_v4().to_string(),
                event_type: "agent.run.started".to_owned(),
                actor: actor.clone(),
                payload: started_payload,
            },
        )
        .await?;

        let skill_toolset: Option<Vec<AgentTool>> = {
            let listed = self.skills.list().unwrap_or_default();
            if listed.is_empty() {
                None
            } else {
                Some(skill_tools(self.skills.clone()))
            }
        };
        let mut mcp_diagnostics: Vec<String> = Vec::new();
        let mcp_toolset: Option<Vec<AgentTool>> = {
            let servers = self.mcp.list_enabled().await.unwrap_or_default();
            if servers.is_empty() {
                None
            } else {
                let loaded = load_mcp_tools(&servers).await;
                mcp_diagnostics = loaded.diagnostics;
                if loaded.tools.is_empty() {
                    None
                } else {
                    Some(loaded.tools)
                }
            }
        };
        for notice in &mcp_diagnostics {
            self.commit(
                session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "system.notice".to_owned(),
                    actor: Actor {
                        kind: "system".to_owned(),
                        id: "mcp".to_owned(),
                        label: "MCP".to_owned(),
                    },
                    payload: json!({ "message": notice }),
                },
            )
            .await?;
        }
        let system_prompt = {
            let mut prompt = agent.system_prompt.clone();
            if let Ok(section) = self.skills.prompt_section()
                && !section.is_empty()
            {
                prompt = format!("{prompt}\n\n{section}");
            }
            prompt
        };

        let message_tools: Option<Vec<AgentTool>> = subagent.as_ref().map(|meta| {
            team_message_tools(
                self.team_messages.clone(),
                TeamMessageToolContext {
                    team_run_id: meta.team_run_id.clone(),
                    agent_id: agent.id.clone(),
                    run_id: run_id.clone(),
                },
            )
        });
        let worktree_tools: Option<Vec<AgentTool>> =
            if let Some(meta) = &subagent {
                if meta.workspace_mode == "worktree" {
                    let root = meta.workspace_root.as_deref().ok_or_else(|| {
                        AppError::invalid_request("Worktree child is missing workspace root")
                    })?;
                    let workspace = crate::workspace_service::WorkspaceService::open(root)?;
                    Some(crate::tools::full_tools(workspace))
                } else {
                    None
                }
            } else {
                None
            };
        let delegate_tools: Option<Vec<AgentTool>> = if subagent.is_none() {
            let agents = self.configuration.list_agents().await?;
            let eligible: Vec<_> = agents
                .into_iter()
                .filter(|item| item.id != agent.id)
                .collect();
            if eligible.is_empty() {
                None
            } else {
                let team_runner = TeamRunService::new(
                    self.sessions.clone(),
                    self.configuration.clone(),
                    self.teams.clone(),
                    self.clone(),
                    self.event_hub.clone(),
                    self.worktrees.clone(),
                );
                Some(vec![delegate_team_tool(
                    team_runner,
                    self.team_messages.clone(),
                    session_id.to_owned(),
                    agent.id.clone(),
                    eligible,
                )])
            }
        } else {
            None
        };
        let selected_tools: Vec<&AgentTool> = if let Some(tools) = worktree_tools.as_ref() {
            let mut selected: Vec<&AgentTool> = tools.iter().collect();
            if let Some(messages) = message_tools.as_ref() {
                selected.extend(messages.iter());
            }
            selected
        } else if subagent.is_some() {
            let mut selected: Vec<&AgentTool> = self
                .tools
                .iter()
                .filter(|tool| {
                    matches!(
                        tool.name.as_str(),
                        "list_directory" | "read_file" | "search_text"
                    )
                })
                .collect();
            if let Some(messages) = message_tools.as_ref() {
                selected.extend(messages.iter());
            }
            selected
        } else {
            let mut selected: Vec<&AgentTool> = self.tools.iter().collect();
            if let Some(delegate) = delegate_tools.as_ref() {
                selected.extend(delegate.iter());
            }
            selected
        };
        let mut owned_extension_tools: Vec<AgentTool> = Vec::new();
        if let Some(skills) = skill_toolset {
            owned_extension_tools.extend(skills);
        }
        if let Some(mcp) = mcp_toolset {
            owned_extension_tools.extend(mcp);
        }
        let mut selected_tools = selected_tools;
        selected_tools.extend(owned_extension_tools.iter());
        let tool_defs = selected_tools
            .iter()
            .map(|tool| tool.definition())
            .collect::<Vec<_>>();
        let tools_by_name = selected_tools
            .iter()
            .map(|tool| (tool.name.clone(), *tool))
            .collect::<HashMap<_, _>>();

        let mut accumulated_usage = ProviderUsage::default();
        let mut last_provider_response_id: Option<String> = None;

        for turn in 1..=MAX_TURNS {
            if run_handle.is_cancelled() {
                self.run_streams.clear(session_id, &run_id).await;
                return self.cancel_run(session_id, &actor, &run_id).await;
            }
            self.run_streams
                .start_turn(session_id, &run_id, &agent.id, &agent.name, turn)
                .await;

            let (delta_tx, mut delta_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            let stream_hub = self.run_streams.clone();
            let stream_session = session_id.to_owned();
            let stream_run = run_id.clone();
            let stream_turn = turn;
            let publisher = tokio::spawn(async move {
                while let Some(delta) = delta_rx.recv().await {
                    stream_hub
                        .append(&stream_session, &stream_run, stream_turn, &delta)
                        .await;
                }
            });

            let response = match providers::generate(
                &provider,
                &agent.model,
                &system_prompt,
                &messages,
                &tool_defs,
                Some(delta_tx),
            )
            .await
            {
                Ok(response) => {
                    let _ = publisher.await;
                    response
                }
                Err(error) => {
                    let _ = publisher.await;
                    self.run_streams.clear(session_id, &run_id).await;
                    return self.fail_run(session_id, &actor, &run_id, &error).await;
                }
            };

            merge_usage(&mut accumulated_usage, response.usage.as_ref());
            if let Some(id) = &response.provider_response_id {
                last_provider_response_id = Some(id.clone());
            }

            if response.tool_calls.is_empty() {
                let text = response.text.trim();
                if text.is_empty() {
                    self.run_streams.clear(session_id, &run_id).await;
                    let error = AppError::provider_request_failed(
                        "Provider returned neither text nor tool calls",
                    );
                    return self.fail_run(session_id, &actor, &run_id, &error).await;
                }
                let result = self
                    .complete_run(
                        session_id,
                        &actor,
                        &run_id,
                        text,
                        last_provider_response_id.as_deref(),
                        &accumulated_usage,
                        subagent.as_ref(),
                    )
                    .await;
                self.run_streams.clear(session_id, &run_id).await;
                return result;
            }

            // Tool-call turns still clear the draft stream after the provider response.
            self.run_streams.clear(session_id, &run_id).await;

            messages.push(ChatMessage::assistant_with_tools(
                response.text.clone(),
                response.tool_calls.clone(),
            ));

            for tool_call in response.tool_calls {
                let tool = tools_by_name.get(tool_call.name.as_str()).copied();
                let summarized = tool
                    .map(|item| item.summarize(&tool_call.arguments))
                    .unwrap_or_else(|| compact_tool_arguments(&tool_call.arguments));

                self.commit(
                    session_id,
                    AppendEventInput {
                        event_id: Uuid::new_v4().to_string(),
                        event_type: "tool.call.started".to_owned(),
                        actor: Actor {
                            kind: "tool".into(),
                            id: tool_call.name.clone(),
                            label: tool_call.name.clone(),
                        },
                        payload: json!({
                            "runId": run_id,
                            "toolCallId": tool_call.id,
                            "toolName": tool_call.name,
                            "arguments": summarized,
                        }),
                    },
                )
                .await?;

                let result = self
                    .execute_tool(session_id, &run_id, tool, &tool_call, &run_handle)
                    .await;

                if run_handle.is_cancelled() {
                    self.run_streams.clear(session_id, &run_id).await;
                    return self.cancel_run(session_id, &actor, &run_id).await;
                }

                let output = truncate_output(&result.content, TOOL_OUTPUT_LIMIT);
                self.commit(
                    session_id,
                    AppendEventInput {
                        event_id: Uuid::new_v4().to_string(),
                        event_type: "tool.call.completed".to_owned(),
                        actor: Actor {
                            kind: "tool".into(),
                            id: tool_call.name.clone(),
                            label: tool_call.name.clone(),
                        },
                        payload: json!({
                            "runId": run_id,
                            "toolCallId": tool_call.id,
                            "toolName": tool_call.name,
                            "output": output.content,
                            "outputTruncated": output.truncated,
                            "isError": result.is_error,
                        }),
                    },
                )
                .await?;

                messages.push(ChatMessage::tool(
                    tool_call.id,
                    tool_call.name,
                    result.content,
                    result.is_error,
                ));
            }
        }

        let error = AppError::provider_request_failed(format!(
            "Agent loop exceeded {MAX_TURNS} provider turns"
        ));
        self.fail_run(session_id, &actor, &run_id, &error).await
    }

    async fn execute_tool(
        &self,
        session_id: &str,
        run_id: &str,
        tool: Option<&AgentTool>,
        tool_call: &ToolCall,
        run_handle: &ActiveRunHandle,
    ) -> ToolResult {
        let Some(tool) = tool else {
            return ToolResult {
                content: format!("Unknown tool: {}", tool_call.name),
                is_error: true,
            };
        };

        if tool.approval == ToolApprovalPolicy::Always {
            match self
                .authorize_tool(session_id, run_id, tool, tool_call, run_handle)
                .await
            {
                Ok(AuthorizationOutcome::Approved) => {}
                Ok(AuthorizationOutcome::Denied { message }) => {
                    return ToolResult {
                        content: message,
                        is_error: true,
                    };
                }
                Err(message) => {
                    return ToolResult {
                        content: message,
                        is_error: true,
                    };
                }
            }
        }

        match (tool.execute)(tool_call) {
            Ok(result) => result,
            Err(error) => ToolResult {
                content: error.to_string().chars().take(2_000).collect(),
                is_error: true,
            },
        }
    }

    async fn authorize_tool(
        &self,
        session_id: &str,
        run_id: &str,
        tool: &AgentTool,
        tool_call: &ToolCall,
        run_handle: &ActiveRunHandle,
    ) -> Result<AuthorizationOutcome, String> {
        if let Some(permission_target) = &tool.permission_target {
            let target = permission_target(&tool_call.arguments);
            let rules = self
                .configuration
                .list_permission_rules()
                .await
                .map_err(|error| error.to_string())?;
            let evaluation = evaluate_permission(&rules, &tool.name, &target);
            if !evaluation.rules.is_empty() {
                let summarized = tool.summarize(&tool_call.arguments);
                let _ = self
                    .commit(
                        session_id,
                        AppendEventInput {
                            event_id: Uuid::new_v4().to_string(),
                            event_type: "permission.rule.matched".to_owned(),
                            actor: Actor {
                                kind: "system".into(),
                                id: "permission-policy".into(),
                                label: "Permission Policy".into(),
                            },
                            payload: json!({
                                "runId": run_id,
                                "toolCallId": tool_call.id,
                                "toolName": tool_call.name,
                                "effect": evaluation.decision.as_str(),
                                "arguments": summarized,
                                "rules": evaluation.rules.iter().map(|rule| json!({
                                    "id": rule.id,
                                    "pattern": rule.pattern,
                                })).collect::<Vec<_>>(),
                            }),
                        },
                    )
                    .await;
            }
            match evaluation.decision {
                PermissionDecision::Allow => {
                    return Ok(AuthorizationOutcome::Approved);
                }
                PermissionDecision::Deny => {
                    return Ok(AuthorizationOutcome::Denied {
                        message: "Tool execution denied by permission rule".into(),
                    });
                }
                PermissionDecision::Ask => {}
            }
        }

        let (approval_id, receiver) = self
            .approvals
            .create(session_id)
            .map_err(|error| error.to_string())?;
        let summarized = tool.summarize(&tool_call.arguments);
        let _ = self
            .commit(
                session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "approval.requested".to_owned(),
                    actor: Actor {
                        kind: "system".into(),
                        id: "approval-gate".into(),
                        label: "Approval Gate".into(),
                    },
                    payload: json!({
                        "approvalId": approval_id,
                        "runId": run_id,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "arguments": summarized,
                    }),
                },
            )
            .await;

        let mut receiver = receiver;
        let decision = loop {
            if run_handle.is_cancelled() {
                let _ = self.approvals.deny_all_for_session(session_id);
                break ApprovalDecision::Denied;
            }
            match tokio::time::timeout(std::time::Duration::from_millis(200), &mut receiver).await {
                Ok(result) => break result.unwrap_or(ApprovalDecision::Denied),
                Err(_) => continue,
            }
        };
        let cancelled = run_handle.is_cancelled();
        // Prefer a single durable writer: resolve/cancel endpoints persist approval.resolved.
        // Only emit here when the waiter ends without an external resolution event (e.g. run cancel race).
        let already_resolved = self
            .sessions
            .list_events(session_id, 0)
            .await
            .ok()
            .map(|events| {
                events.iter().any(|event| {
                    event.event_type == "approval.resolved"
                        && event
                            .payload
                            .get("approvalId")
                            .and_then(|value| value.as_str())
                            == Some(approval_id.as_str())
                })
            })
            .unwrap_or(false);
        if !already_resolved {
            let _ = self
                .commit(
                    session_id,
                    AppendEventInput {
                        event_id: Uuid::new_v4().to_string(),
                        event_type: "approval.resolved".to_owned(),
                        actor: Actor {
                            kind: "system".into(),
                            id: "approval-gate".into(),
                            label: "Approval Gate".into(),
                        },
                        payload: json!({
                            "approvalId": approval_id,
                            "runId": run_id,
                            "toolCallId": tool_call.id,
                            "toolName": tool_call.name,
                            "decision": decision.as_str(),
                            "cancelled": cancelled,
                        }),
                    },
                )
                .await;
        }

        if cancelled {
            return Ok(AuthorizationOutcome::Denied {
                message: "Tool execution cancelled because the agent run was stopped".into(),
            });
        }

        Ok(match decision {
            ApprovalDecision::Approved => AuthorizationOutcome::Approved,
            ApprovalDecision::Denied => AuthorizationOutcome::Denied {
                message: "Tool execution denied by user".into(),
            },
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn complete_run(
        &self,
        session_id: &str,
        actor: &Actor,
        run_id: &str,
        text: &str,
        provider_response_id: Option<&str>,
        usage: &ProviderUsage,
        subagent: Option<&SubagentMetadata>,
    ) -> Result<AgentRunResult, AppError> {
        let mut reply_payload = json!({
            "text": text,
            "runId": run_id,
        });
        let mut completed = completed_payload(run_id, provider_response_id, usage);
        if let Some(meta) = subagent {
            reply_payload["isSubagent"] = json!(true);
            reply_payload["teamRunId"] = json!(meta.team_run_id);
            reply_payload["teamTaskId"] = json!(meta.team_task_id);
            completed["isSubagent"] = json!(true);
            completed["teamRunId"] = json!(meta.team_run_id);
            completed["teamTaskId"] = json!(meta.team_task_id);
        }
        let reply_event = self
            .commit(
                session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "message.agent".to_owned(),
                    actor: actor.clone(),
                    payload: reply_payload,
                },
            )
            .await?;
        let completed_event = self
            .commit(
                session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "agent.run.completed".to_owned(),
                    actor: actor.clone(),
                    payload: completed,
                },
            )
            .await?;
        Ok(AgentRunResult {
            run_id: run_id.to_owned(),
            reply_event,
            completed_event,
        })
    }

    async fn cancel_run(
        &self,
        session_id: &str,
        actor: &Actor,
        run_id: &str,
    ) -> Result<AgentRunResult, AppError> {
        self
            .commit(
                session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "agent.run.cancelled".to_owned(),
                    actor: actor.clone(),
                    payload: json!({
                        "runId": run_id,
                        "message": "Cancelled by user",
                    }),
                },
            )
            .await?;
        Err(AppError::invalid_request("Cancelled by user"))
    }

    async fn fail_run(
        &self,
        session_id: &str,
        actor: &Actor,
        run_id: &str,
        error: &AppError,
    ) -> Result<AgentRunResult, AppError> {
        let message = sanitize_provider_error(error);
        let _ = self
            .commit(
                session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "agent.run.failed".to_owned(),
                    actor: actor.clone(),
                    payload: json!({
                        "runId": run_id,
                        "message": message,
                    }),
                },
            )
            .await;
        Err(AppError::provider_request_failed(message))
    }

    async fn commit(
        &self,
        session_id: &str,
        input: AppendEventInput,
    ) -> Result<SessionEvent, AppError> {
        let event = self.sessions.append_event(session_id, input).await?;
        self.event_hub.publish(event.clone()).await;
        Ok(event)
    }
}

enum AuthorizationOutcome {
    Approved,
    Denied { message: String },
}

fn build_history(events: &[SessionEvent]) -> Vec<ChatMessage> {
    events
        .iter()
        .filter_map(|event| {
            if event.event_type != "message.user" && event.event_type != "message.agent" {
                return None;
            }
            if event.payload.get("isSubagent").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let text = event
                .payload
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            Some(if event.event_type == "message.user" {
                ChatMessage::user(text)
            } else {
                ChatMessage::assistant(text)
            })
        })
        .collect()
}

fn completed_payload(
    run_id: &str,
    provider_response_id: Option<&str>,
    usage: &ProviderUsage,
) -> Value {
    let mut payload = json!({ "runId": run_id });
    if let Some(provider_response_id) = provider_response_id {
        payload["providerResponseId"] = json!(provider_response_id);
    }
    if let Some(usage) = compact_usage(Some(usage)) {
        payload["usage"] = usage;
    }
    payload
}

fn compact_usage(usage: Option<&ProviderUsage>) -> Option<Value> {
    let usage = usage?;
    let mut map = serde_json::Map::new();
    if let Some(value) = usage.input_tokens {
        map.insert("inputTokens".to_owned(), json!(value));
    }
    if let Some(value) = usage.output_tokens {
        map.insert("outputTokens".to_owned(), json!(value));
    }
    if let Some(value) = usage.total_tokens {
        map.insert("totalTokens".to_owned(), json!(value));
    }
    if map.is_empty() {
        None
    } else {
        Some(Value::Object(map))
    }
}

fn merge_usage(target: &mut ProviderUsage, source: Option<&ProviderUsage>) {
    let Some(source) = source else {
        return;
    };
    if let Some(value) = source.input_tokens {
        target.input_tokens = Some(target.input_tokens.unwrap_or(0) + value);
    }
    if let Some(value) = source.output_tokens {
        target.output_tokens = Some(target.output_tokens.unwrap_or(0) + value);
    }
    if let Some(value) = source.total_tokens {
        target.total_tokens = Some(target.total_tokens.unwrap_or(0) + value);
    }
}

struct TruncatedOutput {
    content: String,
    truncated: bool,
}

fn truncate_output(content: &str, max: usize) -> TruncatedOutput {
    if content.len() <= max {
        TruncatedOutput {
            content: content.to_owned(),
            truncated: false,
        }
    } else {
        TruncatedOutput {
            content: content.chars().take(max).collect(),
            truncated: true,
        }
    }
}

fn sanitize_provider_error(error: &AppError) -> String {
    let raw = match error {
        AppError::ProviderRequestFailed(message) => message.clone(),
        other => other.to_string(),
    };
    redact_secrets(&raw).chars().take(500).collect()
}

fn redact_secrets(input: &str) -> String {
    let keys = ["api_key", "api-key", "api key", "apikey", "authorization"];
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0usize;
    while index < bytes.len() {
        let remaining = &input[index..];
        let remaining_lower = remaining.to_ascii_lowercase();
        let mut matched: Option<(&str, usize)> = None;
        for key in keys {
            if remaining_lower.starts_with(key) {
                matched = Some((key, key.len()));
                break;
            }
        }
        let Some((key, key_len)) = matched else {
            output.push(bytes[index] as char);
            index += 1;
            continue;
        };

        let mut cursor = index + key_len;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || (bytes[cursor] != b':' && bytes[cursor] != b'=') {
            output.push_str(&input[index..index + key_len]);
            index += key_len;
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        while cursor < bytes.len() && !bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        output.push_str(key);
        output.push_str("=[redacted]");
        index = cursor;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_skips_subagent_and_non_message_events() {
        let events = vec![SessionEvent {
            sequence: 1,
            event_id: "1".into(),
            session_id: "s".into(),
            event_type: "message.user".into(),
            actor: Actor {
                kind: "user".into(),
                id: "u".into(),
                label: "You".into(),
            },
            payload: json!({"text": " parent"}),
            created_at: "t".into(),
        }];
        let history = build_history(&events);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].content, "parent");
    }

    #[test]
    fn sanitize_redacts_api_key_values() {
        let error = AppError::provider_request_failed("boom api_key=sk-secret remaining");
        let message = sanitize_provider_error(&error);
        assert!(message.contains("api_key=[redacted]"));
        assert!(!message.contains("sk-secret"));
    }
}
