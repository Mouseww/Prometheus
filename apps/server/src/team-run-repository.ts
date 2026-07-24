import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  teamChangeStatusSchema,
  teamOwnedPathSchema,
  teamRunSchema,
  teamRunTaskSchema,
  type TeamChangeStatus,
  type TeamMergeStrategy,
  type TeamRun,
  type TeamRunTask,
  type TeamWorkspaceMode,
} from "@prometheus/protocol";
import { z } from "zod";

interface TeamRunRow {
  id: string;
  session_id: string;
  goal: string;
  status: string;
  max_concurrency: number;
  workspace_mode: string;
  merge_strategy: string;
  created_at: string;
  completed_at: string | null;
}

interface TeamTaskRow {
  id: string;
  team_run_id: string;
  session_id: string;
  agent_id: string;
  agent_label: string;
  prompt: string;
  status: string;
  output: string | null;
  error: string | null;
  allowed_paths_json: string;
  worktree_root: string | null;
  worktree_branch: string | null;
  base_commit: string | null;
  changed_paths_json: string;
  change_status: string;
  conflict_paths_json: string;
  patch_bytes: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CreateTeamRunRecord {
  sessionId: string;
  goal: string;
  maxConcurrency: number;
  workspaceMode?: TeamWorkspaceMode;
  mergeStrategy?: TeamMergeStrategy;
  tasks: Array<{
    agentId: string;
    agentLabel: string;
    prompt: string;
    allowedPaths?: string[];
  }>;
}

export interface TeamTaskWorkspaceRecord {
  taskId: string;
  teamRunId: string;
  sessionId: string;
  agentId: string;
  allowedPaths: string[];
  worktreeRoot: string | null;
  worktreeBranch: string | null;
  baseCommit: string | null;
  changedPaths: string[];
  changeStatus: TeamChangeStatus;
  conflictPaths: string[];
  patchBytes: number;
}

const storedPathsSchema = z.array(teamOwnedPathSchema).max(2_000);

export class TeamRunRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: CreateTeamRunRecord): TeamRun {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO team_runs (
          id, session_id, goal, status, max_concurrency, workspace_mode,
          merge_strategy, created_at, completed_at
        ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, NULL)
      `).run(
        id,
        input.sessionId,
        input.goal,
        input.maxConcurrency,
        input.workspaceMode ?? "readonly",
        input.mergeStrategy ?? "manual",
        createdAt,
      );
      const insertTask = this.database.prepare(`
        INSERT INTO team_run_tasks (
          id, team_run_id, session_id, agent_id, agent_label, prompt, ordinal,
          status, output, error, allowed_paths_json, worktree_root, worktree_branch,
          base_commit, changed_paths_json, change_status, conflict_paths_json,
          patch_bytes, created_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, NULL, NULL,
          NULL, '[]', 'not_applicable', '[]', 0, ?, NULL, NULL)
      `);
      input.tasks.forEach((task, index) => {
        insertTask.run(
          randomUUID(),
          id,
          input.sessionId,
          task.agentId,
          task.agentLabel,
          task.prompt,
          index,
          JSON.stringify(task.allowedPaths ?? []),
          createdAt,
        );
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.get(id)!;
  }

  get(id: string): TeamRun | undefined {
    const row = this.database.prepare("SELECT * FROM team_runs WHERE id = ?").get(id) as unknown as TeamRunRow | undefined;
    return row ? this.#mapRun(row) : undefined;
  }

  listForSession(sessionId: string): TeamRun[] {
    return (this.database.prepare(`
      SELECT * FROM team_runs WHERE session_id = ? ORDER BY created_at DESC, id DESC
    `).all(sessionId) as unknown as TeamRunRow[]).map((row) => this.#mapRun(row));
  }

  markTaskRunning(taskId: string): void {
    this.database.prepare(`
      UPDATE team_run_tasks
      SET status = 'running', started_at = ?, completed_at = NULL, output = NULL, error = NULL
      WHERE id = ? AND status = 'queued'
    `).run(new Date().toISOString(), taskId);
  }

  setTaskWorkspace(
    taskId: string,
    input: { worktreeRoot: string; worktreeBranch: string; baseCommit: string },
  ): void {
    this.database.prepare(`
      UPDATE team_run_tasks
      SET worktree_root = ?, worktree_branch = ?, base_commit = ?,
          change_status = 'isolated', changed_paths_json = '[]',
          conflict_paths_json = '[]', patch_bytes = 0
      WHERE id = ?
    `).run(input.worktreeRoot, input.worktreeBranch, input.baseCommit, taskId);
  }

  recordTaskChanges(
    taskId: string,
    input: {
      changedPaths: string[];
      changeStatus: TeamChangeStatus;
      conflictPaths: string[];
      patchBytes: number;
    },
  ): void {
    const changedPaths = storedPathsSchema.parse(input.changedPaths);
    const conflictPaths = storedPathsSchema.parse(input.conflictPaths);
    const changeStatus = teamChangeStatusSchema.parse(input.changeStatus);
    this.database.prepare(`
      UPDATE team_run_tasks
      SET changed_paths_json = ?, change_status = ?, conflict_paths_json = ?, patch_bytes = ?
      WHERE id = ?
    `).run(
      JSON.stringify(changedPaths),
      changeStatus,
      JSON.stringify(conflictPaths),
      input.patchBytes,
      taskId,
    );
  }

  clearTaskWorkspaceRoot(taskId: string): void {
    this.database.prepare("UPDATE team_run_tasks SET worktree_root = NULL WHERE id = ?").run(taskId);
  }

  getTaskWorkspace(taskId: string): TeamTaskWorkspaceRecord | undefined {
    const row = this.database.prepare("SELECT * FROM team_run_tasks WHERE id = ?")
      .get(taskId) as unknown as TeamTaskRow | undefined;
    return row ? mapWorkspaceRecord(row) : undefined;
  }

  listTaskWorkspaces(changeStatus?: TeamChangeStatus): TeamTaskWorkspaceRecord[] {
    const rows = changeStatus
      ? this.database.prepare(`
          SELECT * FROM team_run_tasks
          WHERE worktree_root IS NOT NULL AND change_status = ?
          ORDER BY created_at ASC, id ASC
        `).all(changeStatus)
      : this.database.prepare(`
          SELECT * FROM team_run_tasks
          WHERE worktree_root IS NOT NULL
          ORDER BY created_at ASC, id ASC
        `).all();
    return (rows as unknown as TeamTaskRow[]).map(mapWorkspaceRecord);
  }

  completeTask(taskId: string, output: string): void {
    this.database.prepare(`
      UPDATE team_run_tasks
      SET status = 'completed', output = ?, error = NULL, completed_at = ?
      WHERE id = ? AND status = 'running'
    `).run(output, new Date().toISOString(), taskId);
  }

  failTask(taskId: string, error: string): void {
    this.database.prepare(`
      UPDATE team_run_tasks
      SET status = 'failed', output = NULL, error = ?, completed_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(error, new Date().toISOString(), taskId);
  }

  completeRun(teamRunId: string, status: "completed" | "failed"): void {
    this.database.prepare(`
      UPDATE team_runs SET status = ?, completed_at = ? WHERE id = ? AND status = 'running'
    `).run(status, new Date().toISOString(), teamRunId);
  }

  recoverInterrupted(): number {
    const count = Number((this.database.prepare(`
      SELECT COUNT(*) AS count FROM team_run_tasks WHERE status IN ('queued', 'running')
    `).get() as { count: number }).count);
    if (count === 0) return 0;
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE team_run_tasks
        SET status = 'interrupted', error = 'Control Plane restarted before task completion', completed_at = ?
        WHERE status IN ('queued', 'running')
      `).run(now);
      this.database.prepare(`
        UPDATE team_runs SET status = 'interrupted', completed_at = ? WHERE status = 'running'
      `).run(now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return count;
  }

  #mapRun(row: TeamRunRow): TeamRun {
    const tasks = (this.database.prepare(`
      SELECT * FROM team_run_tasks WHERE team_run_id = ? ORDER BY ordinal ASC
    `).all(row.id) as unknown as TeamTaskRow[]).map(mapTask);
    return teamRunSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      goal: row.goal,
      status: row.status,
      maxConcurrency: row.max_concurrency,
      workspaceMode: row.workspace_mode,
      mergeStrategy: row.merge_strategy,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      tasks,
    });
  }
}

function mapTask(row: TeamTaskRow): TeamRunTask {
  return teamRunTaskSchema.parse({
    id: row.id,
    teamRunId: row.team_run_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    agentLabel: row.agent_label,
    prompt: row.prompt,
    status: row.status,
    output: row.output,
    error: row.error,
    allowedPaths: parseStoredPaths(row.allowed_paths_json),
    worktreeBranch: row.worktree_branch,
    baseCommit: row.base_commit,
    changedPaths: parseStoredPaths(row.changed_paths_json),
    changeStatus: row.change_status,
    conflictPaths: parseStoredPaths(row.conflict_paths_json),
    patchBytes: row.patch_bytes,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  });
}

function mapWorkspaceRecord(row: TeamTaskRow): TeamTaskWorkspaceRecord {
  return {
    taskId: row.id,
    teamRunId: row.team_run_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    allowedPaths: parseStoredPaths(row.allowed_paths_json),
    worktreeRoot: row.worktree_root,
    worktreeBranch: row.worktree_branch,
    baseCommit: row.base_commit,
    changedPaths: parseStoredPaths(row.changed_paths_json),
    changeStatus: teamChangeStatusSchema.parse(row.change_status),
    conflictPaths: parseStoredPaths(row.conflict_paths_json),
    patchBytes: row.patch_bytes,
  };
}

function parseStoredPaths(value: string): string[] {
  return storedPathsSchema.parse(JSON.parse(value));
}
