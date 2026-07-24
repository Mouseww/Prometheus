import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { DefaultProviderFactory } from "@prometheus/agent-core";
import { AgentRepository } from "./agent-repository.js";
import { AgentRunService } from "./agent-run-service.js";
import { buildApp } from "./app.js";
import { openDatabase } from "./database.js";
import { SessionRepository } from "./session-repository.js";
import { EventHub } from "./event-hub.js";
import { ProviderRepository } from "./provider-repository.js";
import { SecretVault, loadOrCreateMasterKey } from "./secret-vault.js";
import { WorkspaceService } from "./workspace-service.js";
import { WorkspaceToolRegistry } from "./workspace-tools.js";
import { ApprovalCoordinator } from "./approval-coordinator.js";
import { ShellCommandTool } from "./shell-command-tool.js";
import { PermissionRuleRepository } from "./permission-rule-repository.js";
import { ToolPermissionPolicy } from "./tool-permission-policy.js";
import { RunStreamHub } from "./run-stream-hub.js";
import { TeamRunRepository } from "./team-run-repository.js";
import { TeamRunService } from "./team-run-service.js";
import { TeamMessageRepository } from "./team-message-repository.js";
import { TeamMessageService } from "./team-message-service.js";
import { TeamRuntimeToolFactory } from "./team-runtime-tools.js";
import { GitWorktreeManager } from "./git-worktree-manager.js";

const host = process.env.PROMETHEUS_HOST ?? "127.0.0.1";
const port = Number(process.env.PROMETHEUS_PORT ?? 4310);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceRoot = resolve(process.env.PROMETHEUS_WORKSPACE_ROOT ?? repositoryRoot);
const worktreeRoot = resolve(
  process.env.PROMETHEUS_WORKTREE_ROOT
    ?? resolve(dirname(workspaceRoot), ".prometheus-worktrees", basename(workspaceRoot)),
);
const webRoot = resolve(process.env.PROMETHEUS_WEB_ROOT ?? resolve(repositoryRoot, "apps/client/dist"));
const dataFileSetting = process.env.PROMETHEUS_DATA_FILE ?? resolve(repositoryRoot, ".prometheus", "prometheus.db");
const dataFile = dataFileSetting === ":memory:" ? ":memory:" : resolve(dataFileSetting);
const masterKeyFile = resolve(
  process.env.PROMETHEUS_MASTER_KEY_FILE ?? resolve(dirname(dataFile), "master.key"),
);

const database = openDatabase(dataFile);
const eventHub = new EventHub();
const sessions = new SessionRepository(database);
const providers = new ProviderRepository(
  database,
  new SecretVault(loadOrCreateMasterKey(masterKeyFile, process.env.PROMETHEUS_MASTER_KEY)),
);
const agents = new AgentRepository(database);
const workspace = new WorkspaceService(workspaceRoot);
const tools = [
  ...new WorkspaceToolRegistry(workspace).list(),
  new ShellCommandTool(workspace).tool(),
];
const approvals = new ApprovalCoordinator();
const permissionRules = new PermissionRuleRepository(database);
const runStreams = new RunStreamHub();
const teams = new TeamRunRepository(database);
const teamMessages = new TeamMessageRepository(database);
teams.recoverInterrupted();
const teamMessageService = new TeamMessageService(sessions, teamMessages, eventHub);
const teamRuntimeTools = new TeamRuntimeToolFactory(agents, teamMessages, teamMessageService);
const worktrees = new GitWorktreeManager(workspaceRoot, worktreeRoot);
const agentRuns = new AgentRunService(
  sessions,
  agents,
  providers,
  new DefaultProviderFactory(),
  eventHub,
  tools,
  approvals,
  new ToolPermissionPolicy(permissionRules),
  runStreams,
  (context) => teamRuntimeTools.create(context),
  (metadata) => {
    const taskWorkspace = new WorkspaceService(metadata.workspaceRoot ?? workspaceRoot);
    const registry = new WorkspaceToolRegistry(taskWorkspace);
    return metadata.workspaceMode === "worktree"
      ? [...registry.list(), new ShellCommandTool(taskWorkspace).tool()]
      : registry.readonly();
  },
);
const teamRuns = new TeamRunService(sessions, agents, teams, agentRuns, eventHub, worktrees);
teamRuns.reconcileInterruptedWorkspaces();
teamRuntimeTools.attachTeamRunner(teamRuns);
const app = await buildApp({
  repository: sessions,
  workspace,
  webRoot,
  eventHub,
  providers,
  agents,
  approvals,
  permissionRules,
  runStreams,
  teams,
  teamRuns,
  teamMessages,
  agentRuns,
});

const shutdown = async () => {
  await app.close();
  database.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host, port });
console.log(`Prometheus control plane listening on http://${host}:${port}`);
console.log(`Workspace root: ${workspaceRoot}`);
