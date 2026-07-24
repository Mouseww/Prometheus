import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentRunResult } from "@prometheus/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRepository } from "./agent-repository.js";
import { openDatabase } from "./database.js";
import { EventHub } from "./event-hub.js";
import { ProviderRepository } from "./provider-repository.js";
import { SecretVault } from "./secret-vault.js";
import { SessionRepository } from "./session-repository.js";
import { TeamRunRepository } from "./team-run-repository.js";
import { TeamRunService } from "./team-run-service.js";
import { GitWorktreeManager } from "./git-worktree-manager.js";

const databases = [] as ReturnType<typeof openDatabase>[];
const tempRoots: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TeamRunService", () => {
  it("runs agents in parallel up to the configured concurrency and persists lifecycle events", async () => {
    const fixture = createFixture(3);
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const runTask = vi.fn(async (_sessionId: string, agentId: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return resultFor(agentId);
    });
    const service = new TeamRunService(
      fixture.sessions,
      fixture.agents,
      fixture.teams,
      { runTask },
      new EventHub(),
    );

    const pending = service.start(fixture.sessionId, {
      goal: "Review the runtime",
      agentIds: fixture.agentIds,
      maxConcurrency: 2,
    });
    await vi.waitFor(() => expect(active).toBe(2));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(3));
    releases.splice(0).forEach((release) => release());
    const team = await pending;

    expect(maximumActive).toBe(2);
    expect(team.status).toBe("completed");
    expect(team.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"]);
    const events = fixture.sessions.listEvents(fixture.sessionId);
    expect(events.filter((event) => event.type === "agent.spawned")).toHaveLength(3);
    expect(events.filter((event) => event.type === "agent.status" && event.payload.status === "running")).toHaveLength(3);
    expect(events.filter((event) => event.type === "agent.status" && event.payload.status === "completed")).toHaveLength(3);
  });

  it("isolates task failure and returns every agent result", async () => {
    const fixture = createFixture(2);
    const failedAgentId = fixture.agentIds[0]!;
    const runTask = vi.fn(async (_sessionId: string, agentId: string) => {
      if (agentId === failedAgentId) throw new Error("provider offline");
      return resultFor(agentId);
    });
    const service = new TeamRunService(
      fixture.sessions,
      fixture.agents,
      fixture.teams,
      { runTask },
      new EventHub(),
    );

    const team = await service.start(fixture.sessionId, {
      goal: "Independent checks",
      agentIds: fixture.agentIds,
      maxConcurrency: 2,
    });

    expect(team.status).toBe("failed");
    expect(team.tasks).toMatchObject([
      { agentId: failedAgentId, status: "failed", error: "provider offline" },
      { agentId: fixture.agentIds[1], status: "completed", output: `result:${fixture.agentIds[1]}` },
    ]);
  });

  it("launches GUI team runs without blocking the caller until providers finish", async () => {
    const fixture = createFixture(1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runTask = vi.fn(async (_sessionId: string, agentId: string) => {
      await gate;
      return resultFor(agentId);
    });
    const service = new TeamRunService(
      fixture.sessions,
      fixture.agents,
      fixture.teams,
      { runTask },
      new EventHub(),
    );

    const launched = service.launch(fixture.sessionId, {
      goal: "Run without blocking the modal",
      agentIds: fixture.agentIds,
      maxConcurrency: 1,
    });

    expect(launched.status).toBe("running");
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1));
    expect(fixture.teams.get(launched.id)?.status).toBe("running");
    release();
    await vi.waitFor(() => expect(fixture.teams.get(launched.id)?.status).toBe("completed"));
  });

  it("re-audits preserved worktrees after interrupted tasks without auto-applying them", () => {
    const fixture = createFixture(1);
    const gitFixture = createGitFixture();
    const manager = new GitWorktreeManager(gitFixture.repoRoot, gitFixture.storageRoot);
    const team = fixture.teams.create({
      sessionId: fixture.sessionId,
      goal: "Recover isolated work",
      maxConcurrency: 1,
      workspaceMode: "worktree",
      mergeStrategy: "auto",
      tasks: [{
        agentId: fixture.agentIds[0]!,
        agentLabel: "Agent 1",
        prompt: "Recover",
        allowedPaths: ["src"],
      }],
    });
    const task = team.tasks[0]!;
    const created = manager.create({ taskId: task.id, label: task.agentLabel });
    fixture.teams.setTaskWorkspace(task.id, {
      worktreeRoot: created.worktreeRoot,
      worktreeBranch: created.branchName,
      baseCommit: created.baseCommit,
    });
    fixture.teams.markTaskRunning(task.id);
    mkdirSync(join(created.workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(created.workspaceRoot, "src", "recovered.txt"), "preserve\n", "utf8");
    fixture.teams.recoverInterrupted();
    const service = new TeamRunService(
      fixture.sessions,
      fixture.agents,
      fixture.teams,
      { runTask: vi.fn() },
      new EventHub(),
      manager,
    );

    expect(service.reconcileInterruptedWorkspaces()).toBe(1);
    expect(fixture.teams.get(team.id)?.tasks[0]).toMatchObject({
      status: "interrupted",
      changeStatus: "pending",
      changedPaths: ["src/recovered.txt"],
    });
    expect(existsSync(join(gitFixture.repoRoot, "src", "recovered.txt"))).toBe(false);
    expect(fixture.teams.getTaskWorkspace(task.id)?.worktreeRoot).toEqual(expect.any(String));
  }, 15_000);

  it("preserves manual worktree changes as a durable pending patch", async () => {
    const fixture = createFixture(1);
    const gitFixture = createGitFixture();
    const runTask = vi.fn(async (_sessionId: string, agentId: string, _task: string, metadata: { workspaceRoot?: string }) => {
      expect(metadata.workspaceRoot).toBeTruthy();
      mkdirSync(join(metadata.workspaceRoot!, "src"), { recursive: true });
      writeFileSync(join(metadata.workspaceRoot!, "src", "result.txt"), "isolated result\n", "utf8");
      return resultFor(agentId);
    });
    const service = new TeamRunService(
      fixture.sessions,
      fixture.agents,
      fixture.teams,
      { runTask },
      new EventHub(),
      new GitWorktreeManager(gitFixture.repoRoot, gitFixture.storageRoot),
    );

    const team = await service.start(fixture.sessionId, {
      goal: "Create an isolated result",
      agentIds: fixture.agentIds,
      maxConcurrency: 1,
      workspaceMode: "worktree",
      mergeStrategy: "manual",
      pathAssignments: [{ agentId: fixture.agentIds[0]!, paths: ["src"] }],
    });

    expect(team.status).toBe("completed");
    expect(team.tasks[0]).toMatchObject({
      changeStatus: "pending",
      changedPaths: ["src/result.txt"],
      patchBytes: expect.any(Number),
      allowedPaths: ["src"],
      worktreeBranch: expect.stringMatching(/^prometheus\/team\//),
    });
    expect(existsSync(join(gitFixture.repoRoot, "src", "result.txt"))).toBe(false);
    expect(fixture.teams.getTaskWorkspace(team.tasks[0]!.id)?.worktreeRoot).toEqual(expect.any(String));

    const applied = service.applyTaskChanges(team.id, team.tasks[0]!.id);
    expect(applied.tasks[0]).toMatchObject({ changeStatus: "applied" });
    expect(existsSync(join(gitFixture.repoRoot, "src", "result.txt"))).toBe(true);
    expect(fixture.teams.getTaskWorkspace(team.tasks[0]!.id)?.worktreeRoot).toBeNull();
  }, 15_000);

  it("discards a preserved isolated patch only through an explicit action", async () => {
    const fixture = createFixture(1);
    const gitFixture = createGitFixture();
    const runTask = vi.fn(async (_sessionId: string, agentId: string, _task: string, metadata: { workspaceRoot?: string }) => {
      mkdirSync(join(metadata.workspaceRoot!, "src"), { recursive: true });
      writeFileSync(join(metadata.workspaceRoot!, "src", "discard.txt"), "discard me\n", "utf8");
      return resultFor(agentId);
    });
    const service = new TeamRunService(
      fixture.sessions,
      fixture.agents,
      fixture.teams,
      { runTask },
      new EventHub(),
      new GitWorktreeManager(gitFixture.repoRoot, gitFixture.storageRoot),
    );
    const team = await service.start(fixture.sessionId, {
      goal: "Create a disposable patch",
      agentIds: fixture.agentIds,
      maxConcurrency: 1,
      workspaceMode: "worktree",
      mergeStrategy: "manual",
      pathAssignments: [{ agentId: fixture.agentIds[0]!, paths: ["src"] }],
    });

    const discarded = service.discardTaskChanges(team.id, team.tasks[0]!.id);

    expect(discarded.tasks[0]).toMatchObject({ changeStatus: "discarded" });
    expect(existsSync(join(gitFixture.repoRoot, "src", "discard.txt"))).toBe(false);
    expect(fixture.teams.getTaskWorkspace(team.tasks[0]!.id)?.worktreeRoot).toBeNull();
    expect(fixture.sessions.listEvents(fixture.sessionId).some((event) => event.type === "team.workspace.discarded")).toBe(true);
  }, 15_000);

  it("auto-applies an allowed worktree patch and cleans its isolated branch", async () => {
    const fixture = createFixture(1);
    const gitFixture = createGitFixture();
    const runTask = vi.fn(async (_sessionId: string, agentId: string, _task: string, metadata: { workspaceRoot?: string }) => {
      mkdirSync(join(metadata.workspaceRoot!, "src"), { recursive: true });
      writeFileSync(join(metadata.workspaceRoot!, "src", "auto.txt"), "auto applied\n", "utf8");
      return resultFor(agentId);
    });
    const service = new TeamRunService(
      fixture.sessions,
      fixture.agents,
      fixture.teams,
      { runTask },
      new EventHub(),
      new GitWorktreeManager(gitFixture.repoRoot, gitFixture.storageRoot),
    );

    const team = await service.start(fixture.sessionId, {
      goal: "Apply a safe isolated change",
      agentIds: fixture.agentIds,
      maxConcurrency: 1,
      workspaceMode: "worktree",
      mergeStrategy: "auto",
      pathAssignments: [{ agentId: fixture.agentIds[0]!, paths: ["src"] }],
    });

    expect(team.status).toBe("completed");
    expect(team.tasks[0]).toMatchObject({ changeStatus: "applied", changedPaths: ["src/auto.txt"] });
    expect(existsSync(join(gitFixture.repoRoot, "src", "auto.txt"))).toBe(true);
    expect(fixture.teams.getTaskWorkspace(team.tasks[0]!.id)?.worktreeRoot).toBeNull();
  }, 15_000);

  it("rejects out-of-scope worktree changes and never overwrites the parent", async () => {
    const fixture = createFixture(1);
    const gitFixture = createGitFixture();
    const runTask = vi.fn(async (_sessionId: string, agentId: string, _task: string, metadata: { workspaceRoot?: string }) => {
      writeFileSync(join(metadata.workspaceRoot!, "README.md"), "agent overwrite\n", "utf8");
      return resultFor(agentId);
    });
    const service = new TeamRunService(
      fixture.sessions,
      fixture.agents,
      fixture.teams,
      { runTask },
      new EventHub(),
      new GitWorktreeManager(gitFixture.repoRoot, gitFixture.storageRoot),
    );

    const team = await service.start(fixture.sessionId, {
      goal: "Stay inside src",
      agentIds: fixture.agentIds,
      maxConcurrency: 1,
      workspaceMode: "worktree",
      mergeStrategy: "auto",
      pathAssignments: [{ agentId: fixture.agentIds[0]!, paths: ["src"] }],
    });

    expect(team.status).toBe("failed");
    expect(team.tasks[0]).toMatchObject({
      status: "completed",
      changeStatus: "rejected",
      conflictPaths: ["README.md"],
    });
    expect(git(gitFixture.repoRoot, ["show", "HEAD:README.md"])).toBe("base readme");
    expect(fixture.teams.getTaskWorkspace(team.tasks[0]!.id)?.worktreeRoot).toEqual(expect.any(String));
  }, 15_000);
});

function createFixture(agentCount: number) {
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
  const agentIds = Array.from({ length: agentCount }, (_, index) => agents.create({
    name: `Agent ${index + 1}`,
    description: `Role ${index + 1}`,
    systemPrompt: `Act as Agent ${index + 1}`,
    providerId: provider.id,
    model: "model",
  }).id);
  return {
    sessions,
    agents,
    teams: new TeamRunRepository(database),
    sessionId: sessions.createSession("Team service test").id,
    agentIds,
  };
}

function resultFor(agentId: string): AgentRunResult {
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  return {
    runId,
    replyEvent: {
      sequence: 1,
      eventId: crypto.randomUUID(),
      sessionId,
      type: "message.agent",
      actor: { kind: "agent", id: agentId, label: agentId },
      payload: { runId, text: `result:${agentId}` },
      createdAt: now,
    },
    completedEvent: {
      sequence: 2,
      eventId: crypto.randomUUID(),
      sessionId,
      type: "agent.run.completed",
      actor: { kind: "agent", id: agentId, label: agentId },
      payload: { runId },
      createdAt: now,
    },
  };
}

function createGitFixture() {
  const root = mkdtempSync(join(tmpdir(), "prometheus-team-service-worktree-"));
  tempRoots.push(root);
  const repoRoot = join(root, "repo");
  const storageRoot = join(root, "worktrees");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "README.md"), "base readme\n", "utf8");
  git(repoRoot, ["init"]);
  git(repoRoot, ["config", "core.autocrlf", "false"]);
  git(repoRoot, ["config", "user.email", "prometheus-test@example.com"]);
  git(repoRoot, ["config", "user.name", "Prometheus Test"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "initial"]);
  return { repoRoot, storageRoot };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout.trim();
}
