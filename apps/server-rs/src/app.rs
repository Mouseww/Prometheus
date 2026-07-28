use std::path::PathBuf;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware,
    routing::{delete, get, patch, post},
};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    services::{ServeDir, ServeFile},
};
use uuid::Uuid;

/// REST 与 WebSocket envelope 的协议版本。字段语义发生不兼容变更时递增。
pub const PROTOCOL_VERSION: u32 = 1;

use crate::{
    agent_run_service::AgentRunService,
    approval_coordinator::{ApprovalDecision, ApprovalResolution},
    auth::auth_middleware,
    error::AppError,
    extension_catalog::ExtensionCatalogService,
    models::{
        Actor, AgentProfile, AgentRunResult, AppendEventInput, CreateAgentInput, CreateAgentRunInput,
        CreateMcpServerInput, CreatePermissionRuleInput, CreateProviderInput, CreateSessionInput, CreateTeamRunInput,
        ExtensionCatalogEntry, ExtensionInstallResult, ExtensionStore, InstallExtensionInput,
        InstallGithubSkillInput, McpServer, SkillSummary, TeamMessage, UpdateMcpServerInput,
        PermissionRule, Provider, Session, SessionEvent, TeamRun, UpdateAgentInput,
        UpdateProviderInput,
    },
    state::AppState,
    team_run_service::TeamRunService,
    terminal_session_service::{self, TerminalSessionService},
    tools::shell_command,
    workspace_service::{WorkspaceNode, WorkspaceSearchMatch},
    terminal_ws::terminal_websocket_handler,
    ws::websocket_handler,
};

pub fn build_router(state: AppState) -> Router {
    let web_root = state
        .with_config(|config| config.web_root().map(PathBuf::from))
        .ok()
        .flatten();
    let allowed_origins = state
        .with_config(|config| config.allowed_origins())
        .unwrap_or_default();
    let mut router = Router::new()
        .route("/api/health", get(health))
        .route("/api/runtime", get(get_runtime).put(update_runtime))
        .route("/api/runtime/projects", get(list_runtime_projects).post(add_runtime_project))
        .route(
            "/api/runtime/projects/{project_id}/open",
            post(open_runtime_project),
        )
        .route(
            "/api/runtime/projects/{project_id}",
            delete(delete_runtime_project),
        )
        .route("/api/workspace", get(list_workspace))
        .route("/api/workspace/file", get(read_workspace_file).put(write_workspace_file))
        .route("/api/workspace/search", get(search_workspace))
        .route("/api/workspace/files", get(list_workspace_files))
        .route("/api/terminal/exec", post(exec_terminal))
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
        .route("/api/skills/install-github", post(install_github_skill))
        .route("/api/mcp-servers", get(list_mcp_servers).post(create_mcp_server))
        .route(
            "/api/mcp-servers/{server_id}",
            patch(update_mcp_server).delete(delete_mcp_server),
        )
        .route("/api/extension-stores", get(list_extension_stores))
        .route(
            "/api/extension-stores/{store_id}/catalog",
            get(list_extension_catalog),
        )
        .route(
            "/api/extension-stores/{store_id}/install",
            post(install_extension),
        )
        .route("/api/sessions/{session_id}/runs", post(create_agent_run))
        .route("/api/sessions/{session_id}/runs/cancel", post(cancel_agent_runs))
        .route("/api/sessions/{session_id}/runs/active", get(list_active_runs))
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
            "/api/team-runs/{team_run_id}/tasks/{team_task_id}/patch",
            get(preview_team_task_patch),
        )
        .route("/api/approvals/pending", get(list_pending_approvals))
        .route(
            "/api/team-runs/{team_run_id}/messages",
            get(list_team_messages),
        )
        .route("/ws", get(websocket_handler))
        .route("/ws/terminal", get(terminal_websocket_handler))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
        .layer(cors_layer(&allowed_origins));

    if let Some(web_root) = web_root.filter(|path| path.is_dir()) {
        let index = web_root.join("index.html");
        let static_files = ServeDir::new(web_root).not_found_service(ServeFile::new(index));
        router = router.fallback_service(static_files);
    }

    router
}

/// 收紧后的 CORS：只放行显式列出的 Origin。
///
/// `CorsLayer::permissive()` 会让任意网页从浏览器直接调用本机控制平面
/// （DNS rebinding 与本机恶意页面都能利用），因此不再使用。
/// 无法解析的 Origin 字符串被丢弃而非降级为通配。
fn cors_layer(allowed_origins: &[String]) -> CorsLayer {
    let origins: Vec<HeaderValue> = allowed_origins
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-prometheus-token"),
        ])
}


async fn list_team_runs(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<TeamRunsResponse>, AppError> {
    let service = team_service(&state)?;
    Ok(Json(TeamRunsResponse {
        teams: service.list_for_session(&session_id).await?,
    }))
}

async fn create_team_run(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(input): Json<CreateTeamRunInput>,
) -> Result<(StatusCode, Json<TeamRunResponse>), AppError> {
    let service = team_service(&state)?;
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
    let service = team_service(&state)?;
    Ok(Json(TeamRunResponse {
        team: service.get(&team_run_id).await?,
    }))
}

fn team_service(state: &AppState) -> Result<TeamRunService, AppError> {
    let (tools, worktrees, skills) = state.with_live(|live| {
        (
            live.tools.clone(),
            live.worktrees.clone(),
            live.skills.clone(),
        )
    })?;
    let agent_runs = AgentRunService::new(
        state.sessions.clone(),
        state.configuration.clone(),
        state.event_hub.clone(),
        tools,
        state.approvals.clone(),
        state.run_streams.clone(),
        state.active_runs.clone(),
        state.team_messages.clone(),
        state.teams.clone(),
        worktrees.clone(),
        skills,
        state.mcp.clone(),
    );
    Ok(TeamRunService::new(
        state.sessions.clone(),
        state.configuration.clone(),
        state.teams.clone(),
        agent_runs,
        state.event_hub.clone(),
        worktrees,
    ))
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamTaskPatchResponse {
    patch: crate::team_run_service::TeamTaskPatchPreview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingApprovalsResponse {
    approvals: Vec<PendingApprovalView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingApprovalView {
    approval_id: String,
    session_id: String,
    session_title: String,
    event_id: String,
    created_at: String,
    tool_name: String,
    live: bool,
    payload: serde_json::Value,
}

async fn preview_team_task_patch(
    State(state): State<AppState>,
    Path((team_run_id, team_task_id)): Path<(String, String)>,
) -> Result<Json<TeamTaskPatchResponse>, AppError> {
    if Uuid::parse_str(&team_run_id).is_err() {
        return Err(AppError::invalid_request("teamRunId must be a UUID"));
    }
    if Uuid::parse_str(&team_task_id).is_err() {
        return Err(AppError::invalid_request("teamTaskId must be a UUID"));
    }
    let service = team_service(&state)?;
    Ok(Json(TeamTaskPatchResponse {
        patch: service
            .preview_task_patch(&team_run_id, &team_task_id)
            .await?,
    }))
}

async fn list_pending_approvals(
    State(state): State<AppState>,
) -> Result<Json<PendingApprovalsResponse>, AppError> {
    let live_pairs = state.approvals.list_pending();
    let mut seen = std::collections::HashSet::<String>::new();
    let mut approvals = Vec::new();

    for (approval_id, session_id) in live_pairs {
        seen.insert(approval_id.clone());
        let session_title = state
            .sessions
            .get(&session_id)
            .await?
            .map(|session| session.title)
            .unwrap_or_else(|| session_id.clone());
        let events = match state.sessions.list_events(&session_id, 0).await {
            Ok(events) => events,
            Err(_) => continue,
        };
        let Some(request) = find_approval_request(&events, &approval_id) else {
            // Live waiter exists but durable request missing — still expose a minimal card.
            approvals.push(PendingApprovalView {
                approval_id,
                session_id,
                session_title,
                event_id: String::new(),
                created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                tool_name: "protected_tool".into(),
                live: true,
                payload: serde_json::json!({}),
            });
            continue;
        };
        let tool_name = request
            .payload
            .get("toolName")
            .and_then(|value| value.as_str())
            .unwrap_or("protected_tool")
            .to_owned();
        approvals.push(PendingApprovalView {
            approval_id,
            session_id,
            session_title,
            event_id: request.event_id.clone(),
            created_at: request.created_at.clone(),
            tool_name,
            live: true,
            payload: request.payload.clone(),
        });
    }

    // Durable unresolved requests survive process restarts even when oneshot waiters are gone.
    // Surface them so the inbox/timeline can clear dead cards instead of looking stuck.
    let sessions = state.sessions.list().await.unwrap_or_default();
    for session in sessions.into_iter().take(100) {
        let events = match state.sessions.list_events(&session.id, 0).await {
            Ok(events) => events,
            Err(_) => continue,
        };
        let mut resolved = std::collections::HashSet::<String>::new();
        for event in &events {
            if event.event_type != "approval.resolved" {
                continue;
            }
            if let Some(id) = event.payload.get("approvalId").and_then(|value| value.as_str()) {
                resolved.insert(id.to_owned());
            }
        }
        for event in &events {
            if event.event_type != "approval.requested" {
                continue;
            }
            let Some(approval_id) = event
                .payload
                .get("approvalId")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
            else {
                continue;
            };
            if resolved.contains(&approval_id) || !seen.insert(approval_id.clone()) {
                continue;
            }
            let tool_name = event
                .payload
                .get("toolName")
                .and_then(|value| value.as_str())
                .unwrap_or("protected_tool")
                .to_owned();
            approvals.push(PendingApprovalView {
                approval_id,
                session_id: session.id.clone(),
                session_title: session.title.clone(),
                event_id: event.event_id.clone(),
                created_at: event.created_at.clone(),
                tool_name,
                live: false,
                payload: event.payload.clone(),
            });
        }
    }

    approvals.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Ok(Json(PendingApprovalsResponse { approvals }))
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
    let service = team_service(&state)?;
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
    let service = team_service(&state)?;
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



async fn get_runtime(State(state): State<AppState>) -> Result<Json<RuntimeResponse>, AppError> {
    let settings = state.load_runtime_settings()?;
    let (host, port, workspace_root, workspace_name, runtime_file, data_file) =
        state.with_config(|config| {
            (
                config.host().to_string(),
                config.port(),
                config.workspace_root().display().to_string(),
                config.workspace_name(),
                config.runtime_file().display().to_string(),
                config.data_file().display().to_string(),
            )
        })?;
    Ok(Json(RuntimeResponse {
        host,
        port,
        workspace_root,
        workspace_name,
        runtime_file,
        data_file,
        mode: "control-plane",
        restart_required: false,
        projects: settings.projects,
        active_project_id: settings.active_project_id,
        listen_hint: "host/port changes are saved to runtime.json and apply on server restart".into(),
    }))
}

async fn update_runtime(
    State(state): State<AppState>,
    Json(input): Json<UpdateRuntimeInput>,
) -> Result<Json<RuntimeResponse>, AppError> {
    let mut settings = state.load_runtime_settings()?;
    let mut restart_required = false;

    if let Some(host) = input.host.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) {
        let parsed: std::net::IpAddr = host.parse().map_err(|error| {
            AppError::invalid_request(format!("Invalid host: {error}"))
        })?;
        let next = parsed.to_string();
        let current = state.with_config(|config| config.host().to_string())?;
        if settings.host.as_deref() != Some(next.as_str()) || current != next {
            settings.host = Some(next);
            restart_required = true;
        }
    }
    if let Some(port) = input.port {
        if port == 0 {
            return Err(AppError::invalid_request("port must be between 1 and 65535"));
        }
        let current = state.with_config(|config| config.port())?;
        if settings.port != Some(port) || current != port {
            settings.port = Some(port);
            restart_required = true;
        }
    }
    if let Some(path) = input.workspace_root.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) {
        let project = settings.upsert_project(std::path::Path::new(path))?;
        state.switch_workspace(std::path::Path::new(&project.path))?;
    }

    state.save_runtime_settings(&settings)?;
    let (host, port, workspace_root, workspace_name, runtime_file, data_file) =
        state.with_config(|config| {
            (
                config.host().to_string(),
                config.port(),
                config.workspace_root().display().to_string(),
                config.workspace_name(),
                config.runtime_file().display().to_string(),
                config.data_file().display().to_string(),
            )
        })?;
    Ok(Json(RuntimeResponse {
        host: settings.host.clone().unwrap_or(host),
        port: settings.port.unwrap_or(port),
        workspace_root,
        workspace_name,
        runtime_file,
        data_file,
        mode: "control-plane",
        restart_required,
        projects: settings.projects,
        active_project_id: settings.active_project_id,
        listen_hint: "host/port changes are saved to runtime.json and apply on server restart".into(),
    }))
}

async fn list_runtime_projects(
    State(state): State<AppState>,
) -> Result<Json<RuntimeProjectsResponse>, AppError> {
    let settings = state.load_runtime_settings()?;
    Ok(Json(RuntimeProjectsResponse {
        projects: settings.projects,
        active_project_id: settings.active_project_id,
    }))
}

async fn add_runtime_project(
    State(state): State<AppState>,
    Json(input): Json<AddRuntimeProjectInput>,
) -> Result<(StatusCode, Json<RuntimeProjectResponse>), AppError> {
    let path = input.path.trim();
    if path.is_empty() {
        return Err(AppError::invalid_request("path is required"));
    }
    let mut settings = state.load_runtime_settings()?;
    let project = settings.upsert_project_with_options(
        std::path::Path::new(path),
        input.create.unwrap_or(false),
    )?;
    if input.open.unwrap_or(true) {
        state.switch_workspace(std::path::Path::new(&project.path))?;
    }
    state.save_runtime_settings(&settings)?;
    Ok((
        StatusCode::CREATED,
        Json(RuntimeProjectResponse {
            project,
            active_project_id: settings.active_project_id,
        }),
    ))
}

async fn open_runtime_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<Json<RuntimeProjectResponse>, AppError> {
    let mut settings = state.load_runtime_settings()?;
    let project = settings
        .find_project(&project_id)
        .cloned()
        .ok_or_else(|| AppError::invalid_request("Project not found"))?;
    let project = settings.upsert_project(std::path::Path::new(&project.path))?;
    state.switch_workspace(std::path::Path::new(&project.path))?;
    state.save_runtime_settings(&settings)?;
    Ok(Json(RuntimeProjectResponse {
        project,
        active_project_id: settings.active_project_id,
    }))
}

async fn delete_runtime_project(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let mut settings = state.load_runtime_settings()?;
    if !settings.remove_project(&project_id) {
        return Err(AppError::invalid_request("Project not found"));
    }
    state.save_runtime_settings(&settings)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn health(State(state): State<AppState>) -> Result<Json<HealthResponse>, AppError> {
    let (workspace, workspace_root, host, port, terminal_mode, auth_required) = state
        .with_config(|config| {
            (
                config.workspace_name(),
                config.workspace_root().display().to_string(),
                config.host().to_string(),
                config.port(),
                config.terminal_mode(),
                config.access_token().is_some(),
            )
        })?;
    let mode = if host == "127.0.0.1" || host == "::1" {
        "local"
    } else {
        "shared"
    };
    // capabilities 让客户端精确知道哪些通道可用，替代硬编码的 "planned" 标记。
    let mut capabilities = vec!["worktree", "mcp", "skills", "team", "extension-store"];
    if terminal_mode.is_enabled() {
        capabilities.push("terminal");
    }
    Ok(Json(HealthResponse {
        status: "ok",
        workspace,
        workspace_root,
        host,
        port,
        mode,
        protocol_version: PROTOCOL_VERSION,
        terminal_mode: terminal_mode.as_str(),
        auth_required,
        capabilities,
        timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
}

async fn list_workspace(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceQuery>,
) -> Result<Json<WorkspaceResponse>, AppError> {
    state.with_live(|live| {
        Ok::<_, AppError>(Json(WorkspaceResponse {
            root_name: live.service.root_name().to_owned(),
            path: query.path.clone(),
            nodes: live.service.list(&query.path)?,
        }))
    })?
}

async fn read_workspace_file(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceFileQuery>,
) -> Result<Json<WorkspaceFileReadResponse>, AppError> {
    if query.path.trim().is_empty() {
        return Err(AppError::invalid_request("path is required"));
    }
    let read = state.with_live(|live| {
        live.service.read_text_file(&query.path, Some(512 * 1024))
    })??;
    Ok(Json(WorkspaceFileReadResponse {
        path: query.path,
        content: read.content,
        truncated: read.truncated,
    }))
}

async fn write_workspace_file(
    State(state): State<AppState>,
    Json(input): Json<WorkspaceFileWriteInput>,
) -> Result<Json<WorkspaceFileWriteResponse>, AppError> {
    if input.path.trim().is_empty() {
        return Err(AppError::invalid_request("path is required"));
    }
    let written = state.with_live(|live| {
        live.service
            .write_text_file(&input.path, &input.content, Some(1024 * 1024))
    })??;
    Ok(Json(WorkspaceFileWriteResponse {
        path: written.path,
        bytes: written.bytes,
    }))
}


async fn search_workspace(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceSearchQuery>,
) -> Result<Json<WorkspaceSearchResponse>, AppError> {
    let needle = query.q.trim();
    if needle.is_empty() {
        return Err(AppError::invalid_request("q is required"));
    }
    let matches = state.with_live(|live| {
        live.service
            .search_text(needle, query.path.as_str(), query.limit)
    })??;
    Ok(Json(WorkspaceSearchResponse { matches }))
}

async fn list_workspace_files(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceFilesQuery>,
) -> Result<Json<WorkspaceFilesResponse>, AppError> {
    let files = state.with_live(|live| live.service.list_files(query.path.as_str(), query.limit))??;
    Ok(Json(WorkspaceFilesResponse { files }))
}


/// 一次性终端命令。
///
/// 与 `shell_command` 工具能力等价，因此必须走同一套准入：
/// `TerminalMode` 门禁 → 权限规则求值 → 跨终端审批 → durable 事件。
/// `sessionId` 是必填项——没有会话就没有可审计的落点。
async fn exec_terminal(
    State(state): State<AppState>,
    Json(input): Json<TerminalExecInput>,
) -> Result<Json<TerminalExecResponse>, AppError> {
    let workdir = input.workdir.clone().unwrap_or_default();
    let terminal = TerminalSessionService::new(state.clone());
    let grant = terminal
        .authorize_exec(&input.session_id, &input.command, &workdir)
        .await?;

    let workspace = state.with_live(|live| live.service.clone())?;
    let outcome = shell_command::execute_shell(
        &workspace,
        &input.command,
        &workdir,
        input.timeout_ms,
    );

    let result = match outcome {
        Ok(result) => result,
        Err(error) => {
            terminal
                .finish(
                    &grant,
                    terminal_session_service::EXEC_TOOL_NAME,
                    serde_json::json!({ "status": "failed", "message": error.to_string() }),
                )
                .await;
            return Err(error);
        }
    };

    terminal
        .finish(
            &grant,
            terminal_session_service::EXEC_TOOL_NAME,
            serde_json::json!({
                "status": if result.is_error { "failed" } else { "completed" },
                "exitCode": result.exit_code,
                "durationMs": result.duration_ms as u64,
                "totalBytes": result.total_bytes,
                "timedOut": result.timed_out,
            }),
        )
        .await;

    Ok(Json(TerminalExecResponse {
        exit_code: result.exit_code,
        duration_ms: result.duration_ms as u64,
        output: result.output,
        total_bytes: result.total_bytes,
        timed_out: result.timed_out,
        is_error: result.is_error,
        command: input.command,
        workdir,
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


async fn cancel_agent_runs(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    input: Option<Json<CancelRunsInput>>,
) -> Result<Json<CancelRunsResponse>, AppError> {
    let input = input.map(|value| value.0).unwrap_or(CancelRunsInput { run_id: None });
    if Uuid::parse_str(&session_id).is_err() {
        return Err(AppError::invalid_request("sessionId must be a UUID"));
    }
    if state.sessions.get(&session_id).await?.is_none() {
        return Err(AppError::session_not_found(&session_id));
    }
    let run_id = input.run_id.filter(|value| !value.trim().is_empty());
    if let Some(id) = &run_id {
        if Uuid::parse_str(id).is_err() {
            return Err(AppError::invalid_request("runId must be a UUID"));
        }
    }
    let cancelled_run_ids = state
        .active_runs
        .cancel(&session_id, run_id.as_deref())?;
    let denied_ids = state.approvals.deny_all_for_session(&session_id);
    for approval_id in &denied_ids {
        let _ = persist_approval_resolution(
            &state,
            &session_id,
            approval_id,
            ApprovalDecision::Denied,
            true,
            false,
        )
        .await;
    }
    Ok(Json(CancelRunsResponse {
        cancelled_run_ids,
        denied_approvals: denied_ids.len(),
    }))
}

async fn list_active_runs(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<ActiveRunsResponse>, AppError> {
    if Uuid::parse_str(&session_id).is_err() {
        return Err(AppError::invalid_request("sessionId must be a UUID"));
    }
    if state.sessions.get(&session_id).await?.is_none() {
        return Err(AppError::session_not_found(&session_id));
    }
    Ok(Json(ActiveRunsResponse {
        run_ids: state.active_runs.list(&session_id)?,
    }))
}

async fn create_agent_run(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(input): Json<CreateAgentRunInput>,
) -> Result<(StatusCode, Json<AgentRunResponse>), AppError> {
    if Uuid::parse_str(&input.agent_id).is_err() {
        return Err(AppError::invalid_request("agentId must be a UUID"));
    }
    let (tools, worktrees, skills) = state.with_live(|live| {
        (
            live.tools.clone(),
            live.worktrees.clone(),
            live.skills.clone(),
        )
    })?;
    let service = AgentRunService::new(
        state.sessions.clone(),
        state.configuration.clone(),
        state.event_hub.clone(),
        tools,
        state.approvals.clone(),
        state.run_streams.clone(),
        state.active_runs.clone(),
        state.team_messages.clone(),
        state.teams.clone(),
        worktrees,
        skills,
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

    // Live waiter path: wake the agent run, then always durable-write the resolution
    // so the UI/multi-device timeline updates even if the run task already died.
    let live = state
        .approvals
        .resolve(&session_id, &approval_id, decision.clone());

    match live {
        Ok(approval) => {
            let _ = persist_approval_resolution(
                &state,
                &session_id,
                &approval_id,
                decision,
                false,
                false,
            )
            .await?;
            Ok(Json(ApprovalResponse { approval }))
        }
        Err(_) => {
            // Idempotent / stale recovery from the durable event log.
            let events = state.sessions.list_events(&session_id, 0).await?;
            if let Some(existing) = find_approval_resolution(&events, &approval_id) {
                let existing_decision = existing
                    .payload
                    .get("decision")
                    .and_then(|value| value.as_str())
                    .unwrap_or("denied");
                return Ok(Json(ApprovalResponse {
                    approval: ApprovalResolution {
                        approval_id: approval_id.clone(),
                        session_id: session_id.clone(),
                        decision: existing_decision.to_owned(),
                    },
                }));
            }
            if find_approval_request(&events, &approval_id).is_none() {
                return Err(AppError::approval_not_found());
            }
            // Request exists in history but the in-memory waiter is gone (run aborted,
            // process restart, etc). Persist the user's decision so the card clears.
            let _ = persist_approval_resolution(
                &state,
                &session_id,
                &approval_id,
                decision.clone(),
                false,
                true,
            )
            .await?;
            Ok(Json(ApprovalResponse {
                approval: ApprovalResolution {
                    approval_id,
                    session_id,
                    decision: decision.as_str().to_owned(),
                },
            }))
        }
    }
}

fn find_approval_request<'a>(
    events: &'a [SessionEvent],
    approval_id: &str,
) -> Option<&'a SessionEvent> {
    events.iter().rev().find(|event| {
        event.event_type == "approval.requested"
            && event
                .payload
                .get("approvalId")
                .and_then(|value| value.as_str())
                == Some(approval_id)
    })
}

fn find_approval_resolution<'a>(
    events: &'a [SessionEvent],
    approval_id: &str,
) -> Option<&'a SessionEvent> {
    events.iter().rev().find(|event| {
        event.event_type == "approval.resolved"
            && event
                .payload
                .get("approvalId")
                .and_then(|value| value.as_str())
                == Some(approval_id)
    })
}

async fn persist_approval_resolution(
    state: &AppState,
    session_id: &str,
    approval_id: &str,
    decision: ApprovalDecision,
    cancelled: bool,
    stale: bool,
) -> Result<SessionEvent, AppError> {
    let events = state.sessions.list_events(session_id, 0).await?;
    if find_approval_resolution(&events, approval_id).is_some() {
        return find_approval_resolution(&events, approval_id)
            .cloned()
            .ok_or_else(AppError::approval_not_found);
    }
    let request = find_approval_request(&events, approval_id);
    let mut payload = serde_json::json!({
        "approvalId": approval_id,
        "decision": decision.as_str(),
        "cancelled": cancelled,
        "stale": stale,
    });
    if let Some(request) = request {
        if let Some(value) = request.payload.get("runId").cloned() {
            payload["runId"] = value;
        }
        if let Some(value) = request.payload.get("toolCallId").cloned() {
            payload["toolCallId"] = value;
        }
        if let Some(value) = request.payload.get("toolName").cloned() {
            payload["toolName"] = value;
        }
        if let Some(value) = request.payload.get("arguments").cloned() {
            payload["arguments"] = value;
        }
    }
    let event = state
        .sessions
        .append_event(
            session_id,
            AppendEventInput {
                event_id: Uuid::new_v4().to_string(),
                event_type: "approval.resolved".to_owned(),
                actor: Actor {
                    kind: "system".into(),
                    id: "approval-gate".into(),
                    label: "Approval Gate".into(),
                },
                payload,
            },
        )
        .await?;
    state.event_hub.publish(event.clone()).await;
    Ok(event)
}


async fn list_skills(State(state): State<AppState>) -> Result<Json<SkillsResponse>, AppError> {
    Ok(Json(SkillsResponse {
        skills: state.with_live(|live| live.skills.list())??,
    }))
}

async fn list_extension_stores() -> Result<Json<ExtensionStoresResponse>, AppError> {
    Ok(Json(ExtensionStoresResponse {
        stores: ExtensionCatalogService::new().list_stores(),
    }))
}

#[derive(Debug, Deserialize)]
struct ExtensionCatalogQuery {
    q: Option<String>,
    refresh: Option<bool>,
}

async fn list_extension_catalog(
    State(state): State<AppState>,
    Path(store_id): Path<String>,
    Query(query): Query<ExtensionCatalogQuery>,
) -> Result<Json<ExtensionCatalogResponse>, AppError> {
    let skills = state.with_live(|live| live.skills.clone())?;
    let workspace_root = state.with_live(|live| live.root.clone())?;
    let entries = ExtensionCatalogService::new()
        .list_catalog(
            &store_id,
            query.q.as_deref(),
            query.refresh.unwrap_or(false),
            &skills,
            &state.mcp,
            &workspace_root,
        )
        .await?;
    Ok(Json(ExtensionCatalogResponse {
        store_id,
        entries,
    }))
}

async fn install_extension(
    State(state): State<AppState>,
    Path(store_id): Path<String>,
    Json(input): Json<InstallExtensionInput>,
) -> Result<(StatusCode, Json<ExtensionInstallResponse>), AppError> {
    let skills = state.with_live(|live| live.skills.clone())?;
    let workspace_root = state.with_live(|live| live.root.clone())?;
    let result = ExtensionCatalogService::new()
        .install(
            &store_id,
            &input.entry_id,
            input.env,
            input.enabled,
            &skills,
            &state.mcp,
            &workspace_root,
        )
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(ExtensionInstallResponse { result }),
    ))
}

async fn install_github_skill(
    State(state): State<AppState>,
    Json(input): Json<InstallGithubSkillInput>,
) -> Result<(StatusCode, Json<SkillInstallResponse>), AppError> {
    let skills = state.with_live(|live| live.skills.clone())?;
    let skill = ExtensionCatalogService::new()
        .install_skill_from_github(
            &input.repo,
            &input.path,
            input.r#ref.as_deref(),
            input.skill_id.as_deref(),
            &skills,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(SkillInstallResponse { skill })))
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

#[derive(Deserialize)]
struct WorkspaceFileQuery {
    path: String,
}

#[derive(Deserialize)]
struct WorkspaceSearchQuery {
    q: String,
    #[serde(default)]
    path: String,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct WorkspaceFilesQuery {
    #[serde(default)]
    path: String,
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSearchResponse {
    matches: Vec<WorkspaceSearchMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFilesResponse {
    files: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelRunsInput {
    #[serde(default)]
    run_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelRunsResponse {
    cancelled_run_ids: Vec<String>,
    denied_approvals: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveRunsResponse {
    run_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExecInput {
    session_id: String,
    command: String,
    #[serde(default)]
    workdir: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExecResponse {
    exit_code: Option<i32>,
    duration_ms: u64,
    output: String,
    total_bytes: usize,
    timed_out: bool,
    is_error: bool,
    command: String,
    workdir: String,
}


#[derive(Deserialize)]
struct WorkspaceFileWriteInput {
    path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileReadResponse {
    path: String,
    content: String,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileWriteResponse {
    path: String,
    bytes: usize,
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeResponse {
    host: String,
    port: u16,
    workspace_root: String,
    workspace_name: String,
    runtime_file: String,
    data_file: String,
    mode: &'static str,
    restart_required: bool,
    projects: Vec<crate::runtime_settings::RuntimeProject>,
    active_project_id: Option<String>,
    listen_hint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRuntimeInput {
    host: Option<String>,
    port: Option<u16>,
    workspace_root: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProjectsResponse {
    projects: Vec<crate::runtime_settings::RuntimeProject>,
    active_project_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddRuntimeProjectInput {
    path: String,
    open: Option<bool>,
    /// When true, create the directory if it does not exist (new space).
    create: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProjectResponse {
    project: crate::runtime_settings::RuntimeProject,
    active_project_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    workspace: String,
    workspace_root: String,
    host: String,
    port: u16,
    mode: &'static str,
    protocol_version: u32,
    terminal_mode: &'static str,
    auth_required: bool,
    capabilities: Vec<&'static str>,
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
struct ExtensionStoresResponse {
    stores: Vec<ExtensionStore>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionCatalogResponse {
    store_id: String,
    entries: Vec<ExtensionCatalogEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionInstallResponse {
    result: ExtensionInstallResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillInstallResponse {
    skill: SkillSummary,
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
