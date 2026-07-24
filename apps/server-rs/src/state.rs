use crate::{
    approval_coordinator::ApprovalCoordinator,
    config::Config,
    config_repository::ConfigRepository,
    database::Database,
    error::AppError,
    event_hub::EventHub,
    git_worktree_manager::GitWorktreeManager,
    mcp_repository::McpRepository,
    run_stream_hub::RunStreamHub,
    secret_vault::SecretVault,
    session_repository::SessionRepository,
    skill_service::SkillService,
    team_message_repository::TeamMessageRepository,
    team_message_service::TeamMessageService,
    team_run_repository::TeamRunRepository,
    tools::{SharedTools, default_tools},
    workspace_service::WorkspaceService,
};

#[derive(Clone)]
pub struct AppState {
    pub(crate) config: Config,
    pub(crate) sessions: SessionRepository,
    pub(crate) workspace: WorkspaceService,
    pub(crate) configuration: ConfigRepository,
    pub(crate) event_hub: EventHub,
    pub(crate) run_streams: RunStreamHub,
    pub(crate) teams: TeamRunRepository,
    pub(crate) team_messages: TeamMessageService,
    pub(crate) tools: SharedTools,
    pub(crate) approvals: ApprovalCoordinator,
    pub(crate) worktrees: Option<GitWorktreeManager>,
    pub(crate) skills: SkillService,
    pub(crate) mcp: McpRepository,
}

impl AppState {
    pub async fn open(config: Config) -> Result<Self, AppError> {
        let database = Database::open(config.data_file()).await?;
        let workspace = WorkspaceService::open(config.workspace_root())?;
        let vault = SecretVault::new(config.master_key())?;
        let tools = default_tools(workspace.clone());
        let teams = TeamRunRepository::new(database.clone());
        let _ = teams.interrupt_running().await?;
        let sessions = SessionRepository::new(database.clone());
        let event_hub = EventHub::new();
        let team_messages = TeamMessageService::new(
            sessions.clone(),
            TeamMessageRepository::new(database.clone()),
            event_hub.clone(),
        );
        let worktrees =
            GitWorktreeManager::new(config.workspace_root(), config.worktree_root()).ok();
        let skills = SkillService::new(config.workspace_root());
        let mcp = McpRepository::new(database.clone());
        Ok(Self {
            config,
            sessions,
            workspace,
            configuration: ConfigRepository::new(database, vault),
            event_hub,
            run_streams: RunStreamHub::new(),
            teams,
            team_messages,
            tools,
            approvals: ApprovalCoordinator::new(),
            worktrees,
            skills,
            mcp,
        })
    }
}
