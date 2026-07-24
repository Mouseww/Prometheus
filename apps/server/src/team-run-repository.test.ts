import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "./agent-repository.js";
import { openDatabase } from "./database.js";
import { ProviderRepository } from "./provider-repository.js";
import { SecretVault } from "./secret-vault.js";
import { SessionRepository } from "./session-repository.js";
import { TeamRunRepository } from "./team-run-repository.js";

const databases = [] as ReturnType<typeof openDatabase>[];
const tempRoots: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TeamRunRepository", () => {
  it("persists a team roster, task lifecycle and terminal outputs", () => {
    const fixture = createFixture();
    const team = fixture.teams.create({
      sessionId: fixture.sessionId,
      goal: "Review the runtime",
      maxConcurrency: 2,
      workspaceMode: "worktree",
      mergeStrategy: "manual",
      tasks: fixture.agentIds.map((agentId, index) => ({
        agentId,
        agentLabel: `Agent ${index + 1}`,
        prompt: `Review as role ${index + 1}`,
        allowedPaths: [`packages/area-${index + 1}`],
      })),
    });

    expect(team.status).toBe("running");
    expect(team).toMatchObject({ workspaceMode: "worktree", mergeStrategy: "manual" });
    expect(team.tasks.map((task) => task.status)).toEqual(["queued", "queued"]);
    expect(team.tasks.map((task) => task.allowedPaths)).toEqual([
      ["packages/area-1"],
      ["packages/area-2"],
    ]);
    fixture.teams.setTaskWorkspace(team.tasks[0]!.id, {
      worktreeRoot: "C:/runtime/worktrees/one",
      worktreeBranch: `prometheus/team/${team.tasks[0]!.id}`,
      baseCommit: "a".repeat(40),
    });
    fixture.teams.recordTaskChanges(team.tasks[0]!.id, {
      changedPaths: ["packages/area-1/index.ts"],
      changeStatus: "pending",
      conflictPaths: [],
      patchBytes: 321,
    });
    fixture.teams.markTaskRunning(team.tasks[0]!.id);
    fixture.teams.completeTask(team.tasks[0]!.id, "Evidence found");
    fixture.teams.failTask(team.tasks[1]!.id, "Provider unavailable");
    fixture.teams.completeRun(team.id, "failed");

    expect(fixture.teams.get(team.id)).toMatchObject({
      status: "failed",
      tasks: [
        {
          status: "completed",
          output: "Evidence found",
          error: null,
          worktreeBranch: `prometheus/team/${team.tasks[0]!.id}`,
          baseCommit: "a".repeat(40),
          changedPaths: ["packages/area-1/index.ts"],
          changeStatus: "pending",
          patchBytes: 321,
        },
        { status: "failed", output: null, error: "Provider unavailable" },
      ],
    });
    expect(fixture.teams.getTaskWorkspace(team.tasks[0]!.id)).toMatchObject({
      worktreeRoot: "C:/runtime/worktrees/one",
      worktreeBranch: `prometheus/team/${team.tasks[0]!.id}`,
    });
    expect(fixture.teams.listForSession(fixture.sessionId)).toHaveLength(1);
  });

  it("marks unfinished teams and tasks interrupted instead of replaying them", () => {
    const fixture = createFixture();
    const team = fixture.teams.create({
      sessionId: fixture.sessionId,
      goal: "Interrupted work",
      maxConcurrency: 1,
      workspaceMode: "readonly",
      mergeStrategy: "manual",
      tasks: [{
        agentId: fixture.agentIds[0]!,
        agentLabel: "Agent 1",
        prompt: "Keep state explicit",
        allowedPaths: [],
      }],
    });
    fixture.teams.markTaskRunning(team.tasks[0]!.id);

    expect(fixture.teams.recoverInterrupted()).toBe(1);
    expect(fixture.teams.get(team.id)).toMatchObject({
      status: "interrupted",
      tasks: [{ status: "interrupted", completedAt: expect.any(String) }],
    });
  });

  it("adds 3C workspace columns when opening a legacy 3B database", () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-legacy-team-"));
    tempRoots.push(root);
    const filename = join(root, "legacy.db");
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE team_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL, max_concurrency INTEGER NOT NULL,
        created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE team_run_tasks (
        id TEXT PRIMARY KEY, team_run_id TEXT NOT NULL, session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL, agent_label TEXT NOT NULL, prompt TEXT NOT NULL,
        ordinal INTEGER NOT NULL, status TEXT NOT NULL, output TEXT, error TEXT,
        created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
      );
    `);
    legacy.close();

    const database = openDatabase(filename);
    databases.push(database);
    const runColumns = (database.prepare("PRAGMA table_info(team_runs)").all() as Array<{ name: string }>).map((column) => column.name);
    const taskColumns = (database.prepare("PRAGMA table_info(team_run_tasks)").all() as Array<{ name: string }>).map((column) => column.name);

    expect(runColumns).toEqual(expect.arrayContaining(["workspace_mode", "merge_strategy"]));
    expect(taskColumns).toEqual(expect.arrayContaining([
      "allowed_paths_json",
      "worktree_root",
      "worktree_branch",
      "base_commit",
      "changed_paths_json",
      "change_status",
      "conflict_paths_json",
      "patch_bytes",
    ]));
  });
});

function createFixture() {
  const database = openDatabase(":memory:");
  databases.push(database);
  const sessions = new SessionRepository(database);
  const providers = new ProviderRepository(database, new SecretVault(randomBytes(32)));
  const agents = new AgentRepository(database);
  const provider = providers.create({
    name: "Provider",
    kind: "openai",
    defaultModel: "model",
    apiKey: "secret",
  });
  const agentIds = ["Agent 1", "Agent 2"].map((name) => agents.create({
    name,
    description: `${name} role`,
    systemPrompt: `Act as ${name}`,
    providerId: provider.id,
    model: "model",
  }).id);
  return {
    teams: new TeamRunRepository(database),
    sessionId: sessions.createSession("Team test").id,
    agentIds,
  };
}
