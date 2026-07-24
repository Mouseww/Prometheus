use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::json;
use uuid::Uuid;

use crate::{
    agent_run_service::{AgentRunService, SubagentMetadata},
    config_repository::ConfigRepository,
    error::AppError,
    event_hub::EventHub,
    git_worktree_manager::{CreatedWorktree, GitWorktreeManager},
    models::{
        Actor, AgentProfile, AppendEventInput, CreateTeamRunInput, TeamPathAssignment, TeamRun,
        TeamRunTask,
    },
    session_repository::SessionRepository,
    team_run_repository::{
        CreateTeamRunRecord, CreateTeamTaskRecord, TeamRunRepository, TeamTaskWorkspace,
    },
};

#[derive(Clone)]
pub struct TeamRunService {
    sessions: SessionRepository,
    configuration: ConfigRepository,
    teams: TeamRunRepository,
    agent_runs: AgentRunService,
    event_hub: EventHub,
    worktrees: Option<GitWorktreeManager>,
}

impl TeamRunService {
    pub fn new(
        sessions: SessionRepository,
        configuration: ConfigRepository,
        teams: TeamRunRepository,
        agent_runs: AgentRunService,
        event_hub: EventHub,
        worktrees: Option<GitWorktreeManager>,
    ) -> Self {
        Self {
            sessions,
            configuration,
            teams,
            agent_runs,
            event_hub,
            worktrees,
        }
    }

    pub async fn list_for_session(&self, session_id: &str) -> Result<Vec<TeamRun>, AppError> {
        if self.sessions.get(session_id).await?.is_none() {
            return Err(AppError::session_not_found(session_id));
        }
        self.teams.list_for_session(session_id).await
    }

    pub async fn get(&self, team_run_id: &str) -> Result<TeamRun, AppError> {
        self.teams
            .get(team_run_id)
            .await?
            .ok_or_else(|| AppError::team_run_not_found("Team run not found"))
    }

    pub async fn start(
        &self,
        session_id: &str,
        input: CreateTeamRunInput,
    ) -> Result<TeamRun, AppError> {
        let (team, _) = self.create(session_id, input).await?;
        self.execute_team(&team.id).await?;
        self.get(&team.id).await
    }

    pub async fn launch(
        &self,
        session_id: &str,
        input: CreateTeamRunInput,
    ) -> Result<TeamRun, AppError> {
        let (team, _) = self.create(session_id, input).await?;
        let service = self.clone();
        let team_id = team.id.clone();
        let session = session_id.to_owned();
        tokio::spawn(async move {
            if let Err(error) = service.execute_team(&team_id).await {
                let _ = service.teams.complete_run(&team_id, "failed").await;
                let _ = service
                    .commit(
                        &session,
                        AppendEventInput {
                            event_id: Uuid::new_v4().to_string(),
                            event_type: "system.notice".to_owned(),
                            actor: Actor {
                                kind: "system".into(),
                                id: "team-runtime".into(),
                                label: "Team Runtime".into(),
                            },
                            payload: json!({
                                "teamRunId": team_id,
                                "message": error.to_string().chars().take(2_000).collect::<String>(),
                            }),
                        },
                    )
                    .await;
            }
        });
        Ok(team)
    }

    pub async fn apply_task_changes(
        &self,
        team_run_id: &str,
        team_task_id: &str,
    ) -> Result<TeamRun, AppError> {
        let (team, task, workspace) = self
            .resolve_workspace_task(team_run_id, team_task_id)
            .await?;
        if !matches!(
            workspace.change_status.as_str(),
            "pending" | "conflicted" | "rejected"
        ) {
            return Err(AppError::team_run_conflict(format!(
                "Task changes cannot be applied from {}",
                workspace.change_status
            )));
        }
        let worktrees = self.worktrees.as_ref().ok_or_else(|| {
            AppError::team_run_conflict("Task worktree is not available")
        })?;
        let worktree_root = workspace.worktree_root.as_deref().ok_or_else(|| {
            AppError::team_run_conflict("Task worktree is not available")
        })?;
        let worktree_branch = workspace.worktree_branch.as_deref().ok_or_else(|| {
            AppError::team_run_conflict("Task worktree is not available")
        })?;
        let base_commit = workspace.base_commit.as_deref().ok_or_else(|| {
            AppError::team_run_conflict("Task worktree is not available")
        })?;

        let result = worktrees.apply(
            Path::new(worktree_root),
            base_commit,
            &workspace.allowed_paths,
        )?;
        self.record_changes(
            &team,
            &task,
            &result.status,
            &result.changed_paths,
            &result.conflict_paths,
            result.patch_bytes as u64,
        )
        .await?;
        if result.status == "applied" || result.status == "no_changes" {
            let created = CreatedWorktree {
                repo_root: PathBuf::new(),
                worktree_root: PathBuf::from(worktree_root),
                workspace_root: PathBuf::new(),
                branch_name: worktree_branch.to_owned(),
                base_commit: base_commit.to_owned(),
            };
            self.cleanup_workspace(&team, &task, &created, &result.status)
                .await;
        }
        self.get(team_run_id).await
    }

    pub async fn discard_task_changes(
        &self,
        team_run_id: &str,
        team_task_id: &str,
    ) -> Result<TeamRun, AppError> {
        let (team, task, workspace) = self
            .resolve_workspace_task(team_run_id, team_task_id)
            .await?;
        if !matches!(
            workspace.change_status.as_str(),
            "isolated" | "pending" | "conflicted" | "rejected"
        ) {
            return Err(AppError::team_run_conflict(format!(
                "Task changes cannot be discarded from {}",
                workspace.change_status
            )));
        }
        let worktrees = self.worktrees.as_ref().ok_or_else(|| {
            AppError::team_run_conflict("Task worktree is not available")
        })?;
        let worktree_root = workspace.worktree_root.as_deref().ok_or_else(|| {
            AppError::team_run_conflict("Task worktree is not available")
        })?;
        let worktree_branch = workspace.worktree_branch.as_deref().ok_or_else(|| {
            AppError::team_run_conflict("Task worktree is not available")
        })?;

        worktrees.cleanup(Path::new(worktree_root), worktree_branch, "discarded")?;
        self.teams
            .record_task_changes(
                &task.id,
                &workspace.changed_paths,
                "discarded",
                &[],
                workspace.patch_bytes,
            )
            .await?;
        self.teams.clear_task_workspace_root(&task.id).await?;
        let _ = self
            .commit(
                &team.session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "team.workspace.discarded".to_owned(),
                    actor: worktree_actor(),
                    payload: json!({
                        "teamRunId": team.id,
                        "teamTaskId": task.id,
                        "changedPaths": workspace.changed_paths,
                    }),
                },
            )
            .await;
        let _ = self
            .commit(
                &team.session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "team.workspace.cleaned".to_owned(),
                    actor: worktree_actor(),
                    payload: json!({
                        "teamRunId": team.id,
                        "teamTaskId": task.id,
                        "outcome": "discarded",
                    }),
                },
            )
            .await;
        self.get(team_run_id).await
    }

    async fn create(
        &self,
        session_id: &str,
        raw: CreateTeamRunInput,
    ) -> Result<(TeamRun, CreateTeamRunInput), AppError> {
        if self.sessions.get(session_id).await?.is_none() {
            return Err(AppError::session_not_found(session_id));
        }
        let input = validate_create_input(raw)?;
        if input.workspace_mode == "worktree" && self.worktrees.is_none() {
            return Err(AppError::runtime_not_migrated(
                "Git worktree runtime is not configured",
            ));
        }

        let mut agents = Vec::with_capacity(input.agent_ids.len());
        for agent_id in &input.agent_ids {
            let agent = self
                .configuration
                .get_agent(agent_id)
                .await?
                .ok_or_else(|| {
                    AppError::team_run_dependency_not_found(format!("Agent not found: {agent_id}"))
                })?;
            agents.push(agent);
        }

        let max_concurrency = input.max_concurrency.min(agents.len() as u32).max(1);
        let team = self
            .teams
            .create(CreateTeamRunRecord {
                session_id: session_id.to_owned(),
                goal: input.goal.clone(),
                max_concurrency,
                workspace_mode: input.workspace_mode.clone(),
                merge_strategy: input.merge_strategy.clone(),
                tasks: agents
                    .iter()
                    .map(|agent| {
                        let allowed = paths_for_agent(&input.path_assignments, &agent.id);
                        CreateTeamTaskRecord {
                            agent_id: agent.id.clone(),
                            agent_label: agent.name.clone(),
                            prompt: build_task_prompt(
                                &input.goal,
                                agent,
                                &input.workspace_mode,
                                &allowed,
                            ),
                            allowed_paths: allowed,
                        }
                    })
                    .collect(),
            })
            .await?;

        for task in &team.tasks {
            self.commit(
                session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "agent.spawned".to_owned(),
                    actor: Actor {
                        kind: "system".into(),
                        id: "team-runtime".into(),
                        label: "Team Runtime".into(),
                    },
                    payload: json!({
                        "teamRunId": team.id,
                        "teamTaskId": task.id,
                        "agentId": task.agent_id,
                        "agentLabel": task.agent_label,
                        "prompt": task.prompt,
                        "status": "queued",
                    }),
                },
            )
            .await?;
        }

        Ok((team, input))
    }

    async fn execute_team(&self, team_run_id: &str) -> Result<(), AppError> {
        let team = self.get(team_run_id).await?;
        let next = Arc::new(AtomicUsize::new(0));
        let failed = Arc::new(AtomicUsize::new(0));
        let workers = team.max_concurrency.min(team.tasks.len() as u32).max(1);
        let mut handles = Vec::new();
        for _ in 0..workers {
            let service = self.clone();
            let team = team.clone();
            let next = next.clone();
            let failed = failed.clone();
            handles.push(tokio::spawn(async move {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    if index >= team.tasks.len() {
                        break;
                    }
                    let task = &team.tasks[index];
                    let ok = service.run_one_task(&team, task).await;
                    if !ok {
                        failed.fetch_add(1, Ordering::SeqCst);
                    }
                }
            }));
        }
        for handle in handles {
            let _ = handle.await;
        }
        let status = if failed.load(Ordering::SeqCst) > 0 {
            "failed"
        } else {
            "completed"
        };
        self.teams.complete_run(team_run_id, status).await?;
        Ok(())
    }

    async fn run_one_task(&self, team: &TeamRun, task: &TeamRunTask) -> bool {
        if let Err(error) = self.teams.mark_task_running(&task.id).await {
            let _ = self
                .commit(
                    &team.session_id,
                    status_event(task, &team.id, "failed", json!({ "message": error.to_string() })),
                )
                .await;
            return false;
        }
        let _ = self
            .commit(
                &team.session_id,
                status_event(task, &team.id, "running", json!({})),
            )
            .await;

        let workspace = if team.workspace_mode == "worktree" {
            match self.create_workspace(team, task).await {
                Ok(workspace) => Some(workspace),
                Err(error) => {
                    let message = error.to_string().chars().take(2_000).collect::<String>();
                    let _ = self.teams.fail_task(&task.id, &message).await;
                    let _ = self
                        .commit(
                            &team.session_id,
                            status_event(
                                task,
                                &team.id,
                                "failed",
                                json!({ "message": message }),
                            ),
                        )
                        .await;
                    return false;
                }
            }
        } else {
            None
        };

        let result = self
            .agent_runs
            .run_task(
                &team.session_id,
                &task.agent_id,
                &task.prompt,
                SubagentMetadata {
                    team_run_id: team.id.clone(),
                    team_task_id: task.id.clone(),
                    workspace_mode: team.workspace_mode.clone(),
                    workspace_root: workspace
                        .as_ref()
                        .map(|item| item.workspace_root.display().to_string()),
                    allowed_paths: task.allowed_paths.clone(),
                },
            )
            .await;

        match result {
            Ok(result) => {
                let output = result
                    .reply_event
                    .payload
                    .get("text")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .chars()
                    .take(1_000_000)
                    .collect::<String>();
                if let Err(error) = self.teams.complete_task(&task.id, &output).await {
                    let _ = self
                        .commit(
                            &team.session_id,
                            status_event(
                                task,
                                &team.id,
                                "failed",
                                json!({ "message": error.to_string() }),
                            ),
                        )
                        .await;
                    return false;
                }
                let change_status = if let Some(workspace) = workspace.as_ref() {
                    self.finalize_workspace(team, task, workspace, &team.merge_strategy)
                        .await
                } else {
                    "not_applicable".to_owned()
                };
                let summary: String = output.chars().take(1_000).collect();
                let _ = self
                    .commit(
                        &team.session_id,
                        status_event(
                            task,
                            &team.id,
                            "completed",
                            json!({
                                "runId": result.run_id,
                                "summary": summary,
                                "outputTruncated": output.chars().count() > 1_000,
                                "changeStatus": change_status,
                            }),
                        ),
                    )
                    .await;
                true
            }
            Err(error) => {
                let message = error.to_string().chars().take(2_000).collect::<String>();
                let change_status = if let Some(workspace) = workspace.as_ref() {
                    self.review_failed_workspace(team, task, workspace).await
                } else {
                    "not_applicable".to_owned()
                };
                let _ = self.teams.fail_task(&task.id, &message).await;
                let _ = self
                    .commit(
                        &team.session_id,
                        status_event(
                            task,
                            &team.id,
                            "failed",
                            json!({
                                "message": message,
                                "changeStatus": change_status,
                            }),
                        ),
                    )
                    .await;
                false
            }
        }
    }

    async fn create_workspace(
        &self,
        team: &TeamRun,
        task: &TeamRunTask,
    ) -> Result<CreatedWorktree, AppError> {
        let worktrees = self.worktrees.as_ref().ok_or_else(|| {
            AppError::runtime_not_migrated("Git worktree runtime is not configured")
        })?;
        let workspace = worktrees.create(&task.id, &task.agent_label)?;
        self.teams
            .set_task_workspace(
                &task.id,
                &workspace.worktree_root.display().to_string(),
                &workspace.branch_name,
                &workspace.base_commit,
            )
            .await?;
        let _ = self
            .commit(
                &team.session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "team.workspace.created".to_owned(),
                    actor: worktree_actor(),
                    payload: json!({
                        "teamRunId": team.id,
                        "teamTaskId": task.id,
                        "agentId": task.agent_id,
                        "branchName": workspace.branch_name,
                        "baseCommit": workspace.base_commit,
                        "allowedPaths": task.allowed_paths,
                    }),
                },
            )
            .await;
        Ok(workspace)
    }

    async fn finalize_workspace(
        &self,
        team: &TeamRun,
        task: &TeamRunTask,
        workspace: &CreatedWorktree,
        merge_strategy: &str,
    ) -> String {
        let Some(worktrees) = self.worktrees.as_ref() else {
            return "conflicted".to_owned();
        };
        let review = match worktrees.review(
            &workspace.worktree_root,
            &workspace.base_commit,
            &task.allowed_paths,
        ) {
            Ok(review) => review,
            Err(error) => {
                let _ = self
                    .commit(
                        &team.session_id,
                        AppendEventInput {
                            event_id: Uuid::new_v4().to_string(),
                            event_type: "system.notice".to_owned(),
                            actor: worktree_actor(),
                            payload: json!({
                                "teamRunId": team.id,
                                "teamTaskId": task.id,
                                "message": error.to_string().chars().take(2_000).collect::<String>(),
                            }),
                        },
                    )
                    .await;
                return "conflicted".to_owned();
            }
        };

        let _ = self
            .record_changes(
                team,
                task,
                &review.status,
                &review.changed_paths,
                &review.disallowed_paths,
                review.patch_bytes as u64,
            )
            .await;
        if review.status == "no_changes" {
            self.cleanup_workspace(team, task, workspace, "no_changes")
                .await;
            return review.status;
        }
        if merge_strategy != "auto" {
            return review.status;
        }

        let applied = match worktrees.apply(
            &workspace.worktree_root,
            &workspace.base_commit,
            &task.allowed_paths,
        ) {
            Ok(applied) => applied,
            Err(error) => {
                let _ = self
                    .commit(
                        &team.session_id,
                        AppendEventInput {
                            event_id: Uuid::new_v4().to_string(),
                            event_type: "system.notice".to_owned(),
                            actor: worktree_actor(),
                            payload: json!({
                                "teamRunId": team.id,
                                "teamTaskId": task.id,
                                "message": error.to_string().chars().take(2_000).collect::<String>(),
                            }),
                        },
                    )
                    .await;
                return "conflicted".to_owned();
            }
        };
        let _ = self
            .record_changes(
                team,
                task,
                &applied.status,
                &applied.changed_paths,
                &applied.conflict_paths,
                applied.patch_bytes as u64,
            )
            .await;
        if applied.status == "applied" || applied.status == "no_changes" {
            self.cleanup_workspace(team, task, workspace, &applied.status)
                .await;
        }
        applied.status
    }

    async fn review_failed_workspace(
        &self,
        team: &TeamRun,
        task: &TeamRunTask,
        workspace: &CreatedWorktree,
    ) -> String {
        let Some(worktrees) = self.worktrees.as_ref() else {
            return "conflicted".to_owned();
        };
        match worktrees.review(
            &workspace.worktree_root,
            &workspace.base_commit,
            &task.allowed_paths,
        ) {
            Ok(review) => {
                let _ = self
                    .record_changes(
                        team,
                        task,
                        &review.status,
                        &review.changed_paths,
                        &review.disallowed_paths,
                        review.patch_bytes as u64,
                    )
                    .await;
                if review.status == "no_changes" {
                    self.cleanup_workspace(team, task, workspace, "no_changes")
                        .await;
                }
                review.status
            }
            Err(_) => "conflicted".to_owned(),
        }
    }

    async fn record_changes(
        &self,
        team: &TeamRun,
        task: &TeamRunTask,
        status: &str,
        changed_paths: &[String],
        conflict_paths: &[String],
        patch_bytes: u64,
    ) -> Result<(), AppError> {
        self.teams
            .record_task_changes(
                task.id.as_str(),
                changed_paths,
                status,
                conflict_paths,
                patch_bytes,
            )
            .await?;
        let event_type = if status == "applied" {
            "team.changes.applied"
        } else if status == "conflicted" || status == "rejected" {
            "team.changes.conflicted"
        } else {
            "team.changes.detected"
        };
        let _ = self
            .commit(
                &team.session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: event_type.to_owned(),
                    actor: worktree_actor(),
                    payload: json!({
                        "teamRunId": team.id,
                        "teamTaskId": task.id,
                        "status": status,
                        "changedPaths": changed_paths,
                        "conflictPaths": conflict_paths,
                        "patchBytes": patch_bytes,
                    }),
                },
            )
            .await;
        Ok(())
    }

    async fn cleanup_workspace(
        &self,
        team: &TeamRun,
        task: &TeamRunTask,
        workspace: &CreatedWorktree,
        outcome: &str,
    ) {
        let Some(worktrees) = self.worktrees.as_ref() else {
            return;
        };
        match worktrees.cleanup(&workspace.worktree_root, &workspace.branch_name, outcome) {
            Ok(_) => {
                let _ = self.teams.clear_task_workspace_root(&task.id).await;
                let _ = self
                    .commit(
                        &team.session_id,
                        AppendEventInput {
                            event_id: Uuid::new_v4().to_string(),
                            event_type: "team.workspace.cleaned".to_owned(),
                            actor: worktree_actor(),
                            payload: json!({
                                "teamRunId": team.id,
                                "teamTaskId": task.id,
                                "outcome": outcome,
                            }),
                        },
                    )
                    .await;
            }
            Err(error) => {
                let _ = self
                    .commit(
                        &team.session_id,
                        AppendEventInput {
                            event_id: Uuid::new_v4().to_string(),
                            event_type: "system.notice".to_owned(),
                            actor: worktree_actor(),
                            payload: json!({
                                "teamRunId": team.id,
                                "teamTaskId": task.id,
                                "message": error.to_string().chars().take(2_000).collect::<String>(),
                            }),
                        },
                    )
                    .await;
            }
        }
    }

    async fn resolve_workspace_task(
        &self,
        team_run_id: &str,
        team_task_id: &str,
    ) -> Result<(TeamRun, TeamRunTask, TeamTaskWorkspace), AppError> {
        let team = self
            .teams
            .get(team_run_id)
            .await?
            .ok_or_else(|| AppError::team_run_not_found("Team run not found"))?;
        let task = team
            .tasks
            .iter()
            .find(|candidate| candidate.id == team_task_id)
            .cloned()
            .ok_or_else(|| AppError::team_task_not_found("Team task not found"))?;
        let workspace = self
            .teams
            .get_task_workspace(team_task_id)
            .await?
            .ok_or_else(|| AppError::team_task_not_found("Team task not found"))?;
        if workspace.team_run_id != team_run_id {
            return Err(AppError::team_task_not_found("Team task not found"));
        }
        Ok((team, task, workspace))
    }

    async fn commit(
        &self,
        session_id: &str,
        input: AppendEventInput,
    ) -> Result<crate::models::SessionEvent, AppError> {
        let event = self.sessions.append_event(session_id, input).await?;
        self.event_hub.publish(event.clone()).await;
        Ok(event)
    }
}

fn worktree_actor() -> Actor {
    Actor {
        kind: "system".into(),
        id: "team-worktree".into(),
        label: "Team Worktree".into(),
    }
}

fn validate_create_input(input: CreateTeamRunInput) -> Result<CreateTeamRunInput, AppError> {
    let goal = input.goal.trim().to_owned();
    if goal.is_empty() || goal.chars().count() > 12_000 {
        return Err(AppError::invalid_request("goal is invalid"));
    }
    if input.agent_ids.is_empty() || input.agent_ids.len() > 8 {
        return Err(AppError::invalid_request(
            "agentIds must contain between 1 and 8 agents",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for agent_id in &input.agent_ids {
        if Uuid::parse_str(agent_id).is_err() {
            return Err(AppError::invalid_request("agentIds must be UUIDs"));
        }
        if !seen.insert(agent_id.clone()) {
            return Err(AppError::invalid_request("Agent IDs must be unique"));
        }
    }
    let max_concurrency = input.max_concurrency.clamp(1, 4);
    let workspace_mode = input.workspace_mode.trim().to_owned();
    if workspace_mode != "readonly" && workspace_mode != "worktree" {
        return Err(AppError::invalid_request("workspaceMode is invalid"));
    }
    let merge_strategy = input.merge_strategy.trim().to_owned();
    if merge_strategy != "manual" && merge_strategy != "auto" {
        return Err(AppError::invalid_request("mergeStrategy is invalid"));
    }

    let path_assignments = if workspace_mode == "readonly" {
        if !input.path_assignments.is_empty() {
            return Err(AppError::invalid_request(
                "Readonly teams cannot assign writable paths",
            ));
        }
        if merge_strategy != "manual" {
            return Err(AppError::invalid_request(
                "Readonly teams must use manual merge strategy",
            ));
        }
        Vec::new()
    } else {
        validate_worktree_path_assignments(&input.agent_ids, &input.path_assignments)?
    };

    Ok(CreateTeamRunInput {
        goal,
        agent_ids: input.agent_ids,
        max_concurrency,
        workspace_mode,
        merge_strategy,
        path_assignments,
    })
}

fn validate_worktree_path_assignments(
    agent_ids: &[String],
    assignments: &[TeamPathAssignment],
) -> Result<Vec<TeamPathAssignment>, AppError> {
    if assignments.len() != agent_ids.len() {
        return Err(AppError::invalid_request(
            "Worktree teams require exactly one path assignment for every selected Agent",
        ));
    }
    let selected = agent_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let mut assigned_agents = std::collections::HashSet::new();
    let mut normalized_assignments = Vec::with_capacity(assignments.len());
    let mut owned_paths: Vec<(String, String)> = Vec::new();

    for assignment in assignments {
        if Uuid::parse_str(&assignment.agent_id).is_err() {
            return Err(AppError::invalid_request(
                "pathAssignments.agentId must be a UUID",
            ));
        }
        if !selected.contains(&assignment.agent_id) {
            return Err(AppError::invalid_request(
                "Worktree teams require exactly one path assignment for every selected Agent",
            ));
        }
        if !assigned_agents.insert(assignment.agent_id.clone()) {
            return Err(AppError::invalid_request(
                "Worktree teams require exactly one path assignment for every selected Agent",
            ));
        }
        if assignment.paths.is_empty() || assignment.paths.len() > 64 {
            return Err(AppError::invalid_request(
                "Each path assignment must include between 1 and 64 paths",
            ));
        }
        let mut path_keys = std::collections::HashSet::new();
        let mut paths = Vec::with_capacity(assignment.paths.len());
        for raw in &assignment.paths {
            let path = normalize_owned_path(raw)?;
            validate_safe_owned_path(&path)?;
            if !path_keys.insert(path_key(&path)) {
                return Err(AppError::invalid_request("Assigned paths must be unique"));
            }
            owned_paths.push((assignment.agent_id.clone(), path.clone()));
            paths.push(path);
        }
        normalized_assignments.push(TeamPathAssignment {
            agent_id: assignment.agent_id.clone(),
            paths,
        });
    }

    for left in 0..owned_paths.len() {
        for right in (left + 1)..owned_paths.len() {
            if owned_paths[left].0 == owned_paths[right].0 {
                continue;
            }
            if paths_overlap(&owned_paths[left].1, &owned_paths[right].1) {
                return Err(AppError::invalid_request(format!(
                    "Assigned paths overlap across Agents: {} and {}",
                    owned_paths[left].1, owned_paths[right].1
                )));
            }
        }
    }

    Ok(normalized_assignments)
}

fn normalize_owned_path(value: &str) -> Result<String, AppError> {
    let mut collapsed = String::new();
    for ch in value.trim().replace('\\', "/").chars() {
        if ch == '/' && collapsed.ends_with('/') {
            continue;
        }
        collapsed.push(ch);
    }
    let collapsed = collapsed.trim_end_matches('/').to_owned();
    if collapsed.is_empty() {
        return Err(AppError::invalid_request(
            "Path must be a safe workspace-relative path",
        ));
    }
    Ok(collapsed)
}

fn validate_safe_owned_path(value: &str) -> Result<(), AppError> {
    if value.starts_with('/')
        || (value.len() >= 2 && value.as_bytes()[1] == b':')
        || value.split('/').any(|segment| {
            segment == "." || segment == ".." || segment == ".git" || segment.is_empty()
        })
    {
        return Err(AppError::invalid_request(
            "Path must be a safe workspace-relative path",
        ));
    }
    if value.chars().count() > 2_048 {
        return Err(AppError::invalid_request(
            "Path must be a safe workspace-relative path",
        ));
    }
    Ok(())
}

fn path_key(value: &str) -> String {
    value.replace('\\', "/").to_ascii_lowercase()
}

fn paths_overlap(first: &str, second: &str) -> bool {
    let left = path_key(first);
    let right = path_key(second);
    left == right
        || left.starts_with(&format!("{right}/"))
        || right.starts_with(&format!("{left}/"))
}

fn paths_for_agent(assignments: &[TeamPathAssignment], agent_id: &str) -> Vec<String> {
    assignments
        .iter()
        .find(|item| item.agent_id == agent_id)
        .map(|item| item.paths.clone())
        .unwrap_or_default()
}

fn build_task_prompt(
    goal: &str,
    agent: &AgentProfile,
    workspace_mode: &str,
    allowed_paths: &[String],
) -> String {
    let role = if agent.description.trim().is_empty() {
        agent.name.as_str()
    } else {
        agent.description.trim()
    };
    let workspace_instruction = if workspace_mode == "worktree" {
        format!(
            "Your filesystem tools are bound to an isolated Git worktree. Only change these assigned paths: {}. Changes outside those paths are rejected and will never be applied to the parent workspace.",
            allowed_paths.join(", ")
        )
    } else {
        "This is a read-only task. You do not have write_file or shell_command capability."
            .to_owned()
    };
    [
        format!("Team goal: {goal}"),
        format!("Assigned role: {} — {role}", agent.name),
        "Work independently in your isolated context. Return concrete evidence and a concise result for the parent task.".to_owned(),
        workspace_instruction,
        "Use send_team_message/read_team_messages for Agent communication. Do not use workspace files as a message channel.".to_owned(),
    ]
    .join("\n\n")
}

fn status_event(
    task: &TeamRunTask,
    team_run_id: &str,
    status: &str,
    extra: serde_json::Value,
) -> AppendEventInput {
    let mut payload = json!({
        "teamRunId": team_run_id,
        "teamTaskId": task.id,
        "agentId": task.agent_id,
        "agentLabel": task.agent_label,
        "status": status,
    });
    if let Some(map) = extra.as_object() {
        for (key, value) in map {
            payload[key] = value.clone();
        }
    }
    AppendEventInput {
        event_id: Uuid::new_v4().to_string(),
        event_type: "agent.status".to_owned(),
        actor: Actor {
            kind: "agent".into(),
            id: task.agent_id.clone(),
            label: task.agent_label.clone(),
        },
        payload,
    }
}
