import type {
  ApprovalDecision,
  AgentProfile,
  CreateAgentProfileInput,
  CreateProviderInput,
  CreateTeamRunInput,
  CreatePermissionRuleInput,
  PermissionRule,
  Provider,
  RunStreamSnapshot,
  Session,
  SessionEvent,
  TeamMessage,
  TeamRun,
  WorkspaceNode,
} from "@prometheus/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  appendEvent,
  applyTeamTaskChanges as applyTeamTaskChangesRequest,
  createAgent as createAgentRequest,
  createProvider as createProviderRequest,
  createPermissionRule as createPermissionRuleRequest,
  deletePermissionRule as deletePermissionRuleRequest,
  discardTeamTaskChanges as discardTeamTaskChangesRequest,
  createSession as createSessionRequest,
  getControlPlaneUrl,
  getControlPlaneMode,
  getHealth,
  getRuntime,
  addRuntimeProject,
  openRuntimeProject,
  deleteRuntimeProject,
  updateRuntime,
  setControlPlaneMode,
  listEvents,
  listAgents,
  listProviders,
  listPermissionRules,
  listSessions,
  listTeamMessages,
  listTeamRuns,
  listWorkspace,
  listSkills as listSkillsRequest,
  listMcpServers as listMcpServersRequest,
  createMcpServer as createMcpServerRequest,
  deleteMcpServer as deleteMcpServerRequest,
  runAgent,
  cancelAgentRuns,
  setControlPlaneUrl,
  startTeamRun,
  resolveApproval as resolveApprovalRequest,
  subscribeToSession,
  type ControlPlaneMode,
  type Health,
  type McpServer,
  type RuntimeInfo,
  type SkillSummary,
} from "./api";
import { applyRunStreamEnvelope, clearRunStreamForEvent, mergeEvents } from "./state";
import {
  ensureLocalRuntime,
  getLocalRuntimeStatus,
  isServerHostedUi,
  isTauriDesktop,
  restartLocalRuntime,
  type LocalRuntimeStatus,
} from "./local-runtime";

export type ConnectionState = "connecting" | "live" | "offline" | "idle";
export type ControlPlaneState = "connecting" | "online" | "offline";

export function usePrometheus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [controlPlaneMode, setControlPlaneModeState] = useState<ControlPlaneMode>(() => getControlPlaneMode());
  const [localRuntime, setLocalRuntime] = useState<LocalRuntimeStatus | null>(null);
  const [hostMode] = useState(() => ({
    desktop: isTauriDesktop(),
    serverHosted: isServerHostedUi(),
  }));
  const [sessions, setSessions] = useState<Session[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [permissionRules, setPermissionRules] = useState<PermissionRule[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [teamRunning, setTeamRunning] = useState(false);
  const [teamRuns, setTeamRuns] = useState<TeamRun[]>([]);
  const [teamMessages, setTeamMessages] = useState<TeamMessage[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [activeStreams, setActiveStreams] = useState<RunStreamSnapshot[]>([]);
  const [rootNodes, setRootNodes] = useState<WorkspaceNode[]>([]);
  const [childrenByPath, setChildrenByPath] = useState<Record<string, WorkspaceNode[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [controlPlane, setControlPlane] = useState<ControlPlaneState>("connecting");
  const [controlPlaneUrl, setControlPlaneUrlState] = useState(() => getControlPlaneUrl());
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setLoading(true);
    setControlPlane("connecting");

    const bootstrap = async () => {
      attempt += 1;
      try {
        if (hostMode.desktop && getControlPlaneMode() === "local") {
          try {
            const status = await ensureLocalRuntime();
            if (!active) return;
            if (status) {
              setLocalRuntime(status);
              if (status.url) {
                setControlPlaneUrlState(status.url);
              }
              if (!status.healthy) {
                throw new Error(status.message || "Local runtime is not healthy");
              }
            }
          } catch (reason) {
            if (!active) return;
            const message = reason instanceof Error ? reason.message : "Failed to start local runtime";
            const status = await getLocalRuntimeStatus();
            if (status) setLocalRuntime(status);
            setControlPlane("offline");
            setError(`Local runtime: ${message}`);
            if (attempt < 20) {
              timer = setTimeout(() => {
                void bootstrap();
              }, Math.min(1000 + attempt * 300, 4000));
              return;
            }
            setLoading(false);
            return;
          }
        } else if (hostMode.desktop) {
          const status = await getLocalRuntimeStatus();
          if (status) setLocalRuntime(status);
        }

        const [
          nextHealth,
          nextRuntime,
          workspace,
          nextSessions,
          nextProviders,
          nextAgents,
          nextPermissionRules,
          nextSkills,
          nextMcpServers,
        ] = await Promise.all([
          getHealth(),
          getRuntime(),
          listWorkspace(),
          listSessions(),
          listProviders(),
          listAgents(),
          listPermissionRules(),
          listSkillsRequest(),
          listMcpServersRequest(),
        ]);
        if (!active) return;
        setHealth(nextHealth);
        setRuntime(nextRuntime);
        setRootNodes(workspace.nodes);
        setSessions(nextSessions);
        setProviders(nextProviders);
        setAgents(nextAgents);
        setPermissionRules(nextPermissionRules);
        setSkills(nextSkills);
        setMcpServers(nextMcpServers);
        setSelectedAgentId((current) => current ?? nextAgents[0]?.id ?? null);
        setSelectedSessionId((current) => current ?? nextSessions[0]?.id ?? null);
        setControlPlane("online");
        setError(null);
        setLoading(false);
      } catch (reason) {
        if (!active) return;
        const message = reason instanceof Error ? reason.message : "Control plane unreachable";
        setHealth(null);
        setRuntime(null);
        setControlPlane("offline");
        setError(
          `${message}. Control plane: ${getControlPlaneUrl()}. Desktop builds should auto-start the local sidecar; or run prometheus-server and open Configure runtime.`,
        );
        // Retry while the sidecar is still booting.
        if (attempt < 30) {
          timer = setTimeout(() => {
            void bootstrap();
          }, Math.min(1000 + attempt * 250, 4000));
          return;
        }
        setLoading(false);
      }
    };

    void bootstrap();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [bootstrapNonce]);

  useEffect(() => {
    if (!selectedSessionId) {
      setEvents([]);
      setTeamRuns([]);
      setTeamMessages([]);
      setActiveStreams([]);
      setConnection("idle");
      return;
    }

    const sessionId = selectedSessionId;
    let active = true;
    setEvents([]);
    setTeamRuns([]);
    setTeamMessages([]);
    setActiveStreams([]);
    setConnection("connecting");
    let teamRefreshVersion = 0;
    listEvents(sessionId)
      .then((nextEvents) => {
        if (!active) return;
        setEvents((current) => mergeEvents(current, nextEvents));
      })
      .catch((reason: Error) => active && setError(reason.message));
    refreshTeamState();

    const unsubscribe = subscribeToSession(
      sessionId,
      (envelope) => {
        if (!active) return;
        if (envelope.kind === "sync") {
          setEvents((current) => mergeEvents(current, envelope.events));
          setActiveStreams((current) => envelope.events.reduce(clearRunStreamForEvent, current));
          updateSessionFromEvents(envelope.events);
          if (envelope.events.some(isTeamEvent)) refreshTeamState();
        } else if (envelope.kind === "event") {
          setEvents((current) => mergeEvents(current, [envelope.event]));
          setActiveStreams((current) => clearRunStreamForEvent(current, envelope.event));
          updateSessionFromEvents([envelope.event]);
          if (isTeamEvent(envelope.event)) refreshTeamState();
        } else if (
          envelope.kind === "run.stream.snapshot" ||
          envelope.kind === "run.stream.delta" ||
          envelope.kind === "run.stream.cleared"
        ) {
          setActiveStreams((current) => applyRunStreamEnvelope(current, envelope));
        } else {
          setError(envelope.message);
        }
      },
      (connected) => active && setConnection(connected ? "live" : "offline"),
    );

    function updateSessionFromEvents(incoming: SessionEvent[]) {
      const latest = incoming.at(-1);
      if (!latest) return;
      setSessions((current) => current.map((session) =>
        session.id === sessionId && latest.sequence > session.lastSequence
          ? { ...session, lastSequence: latest.sequence, updatedAt: latest.createdAt }
          : session,
      ));
    }

    function refreshTeamState() {
      const version = ++teamRefreshVersion;
      listTeamRuns(sessionId)
        .then(async (nextTeams) => {
          const nextMessages = nextTeams[0]
            ? await listTeamMessages(nextTeams[0].id)
            : [];
          if (active && version === teamRefreshVersion) {
            setTeamRuns(nextTeams);
            setTeamMessages(nextMessages);
          }
        })
        .catch((reason: Error) => active && setError(reason.message));
    }

    return () => {
      active = false;
      unsubscribe();
    };
  }, [selectedSessionId]);

  const createSession = useCallback(async (title: string) => {
    const session = await createSessionRequest(title);
    setSessions((current) => [session, ...current]);
    setSelectedSessionId(session.id);
    setError(null);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!selectedSessionId) return;
      const event = await appendEvent(selectedSessionId, {
        eventId: crypto.randomUUID(),
        type: "message.user",
        actor: { kind: "user", id: "local-user", label: "You" },
        payload: { text },
      });
      setEvents((current) => mergeEvents(current, [event]));
      setSessions((current) =>
        current.map((session) =>
          session.id === selectedSessionId
            ? { ...session, lastSequence: event.sequence, updatedAt: event.createdAt }
            : session,
        ),
      );
      setError(null);
    },
    [selectedSessionId],
  );

  const submitTask = useCallback(async (text: string) => {
    if (!selectedSessionId) return;
    await sendMessage(text);
    if (!selectedAgentId) return;
    setRunning(true);
    try {
      await runAgent(selectedSessionId, selectedAgentId);
      setError(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Agent run failed";
      if (message.toLowerCase().includes("cancelled")) {
        setError(null);
      } else {
        setError(message);
      }
    } finally {
      setRunning(false);
    }
  }, [selectedAgentId, selectedSessionId, sendMessage]);

  const cancelRun = useCallback(async (runId?: string | null) => {
    if (!selectedSessionId) return null;
    try {
      const result = await cancelAgentRuns(selectedSessionId, runId);
      setError(null);
      return result;
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("Unable to cancel agent run");
      setError(error.message);
      throw error;
    }
  }, [selectedSessionId]);

  const createProvider = useCallback(async (input: CreateProviderInput) => {
    const provider = await createProviderRequest(input);
    setProviders((current) => [...current, provider]);
    setError(null);
    return provider;
  }, []);

  const startTeam = useCallback(async (input: CreateTeamRunInput) => {
    if (!selectedSessionId) return null;
    setTeamRunning(true);
    try {
      const team = await startTeamRun(selectedSessionId, input);
      const messages = await listTeamMessages(team.id);
      setTeamRuns((current) => [team, ...current.filter((candidate) => candidate.id !== team.id)]);
      setTeamMessages(messages);
      setError(null);
      return team;
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("Team run failed");
      setError(error.message);
      throw error;
    } finally {
      setTeamRunning(false);
    }
  }, [selectedSessionId]);

  const resolveApproval = useCallback(async (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) => {
    try {
      const resolution = await resolveApprovalRequest(sessionId, approvalId, decision);
      setError(null);
      return resolution;
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error("Approval resolution failed");
      setError(error.message);
      throw error;
    }
  }, []);

  const updateTeamTaskChanges = useCallback(async (
    action: "apply" | "discard",
    teamRunId: string,
    teamTaskId: string,
  ) => {
    try {
      const team = action === "apply"
        ? await applyTeamTaskChangesRequest(teamRunId, teamTaskId)
        : await discardTeamTaskChangesRequest(teamRunId, teamTaskId);
      setTeamRuns((current) => [team, ...current.filter((candidate) => candidate.id !== team.id)]);
      setError(null);
      return team;
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(`Team changes ${action} failed`);
      setError(error.message);
      throw error;
    }
  }, []);

  const applyTeamChanges = useCallback(
    (teamRunId: string, teamTaskId: string) => updateTeamTaskChanges("apply", teamRunId, teamTaskId),
    [updateTeamTaskChanges],
  );
  const discardTeamChanges = useCallback(
    (teamRunId: string, teamTaskId: string) => updateTeamTaskChanges("discard", teamRunId, teamTaskId),
    [updateTeamTaskChanges],
  );

  const createAgent = useCallback(async (input: CreateAgentProfileInput) => {
    const agent = await createAgentRequest(input);
    setAgents((current) => [...current, agent]);
    setSelectedAgentId(agent.id);
    setError(null);
    return agent;
  }, []);

  const createPermissionRule = useCallback(async (input: CreatePermissionRuleInput) => {
    const rule = await createPermissionRuleRequest(input);
    setPermissionRules((current) => [...current, rule].sort(comparePermissionRules));
    setError(null);
    return rule;
  }, []);

  const deletePermissionRule = useCallback(async (ruleId: string) => {
    await deletePermissionRuleRequest(ruleId);
    setPermissionRules((current) => current.filter((rule) => rule.id !== ruleId));
    setError(null);
  }, []);

  const createMcpServer = useCallback(async (input: {
    name: string;
    command: string;
    args?: string[];
    enabled?: boolean;
  }) => {
    const server = await createMcpServerRequest(input);
    setMcpServers((current) => [...current, server].sort((a, b) => a.name.localeCompare(b.name)));
    setError(null);
    return server;
  }, []);

  const deleteMcpServer = useCallback(async (serverId: string) => {
    await deleteMcpServerRequest(serverId);
    setMcpServers((current) => current.filter((server) => server.id !== serverId));
    setError(null);
  }, []);

  const refreshSkills = useCallback(async () => {
    const nextSkills = await listSkillsRequest();
    setSkills(nextSkills);
    return nextSkills;
  }, []);

  const toggleDirectory = useCallback(
    async (path: string) => {
      if (expandedPaths.has(path)) {
        setExpandedPaths((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
        return;
      }

      if (!childrenByPath[path]) {
        const result = await listWorkspace(path);
        setChildrenByPath((current) => ({ ...current, [path]: result.nodes }));
      }
      setExpandedPaths((current) => new Set(current).add(path));
    },
    [childrenByPath, expandedPaths],
  );

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );

  const reconnectControlPlane = useCallback(() => {
    setBootstrapNonce((value) => value + 1);
  }, []);

  const configureControlPlane = useCallback((url: string) => {
    const next = setControlPlaneUrl(url);
    setControlPlaneUrlState(next);
    setBootstrapNonce((value) => value + 1);
    return next;
  }, []);

  const configureControlPlaneMode = useCallback((mode: ControlPlaneMode) => {
    const next = setControlPlaneMode(mode);
    setControlPlaneModeState(next);
    if (mode === "local") {
      setControlPlaneUrlState(getControlPlaneUrl());
    }
    setBootstrapNonce((value) => value + 1);
    return next;
  }, []);

  const refreshRuntime = useCallback(async () => {
    const next = await getRuntime();
    setRuntime(next);
    return next;
  }, []);

  const saveRuntime = useCallback(async (input: { host?: string; port?: number; workspaceRoot?: string }) => {
    const next = await updateRuntime(input);
    setRuntime(next);
    setHealth((current) => current ? {
      ...current,
      workspace: next.workspaceName,
      workspaceRoot: next.workspaceRoot,
      host: next.host,
      port: next.port,
    } : current);
    setBootstrapNonce((value) => value + 1);
    return next;
  }, []);

  const openProject = useCallback(async (projectId: string) => {
    const result = await openRuntimeProject(projectId);
    await refreshRuntime();
    setBootstrapNonce((value) => value + 1);
    return result;
  }, [refreshRuntime]);

  const addProject = useCallback(async (path: string, open = true) => {
    const result = await addRuntimeProject(path, open);
    await refreshRuntime();
    setBootstrapNonce((value) => value + 1);
    return result;
  }, [refreshRuntime]);

  const removeProject = useCallback(async (projectId: string) => {
    await deleteRuntimeProject(projectId);
    await refreshRuntime();
  }, [refreshRuntime]);

  const restartEmbeddedRuntime = useCallback(async () => {
    const status = await restartLocalRuntime();
    if (status) {
      setLocalRuntime(status);
      if (status.url) setControlPlaneUrlState(status.url);
    }
    setBootstrapNonce((value) => value + 1);
    return status;
  }, []);

  const refreshEmbeddedRuntime = useCallback(async () => {
    if (hostMode.desktop && getControlPlaneMode() === "local") {
      const status = await ensureLocalRuntime();
      if (status) {
        setLocalRuntime(status);
        if (status.url) setControlPlaneUrlState(status.url);
      }
      setBootstrapNonce((value) => value + 1);
      return status;
    }
    const status = await getLocalRuntimeStatus();
    if (status) setLocalRuntime(status);
    setBootstrapNonce((value) => value + 1);
    return status;
  }, [hostMode.desktop]);

  return {
    activeStreams,
    applyTeamChanges,
    agents,
    childrenByPath,
    configureControlPlane,
    connection,
    controlPlane,
    controlPlaneMode,
    controlPlaneUrl,
    configureControlPlaneMode,
    hostMode,
    localRuntime,
    refreshEmbeddedRuntime,
    restartEmbeddedRuntime,
    runtime,
    refreshRuntime,
    saveRuntime,
    openProject,
    addProject,
    removeProject,
    createSession,
    createAgent,
    createProvider,
    createPermissionRule,
    createMcpServer,
    deletePermissionRule,
    deleteMcpServer,
    discardTeamChanges,
    error,
    events,
    expandedPaths,
    health,
    loading,
    mcpServers,
    reconnectControlPlane,
    providers,
    permissionRules,
    refreshSkills,
    rootNodes,
    skills,
    resolveApproval,
    running,
    selectedSession,
    selectedAgentId,
    selectedSessionId,
    sendMessage,
    setSelectedAgentId,
    submitTask,
    cancelRun,
    startTeam,
    sessions,
    setSelectedSessionId,
    toggleDirectory,
    teamRunning,
    teamMessages,
    teamRuns,
  };
}

function isTeamEvent(event: SessionEvent): boolean {
  return event.type === "agent.spawned"
    || event.type === "agent.status"
    || event.type === "agent.message"
    || event.type.startsWith("team.");
}

const permissionEffectOrder = { deny: 0, ask: 1, allow: 2 } as const;

function comparePermissionRules(left: PermissionRule, right: PermissionRule): number {
  return permissionEffectOrder[left.effect] - permissionEffectOrder[right.effect] ||
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
