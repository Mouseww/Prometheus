use std::path::PathBuf;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, patch, post},
};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};
use uuid::Uuid;

use crate::{
    agent_run_service::AgentRunService,
    approval_coordinator::ApprovalDecision,
    error::AppError,
    models::{
        AgentProfile, AgentRunResult, AppendEventInput, CreateAgentInput, CreateAgentRunInput,
        CreateMcpServerInput, CreatePermissionRuleInput, CreateProviderInput, CreateSessionInput, CreateTeamRunInput, McpServer, SkillSummary, TeamMessage,
        UpdateMcpServerInput,
        PermissionRule, Provider, Session, SessionEvent, TeamRun, UpdateAgentInput,
        UpdateProviderInput,
    },
    state::AppState,
    team_run_service::TeamRunService,
    workspace_service::WorkspaceNode,
    ws::websocket_handler,
};

pub fn build_router(state: AppState) -> Router {
    let web_root = state.config.web_root().map(PathBuf::from);
    let mut router = Router::new()
        .route("/api/health", get(health))
        .route("/api/workspace", get(list_workspace))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route(
            "/api/sessions/{session_id}/events",
            get(list_events).post(append_event),
        )
        .route("/api/providers", get(list_providers).post(create_provider))
        .route("/api/providers/{provider_id}", patch(update_provider))
        .route("/api/agents", get(list_agents).post(create_agent))
        .route("/api/agents/{agent_id}", patch(update_agent))
        .route(
            "/api/permission-rules",
            get(list_permission_rules).post(create_permission_rule),
        )
        .route(
            "/api/permission-rules/{rule_id}",
            delete(delete_permission_rule),
        )
        .route("/api/skills", get(list_skills))
        .route("/api/mcp-servers", get(list_mcp_servers).post(create_mcp_server))
        .route(
            "/api/mcp-servers/{server_id}",
            patch(update_mcp_server).delete(delete_mcp_server),
        )
        .route("/api/sessions/{session_id}/runs", post(create_agent_run))
        .route(
            "/api/sessions/{session_id}/approvals/{approval_id}/resolution",
            post(resolve_approval),
        )
        .route(
            "/api/sessions/{session_id}/team-runs",
            get(list_team_runs).post(create_team_run),
        )
        .route("/api/team-runs/{team_run_id}", get(get_team_run))
        .route(
            "/api/team-runs/{team_run_id}/tasks/{team_task_id}/apply",
            post(apply_team_task_changes),
        )
        .route(
            "/api/team-runs/{team_run_id}/tasks/{team_task_id}/discard",
            post(discard_team_task_changes),
        )
        .route(
            "/api/team-runs/{team_run_id}/messages",
            get(list_team_messages),
        )
        .route("/ws", get(websocket_handler))
        .with_state(state)
        .layer(CorsLayer::permissive());

    if let Some(web_root) = web_root.filter(|path| path.is_dir()) {
        let index = web_root.join("index.html");
        let static_files = ServeDir::new(web_root).not_found_service(ServeFile::new(index));
        router = router.fallback_service(static_files);
    }

    router
}


async fn list_team_runs(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<TeamRunsResponse>, AppError> {
    let service = team_service(&state);
    Ok(Json(TeamRunsResponse {
        teams: service.list_for_session(&session_id).await?,
    }))
}

async fn create_team_run(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(input): Json<CreateTeamRunInput>,
) -> Result<(StatusCode, Json<TeamRunResponse>), AppError> {
    let service = team_service(&state);
    let team = service.launch(&session_id, input).await?;
    Ok((StatusCode::ACCEPTED, Json(TeamRunResponse { team })))
}

async fn get_team_run(
    State(state): State<AppState>,
    Path(team_run_id): Path<String>,
) -> Result<Json<TeamRunResponse>, AppError> {
    if Uuid::parse_str(&team_run_id).is_err() {
        return Err(AppError::invalid_request("teamRunId must be a UUID"));
    }
    let service = team_service(&state);
    Ok(Json(TeamRunResponse {
        team: service.get(&team_run_id).await?,
    }))
}

fn team_service(state: &AppState) -> TeamRunService {
    let agent_runs = AgentRunService::new(
        state.sessions.clone(),
        state.configuration.clone(),
        state.event_hub.clone(),
        state.tools.clone(),
        state.approvals.clone(),
        state.run_streams.clone(),
        state.team_messages.clone(),
        state.teams.clone(),
        state.worktrees.clone(),
        state.skills.clone(),
        state.mcp.clone(),
    );
    TeamRunService::new(
        state.sessions.clone(),
        state.configuration.clone(),
        state.teams.clone(),
        agent_runs,
        state.event_hub.clone(),
        state.worktrees.clone(),
    )
}

async fn apply_team_task_changes(
    State(state): State<AppState>,
    Path((team_run_id, team_task_id)): Path<(String, String)>,
) -> Result<Json<TeamRunResponse>, AppError> {
    if Uuid::parse_str(&team_run_id).is_err() {
        return Err(AppError::invalid_request("teamRunId must be a UUID"));
    }
    if Uuid::parse_str(&team_task_id).is_err() {
        return Err(AppError::invalid_request("teamTaskId must be a UUID"));
    }
    let service = team_service(&state);
    Ok(Json(TeamRunResponse {
        team: service
            .apply_task_changes(&team_run_id, &team_task_id)
            .await?,
    }))
}

async fn discard_team_task_changes(
    State(state): State<AppState>,
    Path((team_run_id, team_task_id)): Path<(String, String)>,
) -> Result<Json<TeamRunResponse>, AppError> {
    if Uuid::parse_str(&team_run_id).is_err() {
        return Err(AppError::invalid_request("teamRunId must be a UUID"));
    }
    if Uuid::parse_str(&team_task_id).is_err() {
        return Err(AppError::invalid_request("teamTaskId must be a UUID"));
    }
    let service = team_service(&state);
    Ok(Json(TeamRunResponse {
        team: service
            .discard_task_changes(&team_run_id, &team_task_id)
            .await?,
    }))
}


async fn list_team_messages(
    State(state): State<AppState>,
    Path(team_run_id): Path<String>,
    Query(query): Query<TeamMessageQuery>,
) -> Result<Json<TeamMessagesResponse>, AppError> {
    if Uuid::parse_str(&team_run_id).is_err() {
        return Err(AppError::invalid_request("teamRunId must be a UUID"));
    }
    if state.teams.get(&team_run_id).await?.is_none() {
        return Err(AppError::team_run_not_found("Team run not found"));
    }
    Ok(Json(TeamMessagesResponse {
        messages: state
            .team_messages
            .list(&team_run_id, query.after_sequence)
            .await?,
    }))
}


async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        workspace: state.config.workspace_name(),
        timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

async fn list_workspace(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<WorkspaceResponse>, AppError> {
    Ok(Json(WorkspaceResponse {
        root_name: state.workspace.root_name().to_owned(),
        path: query.path.clone(),
        nodes: state.workspace.list(&query.path)?,
    }))
}

async fn list_sessions(State(state): State<AppState>) -> Result<Json<SessionsResponse>, AppError> {
    Ok(Json(SessionsResponse {
        sessions: state.sessions.list().await?,
    }))
}

async fn create_session(
    State(state): State<AppState>,
    Json(input): Json<CreateSessionInput>,
) -> Result<(StatusCode, Json<SessionResponse>), AppError> {
    Ok((
        StatusCode::CREATED,
        Json(SessionResponse {
            session: state.sessions.create(&input.title).await?,
        }),
    ))
}

async fn list_events(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<EventQuery>,
) -> Result<Json<EventsResponse>, AppError> {
    Ok(Json(EventsResponse {
        events: state
            .sessions
            .list_events(&session_id, query.after_sequence)
            .await?,
    }))
}

async fn append_event(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(input): Json<AppendEventInput>,
) -> Result<(StatusCode, Json<EventResponse>), AppError> {
    let event = state.sessions.append_event(&session_id, input).await?;
    state.event_hub.publish(event.clone()).await;
    Ok((StatusCode::CREATED, Json(EventResponse { event })))
}

async fn create_agent_run(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(input): Json<CreateAgentRunInput>,
) -> Result<(StatusCode, Json<AgentRunResponse>), AppError> {
    if Uuid::parse_str(&input.agent_id).is_err() {
        return Err(AppError::invalid_request("agentId must be a UUID"));
    }
    let service = AgentRunService::new(
        state.sessions.clone(),
        state.configuration.clone(),
        state.event_hub.clone(),
        state.tools.clone(),
        state.approvals.clone(),
        state.run_streams.clone(),
        state.team_messages.clone(),
        state.teams.clone(),
        state.worktrees.clone(),
        state.skills.clone(),
        state.mcp.clone(),
    );
    let run = service.run(&session_id, &input.agent_id).await?;
    Ok((StatusCode::CREATED, Json(AgentRunResponse { run })))
}

async fn resolve_approval(
    State(state): State<AppState>,
    Path((session_id, approval_id)): Path<(String, String)>,
    Json(input): Json<ResolveApprovalInput>,
) -> Result<Json<ApprovalResponse>, AppError> {
    if state.sessions.get(&session_id).await?.is_none() {
        return Err(AppError::session_not_found(&session_id));
    }
    if Uuid::parse_str(&approval_id).is_err() {
        return Err(AppError::invalid_request("approvalId must be a UUID"));
    }
    let decision = ApprovalDecision::parse(&input.decision)?;
    let approval = state
        .approvals
        .resolve(&session_id, &approval_id, decision)?;
    Ok(Json(ApprovalResponse { approval }))
}


async fn list_skills(State(state): State<AppState>) -> Result<Json<SkillsResponse>, AppError> {
    Ok(Json(SkillsResponse {
        skills: state.skills.list()?,
    }))
}

async fn list_mcp_servers(
    State(state): State<AppState>,
) -> Result<Json<McpServersResponse>, AppError> {
    Ok(Json(McpServersResponse {
        servers: state.mcp.list().await?,
    }))
}

async fn create_mcp_server(
    State(state): State<AppState>,
    Json(input): Json<CreateMcpServerInput>,
) -> Result<(StatusCode, Json<McpServerResponse>), AppError> {
    let server = state.mcp.create(input).await?;
    Ok((StatusCode::CREATED, Json(McpServerResponse { server })))
}

async fn update_mcp_server(
    State(state): State<AppState>,
    Path(server_id): Path<String>,
    Json(input): Json<UpdateMcpServerInput>,
) -> Result<Json<McpServerResponse>, AppError> {
    if Uuid::parse_str(&server_id).is_err() {
        return Err(AppError::invalid_request("serverId must be a UUID"));
    }
    let server = state.mcp.update(&server_id, input).await?;
    Ok(Json(McpServerResponse { server }))
}

async fn delete_mcp_server(
    State(state): State<AppState>,
    Path(server_id): Path<String>,
) -> Result<StatusCode, AppError> {
    if Uuid::parse_str(&server_id).is_err() {
        return Err(AppError::invalid_request("serverId must be a UUID"));
    }
    state.mcp.delete(&server_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_providers(
    State(state): State<AppState>,
) -> Result<Json<ProvidersResponse>, AppError> {
    Ok(Json(ProvidersResponse {
        providers: state.configuration.list_providers().await?,
    }))
}

async fn create_provider(
    State(state): State<AppState>,
    Json(input): Json<CreateProviderInput>,
) -> Result<(StatusCode, Json<ProviderResponse>), AppError> {
    Ok((
        StatusCode::CREATED,
        Json(ProviderResponse {
            provider: state.configuration.create_provider(input).await?,
        }),
    ))
}

async fn update_provider(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
    Json(input): Json<UpdateProviderInput>,
) -> Result<Json<ProviderResponse>, AppError> {
    Ok(Json(ProviderResponse {
        provider: state
            .configuration
            .update_provider(&provider_id, input)
            .await?,
    }))
}

async fn list_agents(State(state): State<AppState>) -> Result<Json<AgentsResponse>, AppError> {
    Ok(Json(AgentsResponse {
        agents: state.configuration.list_agents().await?,
    }))
}

async fn create_agent(
    State(state): State<AppState>,
    Json(input): Json<CreateAgentInput>,
) -> Result<(StatusCode, Json<AgentResponse>), AppError> {
    Ok((
        StatusCode::CREATED,
        Json(AgentResponse {
            agent: state.configuration.create_agent(input).await?,
        }),
    ))
}

async fn update_agent(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    Json(input): Json<UpdateAgentInput>,
) -> Result<Json<AgentResponse>, AppError> {
    Ok(Json(AgentResponse {
        agent: state.configuration.update_agent(&agent_id, input).await?,
    }))
}

async fn list_permission_rules(
    State(state): State<AppState>,
) -> Result<Json<PermissionRulesResponse>, AppError> {
    Ok(Json(PermissionRulesResponse {
        rules: state.configuration.list_permission_rules().await?,
    }))
}

async fn create_permission_rule(
    State(state): State<AppState>,
    Json(input): Json<CreatePermissionRuleInput>,
) -> Result<(StatusCode, Json<PermissionRuleResponse>), AppError> {
    Ok((
        StatusCode::CREATED,
        Json(PermissionRuleResponse {
            rule: state.configuration.create_permission_rule(input).await?,
        }),
    ))
}

async fn delete_permission_rule(
    State(state): State<AppState>,
    Path(rule_id): Path<String>,
) -> Result<StatusCode, AppError> {
    if !state.configuration.delete_permission_rule(&rule_id).await? {
        return Err(AppError::permission_rule_not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventQuery {
    #[serde(default)]
    after_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamMessageQuery {
    #[serde(default)]
    after_sequence: i64,
}

#[derive(Serialize)]
struct TeamMessagesResponse {
    messages: Vec<TeamMessage>,
}

#[derive(Deserialize)]
struct WorkspaceQuery {
    #[serde(default)]
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    workspace: String,
    timestamp: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceResponse {
    root_name: String,
    path: String,
    nodes: Vec<WorkspaceNode>,
}

#[derive(Serialize)]
struct SessionsResponse {
    sessions: Vec<Session>,
}

#[derive(Serialize)]
struct SessionResponse {
    session: Session,
}

#[derive(Serialize)]
struct EventsResponse {
    events: Vec<SessionEvent>,
}

#[derive(Serialize)]
struct EventResponse {
    event: SessionEvent,
}

#[derive(Serialize)]
struct ProvidersResponse {
    providers: Vec<Provider>,
}

#[derive(Serialize)]
struct ProviderResponse {
    provider: Provider,
}

#[derive(Serialize)]
struct AgentsResponse {
    agents: Vec<AgentProfile>,
}

#[derive(Serialize)]
struct AgentResponse {
    agent: AgentProfile,
}

#[derive(Serialize)]
struct PermissionRulesResponse {
    rules: Vec<PermissionRule>,
}

#[derive(Serialize)]
struct PermissionRuleResponse {
    rule: PermissionRule,
}

#[derive(Serialize)]
struct AgentRunResponse {
    run: AgentRunResult,
}



#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveApprovalInput {
    decision: String,
}

#[derive(Serialize)]
struct TeamRunsResponse {
    teams: Vec<TeamRun>,
}

#[derive(Serialize)]
struct TeamRunResponse {
    team: TeamRun,
}

#[derive(Serialize)]
struct ApprovalResponse {
    approval: crate::approval_coordinator::ApprovalResolution,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillsResponse {
    skills: Vec<SkillSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServersResponse {
    servers: Vec<McpServer>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServerResponse {
    server: McpServer,
}
