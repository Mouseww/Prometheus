import { randomUUID } from "node:crypto";
import {
  createTeamRunSchema,
  type AgentProfile,
  type AgentRunResult,
  type CreateTeamRunInput,
  type SessionEvent,
  type TeamChangeStatus,
  type TeamRun,
  type TeamRunTask,
} from "@prometheus/protocol";
import type { AgentRepository } from "./agent-repository.js";
import type { AgentTaskMetadata } from "./agent-run-service.js";
import type { EventHub } from "./event-hub.js";
import type { SessionRepository } from "./session-repository.js";
import type { TeamRunRepository } from "./team-run-repository.js";
import type { CreatedWorktree, GitWorktreeManager } from "./git-worktree-manager.js";

interface AgentTaskRunner {
  runTask(
    sessionId: string,
    agentId: string,
    task: string,
    metadata: AgentTaskMetadata,
  ): Promise<AgentRunResult>;
}

export class TeamRunService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly agents: AgentRepository,
    private readonly teams: TeamRunRepository,
    private readonly agentRuns: AgentTaskRunner,
    private readonly eventHub: EventHub,
    private readonly worktrees?: GitWorktreeManager,
  ) {}

  async start(sessionId: string, rawInput: CreateTeamRunInput): Promise<TeamRun> {
    const { team, input } = this.#create(sessionId, rawInput);
    await this.#execute(team, input);
    return this.teams.get(team.id)!;
  }

  launch(sessionId: string, rawInput: CreateTeamRunInput): TeamRun {
    const { team, input } = this.#create(sessionId, rawInput);
    void this.#execute(team, input).catch((error) => {
      this.teams.completeRun(team.id, "failed");
      this.#commit(sessionId, {
        eventId: randomUUID(),
        type: "system.notice",
        actor: { kind: "system", id: "team-runtime", label: "Team Runtime" },
        payload: {
          teamRunId: team.id,
          message: error instanceof Error ? error.message.slice(0, 2_000) : "Team execution failed",
        },
      });
    });
    return team;
  }

  applyTaskChanges(teamRunId: string, teamTaskId: string): TeamRun {
    const { team, task, workspace } = this.#resolveWorkspaceTask(teamRunId, teamTaskId);
    if (!["pending", "conflicted", "rejected"].includes(workspace.changeStatus)) {
      throw new TeamRunConflictError(`Task changes cannot be applied from ${workspace.changeStatus}`);
    }
    if (!this.worktrees || !workspace.worktreeRoot || !workspace.worktreeBranch || !workspace.baseCommit) {
      throw new TeamRunConflictError("Task worktree is not available");
    }
    const result = this.worktrees.apply(
      workspace.worktreeRoot,
      workspace.baseCommit,
      workspace.allowedPaths,
    );
    this.#recordChanges(
      team,
      task,
      result.status,
      result.changedPaths,
      result.conflictPaths,
      result.patchBytes,
    );
    if (result.status === "applied" || result.status === "no_changes") {
      this.#cleanupWorkspace(team, task, {
        repoRoot: "",
        workspaceRoot: "",
        worktreeRoot: workspace.worktreeRoot,
        branchName: workspace.worktreeBranch,
        baseCommit: workspace.baseCommit,
      }, result.status);
    }
    return this.teams.get(teamRunId)!;
  }

  discardTaskChanges(teamRunId: string, teamTaskId: string): TeamRun {
    const { team, task, workspace } = this.#resolveWorkspaceTask(teamRunId, teamTaskId);
    if (!["isolated", "pending", "conflicted", "rejected"].includes(workspace.changeStatus)) {
      throw new TeamRunConflictError(`Task changes cannot be discarded from ${workspace.changeStatus}`);
    }
    if (!this.worktrees || !workspace.worktreeRoot || !workspace.worktreeBranch) {
      throw new TeamRunConflictError("Task worktree is not available");
    }
    this.worktrees.cleanup({
      worktreeRoot: workspace.worktreeRoot,
      branchName: workspace.worktreeBranch,
      outcome: "discarded",
    });
    this.teams.recordTaskChanges(task.id, {
      changedPaths: workspace.changedPaths,
      changeStatus: "discarded",
      conflictPaths: [],
      patchBytes: workspace.patchBytes,
    });
    this.teams.clearTaskWorkspaceRoot(task.id);
    this.#commit(team.sessionId, {
      eventId: randomUUID(),
      type: "team.workspace.discarded",
      actor: { kind: "system", id: "team-worktree", label: "Team Worktree" },
      payload: {
        teamRunId: team.id,
        teamTaskId: task.id,
        changedPaths: workspace.changedPaths,
      },
    });
    this.#commit(team.sessionId, {
      eventId: randomUUID(),
      type: "team.workspace.cleaned",
      actor: { kind: "system", id: "team-worktree", label: "Team Worktree" },
      payload: { teamRunId: team.id, teamTaskId: task.id, outcome: "discarded" },
    });
    return this.teams.get(teamRunId)!;
  }

  reconcileInterruptedWorkspaces(): number {
    if (!this.worktrees) return 0;
    const records = this.teams.listTaskWorkspaces("isolated");
    for (const workspace of records) {
      const team = this.teams.get(workspace.teamRunId);
      const task = team?.tasks.find((candidate) => candidate.id === workspace.taskId);
      if (!team || !task || !workspace.worktreeRoot || !workspace.worktreeBranch || !workspace.baseCommit) continue;
      try {
        const review = this.worktrees.review(
          workspace.worktreeRoot,
          workspace.baseCommit,
          workspace.allowedPaths,
        );
        this.#recordChanges(
          team,
          task,
          review.status,
          review.changedPaths,
          review.disallowedPaths,
          review.patchBytes,
        );
        if (review.status === "no_changes") {
          this.#cleanupWorkspace(team, task, {
            repoRoot: "",
            workspaceRoot: "",
            worktreeRoot: workspace.worktreeRoot,
            branchName: workspace.worktreeBranch,
            baseCommit: workspace.baseCommit,
          }, "no_changes");
        }
      } catch (error) {
        this.teams.recordTaskChanges(task.id, {
          changedPaths: workspace.changedPaths,
          changeStatus: "conflicted",
          conflictPaths: workspace.conflictPaths,
          patchBytes: workspace.patchBytes,
        });
        this.#commit(team.sessionId, {
          eventId: randomUUID(),
          type: "team.changes.conflicted",
          actor: { kind: "system", id: "team-worktree", label: "Team Worktree" },
          payload: {
            teamRunId: team.id,
            teamTaskId: task.id,
            message: error instanceof Error ? error.message.slice(0, 2_000) : "Interrupted worktree audit failed",
          },
        });
      }
    }
    return records.length;
  }

  #resolveWorkspaceTask(teamRunId: string, teamTaskId: string) {
    const team = this.teams.get(teamRunId);
    if (!team) throw new TeamRunTaskNotFoundError("Team run not found");
    const task = team.tasks.find((candidate) => candidate.id === teamTaskId);
    const workspace = this.teams.getTaskWorkspace(teamTaskId);
    if (!task || !workspace || workspace.teamRunId !== teamRunId) {
      throw new TeamRunTaskNotFoundError("Team task not found");
    }
    return { team, task, workspace };
  }

  #create(sessionId: string, rawInput: CreateTeamRunInput) {
    if (!this.sessions.getSession(sessionId)) throw new TeamRunValidationError("Session not found");
    const input = createTeamRunSchema.parse(rawInput);
    const agents = input.agentIds.map((agentId) => {
      const agent = this.agents.get(agentId);
      if (!agent) throw new TeamRunValidationError(`Agent not found: ${agentId}`);
      return agent;
    });
    const team = this.teams.create({
      sessionId,
      goal: input.goal,
      maxConcurrency: Math.min(input.maxConcurrency, agents.length),
      workspaceMode: input.workspaceMode,
      mergeStrategy: input.mergeStrategy,
      tasks: agents.map((agent) => ({
        agentId: agent.id,
        agentLabel: agent.name,
        prompt: buildTaskPrompt(
          input.goal,
          agent,
          input.workspaceMode,
          input.pathAssignments.find((assignment) => assignment.agentId === agent.id)?.paths ?? [],
        ),
        allowedPaths: input.pathAssignments.find((assignment) => assignment.agentId === agent.id)?.paths ?? [],
      })),
    });

    for (const task of team.tasks) {
      this.#commit(sessionId, {
        eventId: randomUUID(),
        type: "agent.spawned",
        actor: { kind: "system", id: "team-runtime", label: "Team Runtime" },
        payload: {
          teamRunId: team.id,
          teamTaskId: task.id,
          agentId: task.agentId,
          agentLabel: task.agentLabel,
          prompt: task.prompt,
          status: "queued",
        },
      });
    }

    return { team, input };
  }

  async #execute(
    team: TeamRun,
    input: ReturnType<typeof createTeamRunSchema.parse>,
  ): Promise<void> {
    let nextTask = 0;
    let failed = false;
    const worker = async () => {
      while (true) {
        const task = team.tasks[nextTask++];
        if (!task) return;
        const succeeded = await this.#runTask(team, task, input.mergeStrategy);
        failed ||= !succeeded;
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(team.maxConcurrency, team.tasks.length) },
      () => worker(),
    ));
    this.teams.completeRun(team.id, failed ? "failed" : "completed");
  }

  async #runTask(
    team: TeamRun,
    task: TeamRunTask,
    mergeStrategy: "manual" | "auto",
  ): Promise<boolean> {
    this.teams.markTaskRunning(task.id);
    this.#commit(team.sessionId, statusEvent(task, team.id, "running"));
    let workspace: CreatedWorktree | undefined;
    if (team.workspaceMode === "worktree") {
      try {
        if (!this.worktrees) throw new Error("Git worktree runtime is not configured");
        workspace = this.worktrees.create({ taskId: task.id, label: task.agentLabel });
        this.teams.setTaskWorkspace(task.id, {
          worktreeRoot: workspace.worktreeRoot,
          worktreeBranch: workspace.branchName,
          baseCommit: workspace.baseCommit,
        });
        this.#commit(team.sessionId, {
          eventId: randomUUID(),
          type: "team.workspace.created",
          actor: { kind: "system", id: "team-worktree", label: "Team Worktree" },
          payload: {
            teamRunId: team.id,
            teamTaskId: task.id,
            agentId: task.agentId,
            branchName: workspace.branchName,
            baseCommit: workspace.baseCommit,
            allowedPaths: task.allowedPaths,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 2_000) : "Worktree creation failed";
        this.teams.failTask(task.id, message);
        this.#commit(team.sessionId, statusEvent(task, team.id, "failed", { message }));
        return false;
      }
    }

    let result: AgentRunResult;
    try {
      result = await this.agentRuns.runTask(
        team.sessionId,
        task.agentId,
        task.prompt,
        {
          teamRunId: team.id,
          teamTaskId: task.id,
          workspaceMode: team.workspaceMode,
          workspaceRoot: workspace?.workspaceRoot,
          allowedPaths: task.allowedPaths,
        },
      );
    } catch (error) {
      const changeStatus = workspace ? this.#reviewFailedWorkspace(team, task, workspace) : "not_applicable";
      const message = error instanceof Error ? error.message.slice(0, 2_000) : "Subagent task failed";
      this.teams.failTask(task.id, message);
      this.#commit(team.sessionId, statusEvent(task, team.id, "failed", { message, changeStatus }));
      return false;
    }

    const output = typeof result.replyEvent.payload.text === "string"
      ? result.replyEvent.payload.text.slice(0, 1_000_000)
      : "";
    this.teams.completeTask(task.id, output);
    let changeStatus: TeamChangeStatus = "not_applicable";
    let integrationSucceeded = true;
    if (workspace) {
      try {
        changeStatus = this.#finalizeWorkspace(team, task, workspace, mergeStrategy);
        integrationSucceeded = changeStatus !== "conflicted" && changeStatus !== "rejected";
      } catch (error) {
        changeStatus = "conflicted";
        integrationSucceeded = false;
        this.teams.recordTaskChanges(task.id, {
          changedPaths: [],
          changeStatus,
          conflictPaths: [],
          patchBytes: 0,
        });
        this.#commit(team.sessionId, {
          eventId: randomUUID(),
          type: "team.changes.conflicted",
          actor: { kind: "system", id: "team-worktree", label: "Team Worktree" },
          payload: {
            teamRunId: team.id,
            teamTaskId: task.id,
            message: error instanceof Error ? error.message.slice(0, 2_000) : "Change integration failed",
          },
        });
      }
    }
    this.#commit(team.sessionId, statusEvent(task, team.id, "completed", {
      runId: result.runId,
      summary: output.slice(0, 1_000),
      outputTruncated: output.length > 1_000,
      changeStatus,
    }));
    return integrationSucceeded;
  }

  #finalizeWorkspace(
    team: TeamRun,
    task: TeamRunTask,
    workspace: CreatedWorktree,
    mergeStrategy: "manual" | "auto",
  ): TeamChangeStatus {
    if (!this.worktrees) throw new Error("Git worktree runtime is not configured");
    if (mergeStrategy === "manual") {
      const review = this.worktrees.review(workspace.worktreeRoot, workspace.baseCommit, task.allowedPaths);
      const status: TeamChangeStatus = review.status;
      this.#recordChanges(team, task, status, review.changedPaths, review.disallowedPaths, review.patchBytes);
      if (status === "no_changes") this.#cleanupWorkspace(team, task, workspace, "no_changes");
      return status;
    }

    const applied = this.worktrees.apply(workspace.worktreeRoot, workspace.baseCommit, task.allowedPaths);
    this.#recordChanges(
      team,
      task,
      applied.status,
      applied.changedPaths,
      applied.conflictPaths,
      applied.patchBytes,
    );
    if (applied.status === "applied" || applied.status === "no_changes") {
      this.#cleanupWorkspace(team, task, workspace, applied.status);
    }
    return applied.status;
  }

  #reviewFailedWorkspace(team: TeamRun, task: TeamRunTask, workspace: CreatedWorktree): TeamChangeStatus {
    if (!this.worktrees) return "conflicted";
    try {
      const review = this.worktrees.review(workspace.worktreeRoot, workspace.baseCommit, task.allowedPaths);
      const status: TeamChangeStatus = review.status;
      this.#recordChanges(team, task, status, review.changedPaths, review.disallowedPaths, review.patchBytes);
      if (status === "no_changes") this.#cleanupWorkspace(team, task, workspace, "no_changes");
      return status;
    } catch {
      return "conflicted";
    }
  }

  #recordChanges(
    team: TeamRun,
    task: TeamRunTask,
    status: TeamChangeStatus,
    changedPaths: string[],
    conflictPaths: string[],
    patchBytes: number,
  ): void {
    this.teams.recordTaskChanges(task.id, {
      changedPaths,
      changeStatus: status,
      conflictPaths,
      patchBytes,
    });
    const eventType = status === "applied"
      ? "team.changes.applied"
      : status === "conflicted" || status === "rejected"
        ? "team.changes.conflicted"
        : "team.changes.detected";
    this.#commit(team.sessionId, {
      eventId: randomUUID(),
      type: eventType,
      actor: { kind: "system", id: "team-worktree", label: "Team Worktree" },
      payload: {
        teamRunId: team.id,
        teamTaskId: task.id,
        status,
        changedPaths,
        conflictPaths,
        patchBytes,
      },
    });
  }

  #cleanupWorkspace(
    team: TeamRun,
    task: TeamRunTask,
    workspace: CreatedWorktree,
    outcome: "applied" | "no_changes",
  ): void {
    if (!this.worktrees) return;
    try {
      this.worktrees.cleanup({
        worktreeRoot: workspace.worktreeRoot,
        branchName: workspace.branchName,
        outcome,
      });
      this.teams.clearTaskWorkspaceRoot(task.id);
      this.#commit(team.sessionId, {
        eventId: randomUUID(),
        type: "team.workspace.cleaned",
        actor: { kind: "system", id: "team-worktree", label: "Team Worktree" },
        payload: { teamRunId: team.id, teamTaskId: task.id, outcome },
      });
    } catch (error) {
      this.#commit(team.sessionId, {
        eventId: randomUUID(),
        type: "system.notice",
        actor: { kind: "system", id: "team-worktree", label: "Team Worktree" },
        payload: {
          teamRunId: team.id,
          teamTaskId: task.id,
          message: error instanceof Error ? error.message.slice(0, 2_000) : "Worktree cleanup failed",
        },
      });
    }
  }

  #commit(
    sessionId: string,
    input: Parameters<SessionRepository["appendEvent"]>[1],
  ): SessionEvent {
    const event = this.sessions.appendEvent(sessionId, input);
    this.eventHub.publish(event);
    return event;
  }
}

export class TeamRunValidationError extends Error {}
export class TeamRunTaskNotFoundError extends Error {}
export class TeamRunConflictError extends Error {}

function buildTaskPrompt(
  goal: string,
  agent: AgentProfile,
  workspaceMode: "readonly" | "worktree",
  allowedPaths: string[],
): string {
  const role = agent.description.trim() || agent.name;
  const workspaceInstruction = workspaceMode === "worktree"
    ? [
        "Your filesystem tools are bound to an isolated Git worktree.",
        `Only change these assigned paths: ${allowedPaths.join(", ")}.`,
        "Changes outside those paths are rejected and will never be applied to the parent workspace.",
      ].join(" ")
    : "This is a read-only task. You do not have write_file or shell_command capability.";
  return [
    `Team goal: ${goal}`,
    `Assigned role: ${agent.name} — ${role}`,
    "Work independently in your isolated context. Return concrete evidence and a concise result for the parent task.",
    workspaceInstruction,
    "Use send_team_message/read_team_messages for Agent communication. Do not use workspace files as a message channel.",
  ].join("\n\n");
}

function statusEvent(
  task: TeamRunTask,
  teamRunId: string,
  status: "running" | "completed" | "failed",
  extra: Record<string, unknown> = {},
): Parameters<SessionRepository["appendEvent"]>[1] {
  return {
    eventId: randomUUID(),
    type: "agent.status",
    actor: { kind: "agent", id: task.agentId, label: task.agentLabel },
    payload: {
      teamRunId,
      teamTaskId: task.id,
      agentId: task.agentId,
      agentLabel: task.agentLabel,
      status,
      ...extra,
    },
  };
}
