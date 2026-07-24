import {
  type ApprovalDecision,
  type ApprovalResolution,
  type AppendEventInput,
  type AgentProfile,
  type AgentRunResult,
  type CreateAgentProfileInput,
  type CreateProviderInput,
  type CreateTeamRunInput,
  type Provider,
  type PermissionRule,
  type CreatePermissionRuleInput,
  type Session,
  type SessionEvent,
  type TeamMessage,
  type TeamRun,
  type WebSocketEnvelope,
  type WorkspaceNode,
  sessionEventSchema,
  sessionSchema,
  agentProfileSchema,
  agentRunResultSchema,
  approvalResolutionSchema,
  providerSchema,
  permissionRuleSchema,
  websocketEnvelopeSchema,
  workspaceNodeSchema,
  teamMessageSchema,
  teamRunSchema,
} from "@prometheus/protocol";
import { z } from "zod";

const CONTROL_PLANE_STORAGE_KEY = "prometheus.controlPlaneUrl";
const DEFAULT_CONTROL_PLANE_URL = "http://127.0.0.1:4310";

function normalizeControlPlaneUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function getDefaultControlPlaneUrl(): string {
  const fromEnv = import.meta.env.VITE_API_URL;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return normalizeControlPlaneUrl(fromEnv);
  }
  // Never derive from location.hostname: Tauri serves from tauri.localhost, which breaks
  // CSP connect-src and does not reach the local control-plane sidecar on 127.0.0.1:4310.
  return DEFAULT_CONTROL_PLANE_URL;
}

export function getControlPlaneUrl(): string {
  try {
    const stored = globalThis.localStorage?.getItem(CONTROL_PLANE_STORAGE_KEY);
    if (stored && stored.trim()) {
      return normalizeControlPlaneUrl(stored);
    }
  } catch {
    // Ignore storage access failures.
  }
  return getDefaultControlPlaneUrl();
}

export function setControlPlaneUrl(url: string): string {
  const normalized = normalizeControlPlaneUrl(url);
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error("Control plane URL must start with http:// or https://");
  }
  try {
    globalThis.localStorage?.setItem(CONTROL_PLANE_STORAGE_KEY, normalized);
  } catch {
    // Still return the normalized runtime value even if persistence fails.
  }
  return normalized;
}

function getApiBase(): string {
  return getControlPlaneUrl();
}

function getSocketBase(): string {
  return getApiBase().replace(/^http/i, "ws");
}

const healthSchema = z.object({
  status: z.literal("ok"),
  workspace: z.string(),
  timestamp: z.iso.datetime(),
});

export type Health = z.infer<typeof healthSchema>;

export async function getHealth(): Promise<Health> {
  return healthSchema.parse(await request("/api/health"));
}

export async function listWorkspace(path = ""): Promise<{
  rootName: string;
  path: string;
  nodes: WorkspaceNode[];
}> {
  const result = await request(`/api/workspace?path=${encodeURIComponent(path)}`);
  return z
    .object({ rootName: z.string(), path: z.string(), nodes: z.array(workspaceNodeSchema) })
    .parse(result);
}

export async function listSessions(): Promise<Session[]> {
  const result = await request("/api/sessions");
  return z.object({ sessions: z.array(sessionSchema) }).parse(result).sessions;
}

export async function createSession(title: string): Promise<Session> {
  const result = await request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return z.object({ session: sessionSchema }).parse(result).session;
}

export async function listEvents(sessionId: string): Promise<SessionEvent[]> {
  const result = await request(`/api/sessions/${sessionId}/events?afterSequence=0`);
  return z.object({ events: z.array(sessionEventSchema) }).parse(result).events;
}

export async function appendEvent(
  sessionId: string,
  input: AppendEventInput,
): Promise<SessionEvent> {
  const result = await request(`/api/sessions/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return z.object({ event: sessionEventSchema }).parse(result).event;
}

export async function listProviders(): Promise<Provider[]> {
  const result = await request("/api/providers");
  return z.object({ providers: z.array(providerSchema) }).parse(result).providers;
}

export async function createProvider(input: CreateProviderInput): Promise<Provider> {
  const result = await request("/api/providers", { method: "POST", body: JSON.stringify(input) });
  return z.object({ provider: providerSchema }).parse(result).provider;
}

export async function listAgents(): Promise<AgentProfile[]> {
  const result = await request("/api/agents");
  return z.object({ agents: z.array(agentProfileSchema) }).parse(result).agents;
}

export async function createAgent(input: CreateAgentProfileInput): Promise<AgentProfile> {
  const result = await request("/api/agents", { method: "POST", body: JSON.stringify(input) });
  return z.object({ agent: agentProfileSchema }).parse(result).agent;
}

export async function listPermissionRules(): Promise<PermissionRule[]> {
  const result = await request("/api/permission-rules");
  return z.object({ rules: z.array(permissionRuleSchema) }).parse(result).rules;
}

export async function createPermissionRule(input: CreatePermissionRuleInput): Promise<PermissionRule> {
  const result = await request("/api/permission-rules", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return z.object({ rule: permissionRuleSchema }).parse(result).rule;
}

export async function deletePermissionRule(ruleId: string): Promise<void> {
  await request(`/api/permission-rules/${ruleId}`, { method: "DELETE" });
}

export async function runAgent(sessionId: string, agentId: string): Promise<AgentRunResult> {
  const result = await request(`/api/sessions/${sessionId}/runs`, {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
  return z.object({ run: agentRunResultSchema }).parse(result).run;
}

export async function listTeamRuns(sessionId: string): Promise<TeamRun[]> {
  const result = await request(`/api/sessions/${sessionId}/team-runs`);
  return z.object({ teams: z.array(teamRunSchema) }).parse(result).teams;
}

export async function startTeamRun(
  sessionId: string,
  input: CreateTeamRunInput,
): Promise<TeamRun> {
  const result = await request(`/api/sessions/${sessionId}/team-runs`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return z.object({ team: teamRunSchema }).parse(result).team;
}

export async function listTeamMessages(teamRunId: string, afterSequence = 0): Promise<TeamMessage[]> {
  const result = await request(
    `/api/team-runs/${teamRunId}/messages?afterSequence=${encodeURIComponent(afterSequence)}`,
  );
  return z.object({ messages: z.array(teamMessageSchema) }).parse(result).messages;
}

export async function applyTeamTaskChanges(teamRunId: string, teamTaskId: string): Promise<TeamRun> {
  const result = await request(`/api/team-runs/${teamRunId}/tasks/${teamTaskId}/apply`, {
    method: "POST",
  });
  return z.object({ team: teamRunSchema }).parse(result).team;
}

export async function discardTeamTaskChanges(teamRunId: string, teamTaskId: string): Promise<TeamRun> {
  const result = await request(`/api/team-runs/${teamRunId}/tasks/${teamTaskId}/discard`, {
    method: "POST",
  });
  return z.object({ team: teamRunSchema }).parse(result).team;
}

export async function resolveApproval(
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<ApprovalResolution> {
  const result = await request(
    `/api/sessions/${sessionId}/approvals/${approvalId}/resolution`,
    { method: "POST", body: JSON.stringify({ decision }) },
  );
  return z.object({ approval: approvalResolutionSchema }).parse(result).approval;
}

export function subscribeToSession(
  sessionId: string,
  onEnvelope: (envelope: WebSocketEnvelope) => void,
  onConnection: (connected: boolean) => void,
): () => void {
  let active = true;
  let afterSequence = 0;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (!active) return;
    socket = new WebSocket(`${getSocketBase()}/ws?sessionId=${sessionId}&afterSequence=${afterSequence}`);
    socket.addEventListener("open", () => onConnection(true));
    socket.addEventListener("close", () => {
      onConnection(false);
      if (active) reconnectTimer = setTimeout(connect, 750);
    });
    socket.addEventListener("error", () => onConnection(false));
    socket.addEventListener("message", (message) => {
      const parsed = websocketEnvelopeSchema.safeParse(JSON.parse(String(message.data)));
      if (!parsed.success) return;
      if (parsed.data.kind === "sync") {
        afterSequence = Math.max(afterSequence, parsed.data.events.at(-1)?.sequence ?? 0);
      } else if (parsed.data.kind === "event") {
        afterSequence = Math.max(afterSequence, parsed.data.event.sequence);
      }
      onEnvelope(parsed.data);
    });
  };

  connect();
  return () => {
    active = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close(1000, "Session changed");
  };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers,
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return body;
}


export type SkillSummary = {
  id: string;
  name: string;
  description: string;
  path: string;
};

export type McpServer = {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
};

export async function listSkills(): Promise<SkillSummary[]> {
  const response = await request("/api/skills") as { skills: SkillSummary[] };
  return response.skills;
}

export async function listMcpServers(): Promise<McpServer[]> {
  const response = await request("/api/mcp-servers") as { servers: McpServer[] };
  return response.servers;
}

export async function createMcpServer(input: {
  name: string;
  command: string;
  args?: string[];
  enabled?: boolean;
}): Promise<McpServer> {
  const response = await request("/api/mcp-servers", {
    method: "POST",
    body: JSON.stringify(input),
  }) as { server: McpServer };
  return response.server;
}

export async function deleteMcpServer(serverId: string): Promise<void> {
  await request(`/api/mcp-servers/${serverId}`, { method: "DELETE" });
}
