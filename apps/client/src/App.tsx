import {
  createTeamRunSchema,
  type ApprovalDecision,
  type AgentProfile,
  type CreateAgentProfileInput,
  type CreateProviderInput,
  type CreateTeamRunInput,
  type Provider,
  type ProviderKind,
  type PermissionRule,
  type PermissionRuleEffect,
  type PermissionRuleTool,
  type CreatePermissionRuleInput,
  type RunStreamSnapshot,
  type SessionEvent,
  type TeamMessage,
  type TeamRun,
  type WorkspaceNode,
} from "@prometheus/protocol";
import {
  Activity,
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Command,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  Globe2,
  Menu,
  MessageSquarePlus,
  Radio,
  Send,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Settings2,
  TerminalSquare,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { describeApprovalRequest, describeEvent } from "./event-description";
import type { McpServer, SkillSummary } from "./api";
import { usePrometheus } from "./use-prometheus";

export function App() {
  const prometheus = usePrometheus();
  const [message, setMessage] = useState("");
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [runtimeSetupOpen, setRuntimeSetupOpen] = useState(false);
  const [teamSetupOpen, setTeamSetupOpen] = useState(false);
  const timelineEnd = useRef<HTMLDivElement>(null);
  const agentRunning = prometheus.running || prometheus.teamRunning || prometheus.activeStreams.length > 0;

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [prometheus.events, prometheus.activeStreams]);

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (agentRunning) return;
    const text = message.trim();
    if (!text) return;
    setMessage("");
    await prometheus.submitTask(text);
  };

  const submitSession = async (event: FormEvent) => {
    event.preventDefault();
    const title = newSessionTitle.trim();
    if (!title) return;
    await prometheus.createSession(title);
    setNewSessionTitle("");
    setNewSessionOpen(false);
  };

  return (
    <main className="app-shell">
      <NavigationRail />

      <aside className={`context-panel ${mobilePanelOpen ? "is-open" : ""}`}>
        <div className="context-heading">
          <div>
            <span className="eyebrow">WORKSPACE</span>
            <h1>{prometheus.health?.workspace ?? "Connecting…"}</h1>
          </div>
          <button className="icon-button mobile-only" onClick={() => setMobilePanelOpen(false)}>
            <X size={17} />
          </button>
        </div>

        <section className="workspace-tree" aria-label="Workspace files">
          {prometheus.rootNodes.map((node) => (
            <TreeEntry
              key={node.path}
              node={node}
              depth={0}
              expandedPaths={prometheus.expandedPaths}
              childrenByPath={prometheus.childrenByPath}
              onToggle={prometheus.toggleDirectory}
            />
          ))}
          {!prometheus.loading && prometheus.rootNodes.length === 0 && (
            <p className="muted-note">The workspace is empty.</p>
          )}
        </section>

        <div className="section-divider" />

        <div className="section-title-row">
          <span className="eyebrow">ACTIVE TASKS</span>
          <button className="mini-button" onClick={() => setNewSessionOpen(true)}>
            <MessageSquarePlus size={14} /> New
          </button>
        </div>
        <nav className="session-list" aria-label="Sessions">
          {prometheus.sessions.map((session) => (
            <button
              key={session.id}
              className={session.id === prometheus.selectedSessionId ? "session-item active" : "session-item"}
              onClick={() => {
                prometheus.setSelectedSessionId(session.id);
                setMobilePanelOpen(false);
              }}
            >
              <span className="session-pulse" />
              <span className="session-copy">
                <strong>{session.title}</strong>
                <small>seq {session.lastSequence.toString().padStart(4, "0")}</small>
              </span>
            </button>
          ))}
          {!prometheus.loading && prometheus.sessions.length === 0 && (
            <button className="empty-session" onClick={() => setNewSessionOpen(true)}>
              <span>Create the first task</span>
              <small>It will be available on every connected client.</small>
            </button>
          )}
        </nav>
      </aside>

      <section className="mission-panel">
        <header className="mission-header">
          <button className="icon-button mobile-only" onClick={() => setMobilePanelOpen(true)}>
            <Menu size={18} />
          </button>
          <div className="mission-title">
            <span className="breadcrumb">PROMETHEUS / TASK</span>
            <h2>{prometheus.selectedSession?.title ?? "No task selected"}</h2>
          </div>
          <div className={`connection-pill ${prometheus.connection}`}>
            <Radio size={13} />
            {prometheus.connection === "live" ? "LIVE SYNC" : prometheus.connection.toUpperCase()}
          </div>
        </header>

        {prometheus.error && <div className="error-banner">{prometheus.error}</div>}
        {prometheus.teamRuns[0] && (
          <TeamRunSummary
            team={prometheus.teamRuns[0]}
            messages={prometheus.teamMessages}
            onApply={prometheus.applyTeamChanges}
            onDiscard={prometheus.discardTeamChanges}
          />
        )}

        <div className="timeline">
          {prometheus.selectedSession ? (
            prometheus.events.length > 0 || prometheus.activeStreams.length > 0 ? (
              <>
                {prometheus.events.map((event) => (
                  <TimelineEvent
                    key={event.eventId}
                    event={event}
                    events={prometheus.events}
                    onResolveApproval={prometheus.resolveApproval}
                  />
                ))}
                {prometheus.activeStreams.map((stream) => (
                  <StreamingEvent key={stream.runId} stream={stream} />
                ))}
              </>
            ) : (
              <div className="empty-state">
                <div className="orbital-mark"><Sparkles size={27} /></div>
                <span className="eyebrow">DURABLE TASK READY</span>
                <h3>Start with an outcome.</h3>
                <p>Your message will be committed to the server event log and appear on every connected device.</p>
              </div>
            )
          ) : (
            <div className="empty-state">
              <div className="orbital-mark"><Command size={27} /></div>
              <span className="eyebrow">NO ACTIVE TASK</span>
              <h3>Create a mission to begin.</h3>
              <p>Prometheus keeps each task as a replayable timeline, independent of the terminal you started on.</p>
              <button className="primary-button" onClick={() => setNewSessionOpen(true)}>Create task</button>
            </div>
          )}
          <div ref={timelineEnd} />
        </div>

        <form className="composer" onSubmit={submitMessage}>
          <div className="composer-meta">
            <span><TerminalSquare size={13} /> TASK INPUT</span>
            <span>{agentRunning ? "AGENT STREAMING" : `${message.length}/12000`}</span>
          </div>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value.slice(0, 12000))}
            placeholder={prometheus.selectedSession ? "Describe the next outcome or add context…" : "Create a task before sending input"}
            disabled={!prometheus.selectedSession || agentRunning}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-footer">
            <div className="composer-runtime-actions">
              <label className="agent-selector">
                <Bot size={13} />
                <select
                  value={prometheus.selectedAgentId ?? ""}
                  onChange={(event) => prometheus.setSelectedAgentId(event.target.value || null)}
                >
                  <option value="">Store message only</option>
                  {prometheus.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select>
              </label>
              <button
                type="button"
                className="team-run-button"
                disabled={!prometheus.selectedSession || prometheus.agents.length === 0 || agentRunning}
                onClick={() => setTeamSetupOpen(true)}
              >
                <Users size={13} /> Team run
              </button>
            </div>
            <button className="send-button" type="submit" disabled={!prometheus.selectedSession || !message.trim() || agentRunning}>
              {agentRunning ? "Streaming" : "Transmit"} <Send size={15} />
            </button>
          </div>
        </form>
      </section>

      <aside className="telemetry-panel">
        <div className="telemetry-header">
          <span className="eyebrow">SYSTEM TELEMETRY</span>
          <Activity size={15} />
        </div>
        <TelemetryCard
          icon={<Globe2 size={18} />}
          label="Control plane"
          value={prometheus.health ? "Reachable" : "Unavailable"}
          detail={prometheus.health ? new Date(prometheus.health.timestamp).toLocaleTimeString() : "Waiting for health check"}
          tone={prometheus.health ? "good" : "quiet"}
        />
        <TelemetryCard
          icon={<GitBranch size={18} />}
          label="Durable sequence"
          value={String(prometheus.events.at(-1)?.sequence ?? 0).padStart(4, "0")}
          detail={`${prometheus.events.length} event${prometheus.events.length === 1 ? "" : "s"} loaded`}
          tone="neutral"
        />
        <TelemetryCard
          icon={<Bot size={18} />}
          label="Agent runtime"
          value={prometheus.agents.length > 0 ? `${prometheus.agents.length} configured` : "Not configured"}
          detail={prometheus.agents.find((agent) => agent.id === prometheus.selectedAgentId)?.name ?? "Add a provider and agent profile"}
          tone={prometheus.agents.length > 0 ? "good" : "quiet"}
        />
        <button className="runtime-config-button" onClick={() => setRuntimeSetupOpen(true)}>
          <Settings2 size={14} /> Configure runtime
        </button>

        <section className="capability-stack">
          <span className="eyebrow">RUNTIME LAYERS</span>
          <Capability icon={<FileCode2 size={15} />} label="Workspace read tools" status="connected" />
          <Capability icon={<TerminalSquare size={15} />} label="Approved shell commands" status="connected" />
          <Capability icon={<ShieldCheck size={15} />} label="Persistent permission policy" status="connected" />
          <Capability icon={<Users size={15} />} label="SubAgent teams" status="connected" />
          <Capability
            icon={<Boxes size={15} />}
            label="Skills & MCP"
            status={prometheus.skills.length > 0 || prometheus.mcpServers.length > 0 ? "connected" : "planned"}
          />
          <Capability icon={<ServerCog size={15} />} label="SSH execution" />
          <Capability icon={<Clock3 size={15} />} label="Scheduled tasks" />
          <Capability icon={<ShieldCheck size={15} />} label="Cross-device approvals" status="connected" />
        </section>
        <div className="telemetry-footer">
          <CircleDot size={13} />
          <span>Team Runtime 3C / protocol v0.8</span>
        </div>
      </aside>

      {newSessionOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setNewSessionOpen(false)}>
          <form className="modal-card" onSubmit={submitSession} onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">NEW DURABLE TASK</span>
            <h3>Name the outcome</h3>
            <p>The task timeline can be opened and continued from any connected Prometheus client.</p>
            <input
              autoFocus
              value={newSessionTitle}
              onChange={(event) => setNewSessionTitle(event.target.value)}
              maxLength={160}
              placeholder="e.g. Ship authentication flow"
            />
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setNewSessionOpen(false)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!newSessionTitle.trim()}>Create task</button>
            </div>
          </form>
        </div>
      )}
      {runtimeSetupOpen && (
        <RuntimeSetupModal
          providers={prometheus.providers}
          agents={prometheus.agents}
          permissionRules={prometheus.permissionRules}
          skills={prometheus.skills}
          mcpServers={prometheus.mcpServers}
          onCreateProvider={prometheus.createProvider}
          onCreateAgent={prometheus.createAgent}
          onCreatePermissionRule={prometheus.createPermissionRule}
          onDeletePermissionRule={prometheus.deletePermissionRule}
          onCreateMcpServer={prometheus.createMcpServer}
          onDeleteMcpServer={prometheus.deleteMcpServer}
          onRefreshSkills={prometheus.refreshSkills}
          onClose={() => setRuntimeSetupOpen(false)}
        />
      )}
      {teamSetupOpen && (
        <TeamRunModal
          agents={prometheus.agents}
          onStart={prometheus.startTeam}
          onClose={() => setTeamSetupOpen(false)}
        />
      )}
    </main>
  );
}

function TeamRunSummary({
  team,
  messages,
  onApply,
  onDiscard,
}: {
  team: TeamRun;
  messages: TeamMessage[];
  onApply: (teamRunId: string, teamTaskId: string) => Promise<TeamRun>;
  onDiscard: (teamRunId: string, teamTaskId: string) => Promise<TeamRun>;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (action: "apply" | "discard", taskId: string) => {
    if (action === "discard" && !globalThis.confirm("Discard this isolated worktree and all of its unapplied changes?")) return;
    setBusyAction(`${action}:${taskId}`);
    setActionError(null);
    try {
      await (action === "apply" ? onApply(team.id, taskId) : onDiscard(team.id, taskId));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : `Unable to ${action} team changes`);
    } finally {
      setBusyAction(null);
    }
  };
  return (
    <section className={`team-run-summary ${team.status}`} aria-label="Team run status">
      <div className="team-run-summary-header">
        <div>
          <span className="eyebrow">PARALLEL TEAM</span>
          <strong>{team.goal}</strong>
        </div>
        <span>{team.status} · {team.tasks.length} agents · {team.workspaceMode} · {team.mergeStrategy}</span>
      </div>
      {actionError && <div className="team-run-error team-action-error">{actionError}</div>}
      <div className="team-task-grid">
        {team.tasks.map((task) => (
          <div className={`team-task ${task.status}`} key={task.id}>
            <span className="team-task-dot" />
            <div className="team-task-content">
              <strong>{task.agentLabel}</strong>
              <small>{task.status} · {task.changeStatus}</small>
              {task.allowedPaths.length > 0 && (
                <span className="team-path-owner">owns {task.allowedPaths.join(", ")}</span>
              )}
              {task.changedPaths.length > 0 && (
                <div className="team-change-list" aria-label={`${task.agentLabel} changed paths`}>
                  {task.changedPaths.slice(0, 8).map((path) => <code key={path}>{path}</code>)}
                  {task.changedPaths.length > 8 && <small>+{task.changedPaths.length - 8} more</small>}
                </div>
              )}
              {task.conflictPaths.length > 0 && (
                <span className="team-conflicts">conflicts: {task.conflictPaths.join(", ")}</span>
              )}
              {task.patchBytes > 0 && <small>{task.patchBytes.toLocaleString()} patch bytes</small>}
              {["pending", "conflicted", "rejected"].includes(task.changeStatus) && (
                <div className="team-change-actions">
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => void act("apply", task.id)}
                  >
                    {busyAction === `apply:${task.id}` ? "Applying…" : "Apply"}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busyAction !== null}
                    onClick={() => void act("discard", task.id)}
                  >
                    {busyAction === `discard:${task.id}` ? "Discarding…" : "Discard"}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {messages.length > 0 && <TeamMessageBus messages={messages} />}
    </section>
  );
}

function TeamMessageBus({ messages }: { messages: TeamMessage[] }) {
  return (
    <section className="team-message-bus" aria-label="Agent message bus">
      <div className="team-message-bus-header">
        <span>AGENT MESSAGE BUS</span>
        <small>{messages.length} durable</small>
      </div>
      <div className="team-message-list">
        {messages.map((message) => (
          <article className={`team-message ${message.channel}`} key={message.id}>
            <div>
              <strong>{message.senderLabel}</strong>
              <span>→ {message.recipientLabel}</span>
              <small>{message.channel} · #{message.sequence}</small>
            </div>
            {message.subject && <b>{message.subject}</b>}
            <p>{message.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TeamRunModal({
  agents,
  onStart,
  onClose,
}: {
  agents: AgentProfile[];
  onStart: (input: CreateTeamRunInput) => Promise<TeamRun | null>;
  onClose: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState(() => new Set(agents.map((agent) => agent.id)));
  const [maxConcurrency, setMaxConcurrency] = useState(Math.min(4, Math.max(1, agents.length)));
  const [workspaceMode, setWorkspaceMode] = useState<"readonly" | "worktree">("readonly");
  const [mergeStrategy, setMergeStrategy] = useState<"manual" | "auto">("manual");
  const [pathAssignments, setPathAssignments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const agentIds = agents.map((agent) => agent.id).filter((agentId) => selectedAgentIds.has(agentId));
    if (!goal.trim() || agentIds.length === 0) return;
    const rawInput = {
      goal: goal.trim(),
      agentIds,
      maxConcurrency: Math.min(maxConcurrency, agentIds.length),
      workspaceMode,
      mergeStrategy: workspaceMode === "readonly" ? "manual" as const : mergeStrategy,
      pathAssignments: workspaceMode === "worktree"
        ? agentIds.map((agentId) => ({
            agentId,
            paths: (pathAssignments[agentId] ?? "")
              .split(/[\n,]+/)
              .map((path) => path.trim())
              .filter(Boolean),
          }))
        : [],
    };
    const parsed = createTeamRunSchema.safeParse(rawInput);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onStart(parsed.data);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Team run failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal-card team-run-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <span className="eyebrow">PARALLEL SUBAGENTS</span>
        <h3>Launch a bounded team</h3>
        <p>Readonly is the safe default. Worktree mode gives each Agent a real isolated Git branch with explicit path ownership.</p>
        {error && <div className="team-run-error">{error}</div>}
        <label className="team-goal-field">
          Team goal
          <textarea
            autoFocus
            value={goal}
            onChange={(event) => setGoal(event.target.value.slice(0, 12_000))}
            placeholder="e.g. Review the authentication implementation from independent security and maintainability roles"
          />
        </label>
        <div className="team-agent-list">
          {agents.map((agent) => (
            <label className={selectedAgentIds.has(agent.id) ? "team-agent-option selected" : "team-agent-option"} key={agent.id}>
              <input
                type="checkbox"
                checked={selectedAgentIds.has(agent.id)}
                onChange={() => toggleAgent(agent.id)}
              />
              <div><strong>{agent.name}</strong><small>{agent.description || agent.model}</small></div>
            </label>
          ))}
        </div>
        <div className="team-runtime-options">
          <label>
            Workspace mode
            <select
              value={workspaceMode}
              onChange={(event) => setWorkspaceMode(event.target.value as "readonly" | "worktree")}
            >
              <option value="readonly">Readonly</option>
              <option value="worktree">Git worktree</option>
            </select>
          </label>
          <label>
            Merge strategy
            <select
              value={workspaceMode === "readonly" ? "manual" : mergeStrategy}
              disabled={workspaceMode === "readonly"}
              onChange={(event) => setMergeStrategy(event.target.value as "manual" | "auto")}
            >
              <option value="manual">Manual review</option>
              <option value="auto">Auto if conflict-free</option>
            </select>
          </label>
        </div>
        {workspaceMode === "worktree" && (
          <div className="team-path-assignments">
            <span>PATH OWNERSHIP</span>
            <p>Use workspace-relative files or directories. Assignments cannot overlap across Agents.</p>
            {agents.filter((agent) => selectedAgentIds.has(agent.id)).map((agent) => (
              <label key={agent.id}>
                {agent.name}
                <input
                  value={pathAssignments[agent.id] ?? ""}
                  onChange={(event) => setPathAssignments((current) => ({
                    ...current,
                    [agent.id]: event.target.value,
                  }))}
                  placeholder="apps/server, packages/protocol"
                  required
                />
              </label>
            ))}
          </div>
        )}
        <label className="team-concurrency-field">
          Maximum concurrency
          <select
            value={maxConcurrency}
            onChange={(event) => setMaxConcurrency(Number(event.target.value))}
          >
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !goal.trim() || selectedAgentIds.size === 0}
          >
            {busy ? "Running team…" : `Run ${selectedAgentIds.size} agents`}
          </button>
        </div>
      </form>
    </div>
  );
}

function RuntimeSetupModal({
  providers,
  agents,
  permissionRules,
  skills,
  mcpServers,
  onCreateProvider,
  onCreateAgent,
  onCreatePermissionRule,
  onDeletePermissionRule,
  onCreateMcpServer,
  onDeleteMcpServer,
  onRefreshSkills,
  onClose,
}: {
  providers: Provider[];
  agents: AgentProfile[];
  permissionRules: PermissionRule[];
  skills: SkillSummary[];
  mcpServers: McpServer[];
  onCreateProvider: (input: CreateProviderInput) => Promise<Provider>;
  onCreateAgent: (input: CreateAgentProfileInput) => Promise<AgentProfile>;
  onCreatePermissionRule: (input: CreatePermissionRuleInput) => Promise<PermissionRule>;
  onDeletePermissionRule: (ruleId: string) => Promise<void>;
  onCreateMcpServer: (input: { name: string; command: string; args?: string[]; enabled?: boolean }) => Promise<McpServer>;
  onDeleteMcpServer: (serverId: string) => Promise<void>;
  onRefreshSkills: () => Promise<SkillSummary[]>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ProviderKind>("openai");
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [agentName, setAgentName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [agentModel, setAgentModel] = useState(providers[0]?.defaultModel ?? "");
  const [permissionTool, setPermissionTool] = useState<PermissionRuleTool>("shell_command");
  const [permissionEffect, setPermissionEffect] = useState<PermissionRuleEffect>("deny");
  const [permissionPattern, setPermissionPattern] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("python");
  const [mcpArgs, setMcpArgs] = useState("");
  const [skillList, setSkillList] = useState(skills);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitProvider = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const provider = await onCreateProvider({
        name: providerName,
        kind,
        baseUrl: baseUrl || null,
        defaultModel,
        apiKey,
      });
      setProviderId(provider.id);
      setAgentModel(provider.defaultModel);
      setProviderName(""); setBaseUrl(""); setDefaultModel(""); setApiKey(""); setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider configuration failed");
    } finally { setBusy(false); }
  };

  const submitAgent = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreateAgent({ name: agentName, description, systemPrompt, providerId, model: agentModel });
      setAgentName(""); setDescription(""); setSystemPrompt(""); setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent configuration failed");
    } finally { setBusy(false); }
  };

  const submitPermissionRule = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreatePermissionRule({
        toolName: permissionTool.trim(),
        effect: permissionEffect,
        pattern: permissionPattern,
      });
      setPermissionPattern("");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Permission rule creation failed");
    } finally { setBusy(false); }
  };

  const removePermissionRule = async (ruleId: string) => {
    setBusy(true);
    try {
      await onDeletePermissionRule(ruleId);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Permission rule deletion failed");
    } finally { setBusy(false); }
  };

  const submitMcpServer = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const args = mcpArgs
        .split(/\r?\n|,/)
        .map((part) => part.trim())
        .filter(Boolean);
      await onCreateMcpServer({
        name: mcpName.trim(),
        command: mcpCommand.trim(),
        args,
        enabled: true,
      });
      setMcpName("");
      setMcpArgs("");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP server configuration failed");
    } finally { setBusy(false); }
  };

  const removeMcpServer = async (serverId: string) => {
    setBusy(true);
    try {
      await onDeleteMcpServer(serverId);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP server deletion failed");
    } finally { setBusy(false); }
  };

  const reloadSkills = async () => {
    setBusy(true);
    try {
      const next = await onRefreshSkills();
      setSkillList(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Skill refresh failed");
    } finally { setBusy(false); }
  };

  const permissionPlaceholder =
    permissionTool === "shell_command"
      ? "e.g. pnpm test*"
      : permissionTool === "write_file"
        ? "e.g. docs/*"
        : "e.g. *";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="runtime-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="runtime-modal-header">
          <div><span className="eyebrow">AGENT RUNTIME</span><h3>Connect real model providers</h3></div>
          <button className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>
        {error && <div className="runtime-error">{error}</div>}
        <div className="runtime-grid">
          <form className="runtime-form" onSubmit={submitProvider}>
            <div className="runtime-form-title"><ServerCog size={16} /><strong>Provider</strong><small>{providers.length} configured</small></div>
            <label>Protocol<select value={kind} onChange={(event) => setKind(event.target.value as ProviderKind)}><option value="openai">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Google Gemini</option><option value="openai_compatible">OpenAI-compatible</option></select></label>
            <label>Name<input value={providerName} onChange={(event) => setProviderName(event.target.value)} required placeholder="Team OpenAI" /></label>
            {(kind === "openai_compatible" || kind === "anthropic") && <label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required={kind === "openai_compatible"} placeholder="https://api.example.com/v1" /></label>}
            <label>Default model<input value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} required placeholder="Provider model ID" /></label>
            <label>API key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required placeholder="Encrypted before storage" /></label>
            <button className="primary-button" disabled={busy}>Save provider</button>
          </form>
          <form className="runtime-form" onSubmit={submitAgent}>
            <div className="runtime-form-title"><Bot size={16} /><strong>Agent profile</strong><small>{agents.length} configured</small></div>
            <label>Provider<select value={providerId} onChange={(event) => { const id = event.target.value; setProviderId(id); setAgentModel(providers.find((provider) => provider.id === id)?.defaultModel ?? ""); }} required><option value="">Select provider</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
            <label>Name<input value={agentName} onChange={(event) => setAgentName(event.target.value)} required placeholder="Builder" /></label>
            <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this agent is responsible for" /></label>
            <label>Model<input value={agentModel} onChange={(event) => setAgentModel(event.target.value)} required placeholder="Provider model ID" /></label>
            <label>System prompt<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} required placeholder="Define role, constraints and expected evidence." /></label>
            <button className="primary-button" disabled={busy || providers.length === 0}>Save agent</button>
          </form>
        </div>
        <section className="extensions-config">
          <div className="permission-config-header">
            <div className="permission-config-title">
              <Boxes size={17} />
              <div><strong>Skills & MCP</strong><small>{skillList.length} skills · {mcpServers.length} servers</small></div>
            </div>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void reloadSkills()}>Refresh skills</button>
          </div>
          <div className="extensions-grid">
            <div className="extension-list">
              <div className="runtime-form-title"><Sparkles size={16} /><strong>Discovered skills</strong><small>.prometheus/skills · skills</small></div>
              {skillList.length === 0 ? (
                <div className="permission-empty">No SKILL.md files discovered yet. Drop skills into `.prometheus/skills/&lt;id&gt;/SKILL.md`.</div>
              ) : skillList.map((skill) => (
                <div className="extension-row" key={skill.id}>
                  <div>
                    <strong>{skill.name}</strong>
                    <small>{skill.id}</small>
                  </div>
                  <p>{skill.description || "No description"}</p>
                </div>
              ))}
            </div>
            <form className="runtime-form extension-form" onSubmit={submitMcpServer}>
              <div className="runtime-form-title"><Boxes size={16} /><strong>MCP server</strong><small>stdio transport</small></div>
              <label>Name<input value={mcpName} onChange={(event) => setMcpName(event.target.value)} required placeholder="echo" /></label>
              <label>Command<input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} required placeholder="python" /></label>
              <label>Args<textarea value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} placeholder={"one arg per line\nscripts/mcp_echo_fixture.py"} /></label>
              <button className="primary-button" disabled={busy || !mcpName.trim() || !mcpCommand.trim()}>Add MCP server</button>
              <div className="extension-list compact">
                {mcpServers.length === 0 ? (
                  <div className="permission-empty">No MCP servers configured.</div>
                ) : mcpServers.map((server) => (
                  <div className="extension-row" key={server.id}>
                    <div>
                      <strong>{server.name}</strong>
                      <small>{server.enabled ? "enabled" : "disabled"} · mcp__{server.name.replace(/[^A-Za-z0-9_-]/g, "_")}__*</small>
                    </div>
                    <p><code>{server.command} {server.args.join(" ")}</code></p>
                    <button type="button" className="permission-delete" aria-label={`Delete MCP server ${server.name}`} disabled={busy} onClick={() => void removeMcpServer(server.id)}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </form>
          </div>
        </section>
        <section className="permission-config">
          <div className="permission-config-header">
            <div className="permission-config-title">
              <ShieldCheck size={17} />
              <div><strong>Permission policy</strong><small>{permissionRules.length} persistent rules on this node</small></div>
            </div>
            <div className="permission-precedence"><span>DENY</span><i>→</i><span>ASK</span><i>→</i><span>ALLOW</span></div>
          </div>
          <p className="permission-guidance">
            Shell compound commands are evaluated one subcommand at a time. MCP tools default to approval and can be allowed with exact tool names such as `mcp__echo__echo`.
          </p>
          <form className="permission-rule-form" onSubmit={submitPermissionRule}>
            <label>Tool
              <input
                list="permission-tool-options"
                aria-label="Permission tool"
                value={permissionTool}
                onChange={(event) => setPermissionTool(event.target.value)}
                required
                maxLength={80}
                placeholder="shell_command | write_file | mcp__server__tool"
              />
              <datalist id="permission-tool-options">
                <option value="shell_command" />
                <option value="write_file" />
                <option value="read_skill" />
                {mcpServers.map((server) => (
                  <option key={server.id} value={`mcp__${server.name.replace(/[^A-Za-z0-9_-]/g, "_")}__`} />
                ))}
              </datalist>
            </label>
            <label>Effect<select aria-label="Permission effect" value={permissionEffect} onChange={(event) => setPermissionEffect(event.target.value as PermissionRuleEffect)}><option value="deny">Deny</option><option value="ask">Ask every time</option><option value="allow">Allow without prompt</option></select></label>
            <label className="permission-pattern-field">Pattern<input aria-label="Permission pattern" value={permissionPattern} onChange={(event) => setPermissionPattern(event.target.value)} required maxLength={2000} placeholder={permissionPlaceholder} /></label>
            <button className="primary-button" disabled={busy || !permissionPattern.trim() || !permissionTool.trim()}>Add rule</button>
          </form>
          <div className="permission-rule-list">
            {permissionRules.length === 0 ? (
              <div className="permission-empty">No persistent rules. Protected tools use cross-device approval.</div>
            ) : permissionRules.map((rule) => (
              <div className={`permission-rule-row ${rule.effect}`} key={rule.id}>
                <span className="permission-effect">{rule.effect}</span>
                <span className="permission-tool">{rule.toolName}</span>
                <code>{rule.pattern}</code>
                <button type="button" className="permission-delete" aria-label={`Delete permission rule ${rule.pattern}`} disabled={busy} onClick={() => void removePermissionRule(rule.id)}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function NavigationRail() {
  return (
    <nav className="navigation-rail" aria-label="Primary navigation">
      <div className="brand-mark" aria-label="Prometheus"><span>P</span></div>
      <div className="rail-actions">
        <button className="rail-button active" title="Mission control"><Command size={19} /></button>
        <button className="rail-button" title="Workspace"><FileCode2 size={19} /></button>
        <button className="rail-button" title="Agents"><Users size={19} /></button>
        <button className="rail-button" title="Extensions"><Boxes size={19} /></button>
      </div>
      <div className="rail-spacer" />
      <div className="node-indicator" title="Local node"><span /></div>
    </nav>
  );
}

function TreeEntry({
  node,
  depth,
  expandedPaths,
  childrenByPath,
  onToggle,
}: {
  node: WorkspaceNode;
  depth: number;
  expandedPaths: Set<string>;
  childrenByPath: Record<string, WorkspaceNode[]>;
  onToggle: (path: string) => Promise<void>;
}) {
  const expanded = expandedPaths.has(node.path);
  const children = childrenByPath[node.path] ?? [];
  return (
    <div>
      <button
        className="tree-row"
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => node.kind === "directory" && void onToggle(node.path)}
      >
        {node.kind === "directory" ? (
          <>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          </>
        ) : (
          <><span className="tree-indent" /><FileCode2 size={14} /></>
        )}
        <span>{node.name}</span>
      </button>
      {expanded && children.map((child) => (
        <TreeEntry
          key={child.path}
          node={child}
          depth={depth + 1}
          expandedPaths={expandedPaths}
          childrenByPath={childrenByPath}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function TimelineEvent({
  event,
  events,
  onResolveApproval,
}: {
  event: SessionEvent;
  events: SessionEvent[];
  onResolveApproval: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<unknown>;
}) {
  const [resolving, setResolving] = useState<ApprovalDecision | null>(null);
  const text = describeEvent(event);
  const isUser = event.actor.kind === "user";
  const approvalId = typeof event.payload.approvalId === "string" ? event.payload.approvalId : null;
  const resolution = event.type === "approval.requested" && approvalId
    ? events.find((candidate) =>
      candidate.type === "approval.resolved" && candidate.payload.approvalId === approvalId,
    )
    : undefined;
  const resolvedDecision = resolution?.payload.decision === "approved" || resolution?.payload.decision === "denied"
    ? resolution.payload.decision
    : null;

  const resolve = async (decision: ApprovalDecision) => {
    if (!approvalId || resolvedDecision || resolving) return;
    setResolving(decision);
    try {
      await onResolveApproval(event.sessionId, approvalId, decision);
    } catch {
      // The shared error banner is updated by the data hook.
    } finally {
      setResolving(null);
    }
  };

  return (
    <article className={`timeline-event ${isUser ? "user-event" : "system-event"}`}>
      <div className="event-rail">
        <span className="event-node">{String(event.sequence).padStart(2, "0")}</span>
        <span className="event-line" />
      </div>
      <div className="event-body">
        <div className="event-meta">
          <strong>{event.actor.label}</strong>
          <span>{event.type}</span>
          <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        <p>{text}</p>
        {event.type === "approval.requested" && approvalId && (
          <ApprovalRequest
            event={event}
            decision={resolvedDecision}
            resolving={resolving}
            onResolve={resolve}
          />
        )}
      </div>
    </article>
  );
}

function StreamingEvent({ stream }: { stream: RunStreamSnapshot }) {
  return (
    <article className="timeline-event system-event streaming-event" aria-label="Streaming agent response">
      <div className="event-rail">
        <span className="event-node"><Radio size={11} /></span>
        <span className="event-line" />
      </div>
      <div className="event-body">
        <div className="event-meta">
          <strong>{stream.agentLabel}</strong>
          <span>streaming · turn {stream.turn}</span>
          <span className="stream-revision">rev {stream.revision}</span>
        </div>
        <p className={stream.text ? "stream-text" : "stream-waiting"}>
          {stream.text || "Waiting for provider output…"}
          {stream.text && <span className="stream-cursor" aria-hidden="true" />}
        </p>
      </div>
    </article>
  );
}

function ApprovalRequest({
  event,
  decision,
  resolving,
  onResolve,
}: {
  event: SessionEvent;
  decision: ApprovalDecision | null;
  resolving: ApprovalDecision | null;
  onResolve: (decision: ApprovalDecision) => Promise<void>;
}) {
  const presentation = describeApprovalRequest(event);
  const disabled = decision !== null || resolving !== null;

  return (
    <div className={`approval-card ${decision ?? "pending"}`}>
      <div className="approval-summary">
        <ShieldCheck size={17} />
        <div>
          <strong>{presentation.title}</strong>
          <small>{presentation.detail}</small>
        </div>
      </div>
      {presentation.preview && <pre className="approval-preview">{presentation.preview}</pre>}
      {decision ? (
        <div className="approval-decision">{decision === "approved" ? "Approved on a connected terminal" : "Denied on a connected terminal"}</div>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            aria-label={presentation.denyAriaLabel}
            onClick={() => void onResolve("denied")}
          >
            {resolving === "denied" ? "Denying…" : presentation.denyLabel}
          </button>
          <button
            type="button"
            className="approval-button"
            disabled={disabled}
            aria-label={presentation.approveAriaLabel}
            onClick={() => void onResolve("approved")}
          >
            {resolving === "approved" ? "Approving…" : presentation.approveLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function TelemetryCard({ icon, label, value, detail, tone }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: "good" | "neutral" | "quiet";
}) {
  return (
    <div className={`telemetry-card ${tone}`}>
      <div className="telemetry-icon">{icon}</div>
      <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
    </div>
  );
}

function Capability({ icon, label, status = "planned" }: {
  icon: React.ReactNode;
  label: string;
  status?: "connected" | "planned";
}) {
  return <div className={`capability-row ${status}`}>{icon}<span>{label}</span><small>{status}</small></div>;
}
