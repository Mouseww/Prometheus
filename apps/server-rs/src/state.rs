use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::{
    active_run_hub::ActiveRunHub,
    approval_coordinator::ApprovalCoordinator,
    config::Config,
    config_repository::ConfigRepository,
    database::Database,
    error::AppError,
    event_hub::EventHub,
    git_worktree_manager::GitWorktreeManager,
    mcp_repository::McpRepository,
    run_stream_hub::RunStreamHub,
    runtime_settings::RuntimeSettings,
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
pub struct LiveWorkspace {
    pub service: WorkspaceService,
    pub tools: SharedTools,
    pub skills: SkillService,
    pub worktrees: Option<GitWorktreeManager>,
    pub root: PathBuf,
}

#[derive(Clone)]
pub struct AppState {
    pub(crate) config: Arc<Mutex<Config>>,
    pub(crate) runtime_file: PathBuf,
    pub(crate) live: Arc<Mutex<LiveWorkspace>>,
    pub(crate) sessions: SessionRepository,
    pub(crate) configuration: ConfigRepository,
    pub(crate) event_hub: EventHub,
    pub(crate) run_streams: RunStreamHub,
    pub(crate) active_runs: ActiveRunHub,
    pub(crate) teams: TeamRunRepository,
    pub(crate) team_messages: TeamMessageService,
    pub(crate) approvals: ApprovalCoordinator,
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
        let runtime_file = config.runtime_file().to_path_buf();
        let live = LiveWorkspace {
            root: config.workspace_root().to_path_buf(),
            service: workspace,
            tools,
            skills,
            worktrees,
        };

        // Ensure current workspace is tracked in runtime settings.
        let mut settings = RuntimeSettings::load(&runtime_file)?;
        if settings.workspace_root.is_none() {
            let _ = settings.upsert_project(config.workspace_root());
            let _ = settings.save(&runtime_file);
        }

        Ok(Self {
            config: Arc::new(Mutex::new(config)),
            runtime_file,
            live: Arc::new(Mutex::new(live)),
            sessions,
            configuration: ConfigRepository::new(database, vault),
            event_hub,
            run_streams: RunStreamHub::new(),
            active_runs: ActiveRunHub::new(),
            teams,
            team_messages,
            approvals: ApprovalCoordinator::new(),
            mcp,
        })
    }

    pub fn with_config<R>(&self, f: impl FnOnce(&Config) -> R) -> Result<R, AppError> {
        let guard = self
            .config
            .lock()
            .map_err(|_| AppError::configuration("Config lock poisoned"))?;
        Ok(f(&guard))
    }

    pub fn with_live<R>(&self, f: impl FnOnce(&LiveWorkspace) -> R) -> Result<R, AppError> {
        let guard = self
            .live
            .lock()
            .map_err(|_| AppError::configuration("Workspace lock poisoned"))?;
        Ok(f(&guard))
    }

    pub fn load_runtime_settings(&self) -> Result<RuntimeSettings, AppError> {
        RuntimeSettings::load(&self.runtime_file)
    }

    pub fn save_runtime_settings(&self, settings: &RuntimeSettings) -> Result<(), AppError> {
        settings.save(&self.runtime_file)
    }

    pub fn switch_workspace(&self, path: &Path) -> Result<LiveWorkspace, AppError> {
        let service = WorkspaceService::open(path)?;
        let tools = default_tools(service.clone());
        let skills = SkillService::new(path);
        let root = service.root_path().to_path_buf();
        let worktree_root = {
            let parent = root.parent().unwrap_or(&root);
            let name = root
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| "workspace".to_owned());
            parent.join(".prometheus-worktrees").join(name)
        };
        let worktrees = GitWorktreeManager::new(&root, &worktree_root).ok();
        let next = LiveWorkspace {
            service,
            tools,
            skills,
            worktrees,
            root: root.clone(),
        };

        {
            let mut guard = self
                .live
                .lock()
                .map_err(|_| AppError::configuration("Workspace lock poisoned"))?;
            *guard = next.clone();
        }
        {
            let mut config = self
                .config
                .lock()
                .map_err(|_| AppError::configuration("Config lock poisoned"))?;
            config.set_workspace_root(root);
        }
        Ok(next)
    }
}
