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


const CONTROL_PLANE_MODE_KEY = "prometheus.controlPlaneMode";

export type ControlPlaneMode = "local" | "remote";

export function getControlPlaneMode(): ControlPlaneMode {
  try {
    const stored = globalThis.localStorage?.getItem(CONTROL_PLANE_MODE_KEY);
    if (stored === "remote") return "remote";
  } catch {
    // ignore
  }
  return "local";
}

export function setControlPlaneMode(mode: ControlPlaneMode): ControlPlaneMode {
  try {
    globalThis.localStorage?.setItem(CONTROL_PLANE_MODE_KEY, mode);
  } catch {
    // ignore
  }
  if (mode === "local") {
    setControlPlaneUrl(DEFAULT_CONTROL_PLANE_URL);
  }
  return mode;
}



function normalizeControlPlaneUrl(url: string): string {

  return url.trim().replace(/\/+$/, "");

}



export function getDefaultControlPlaneUrl(): string {

  const fromEnv = import.meta.env.VITE_API_URL;

  if (typeof fromEnv === "string" && fromEnv.trim()) {

    return normalizeControlPlaneUrl(fromEnv);

  }

  // Server-hosted UI (production build or control-plane origin on :4310) is already on the
  // control plane. Use same-origin so this surface does not depend on a separately configured remote URL.
  if (typeof window !== "undefined") {
    try {
      const origin = window.location.origin;
      const port = window.location.port;
      const isTauriOrigin = origin.startsWith("tauri://") || origin.includes("tauri.localhost");
      const serverHosted = import.meta.env.PROD || port === "4310" || port === "";
      if (origin && !isTauriOrigin && serverHosted) {
        return normalizeControlPlaneUrl(origin);
      }
    } catch {
      // fall through
    }
  }

  // Tauri webview / Vite dev client talks to the local control plane sidecar by default.
  return DEFAULT_CONTROL_PLANE_URL;

}



export function getControlPlaneUrl(): string {

  if (getControlPlaneMode() === "local") {
    return getDefaultControlPlaneUrl();
  }

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



const ACCESS_TOKEN_STORAGE_KEY = "prometheus.accessToken";

/**
 * 控制平面访问令牌。
 *
 * 服务端在非 loopback 绑定时强制要求令牌；本机模式下服务端可能未配置令牌，
 * 此时返回空串，请求不携带任何凭证头。令牌按控制平面 URL 分别存储，
 * 避免切换远程实例时把 A 的令牌发给 B。
 */
export function getAccessToken(url = getControlPlaneUrl()): string {
  try {
    return globalThis.localStorage?.getItem(`${ACCESS_TOKEN_STORAGE_KEY}:${url}`) ?? "";
  } catch {
    return "";
  }
}

export function setAccessToken(token: string, url = getControlPlaneUrl()): void {
  const key = `${ACCESS_TOKEN_STORAGE_KEY}:${url}`;
  try {
    if (token.trim()) {
      globalThis.localStorage?.setItem(key, token.trim());
    } else {
      globalThis.localStorage?.removeItem(key);
    }
  } catch {
    // Ignore storage access failures; the caller still gets a working session.
  }
}

/** WebSocket 握手无法自定义请求头，因此令牌只能走查询参数。 */
function appendAccessToken(url: URL): URL {
  const token = getAccessToken();
  if (token) url.searchParams.set("token", token);
  return url;
}



function getSocketBase(): string {

  return getApiBase().replace(/^http/i, "ws");

}



/** 每次重连都重新读取令牌，避免用户在设置里改了令牌后旧 URL 一直失败。 */
function sessionSocketUrl(sessionId: string, afterSequence: number): string {

  const url = new URL(`${getSocketBase()}/ws`);

  url.searchParams.set("sessionId", sessionId);

  url.searchParams.set("afterSequence", String(afterSequence));

  return appendAccessToken(url).toString();

}



const healthSchema = z.object({

  status: z.literal("ok"),

  workspace: z.string(),

  workspaceRoot: z.string().optional(),

  host: z.string().optional(),

  port: z.number().int().optional(),

  mode: z.string().optional(),

  protocolVersion: z.number().int().optional(),

  terminalMode: z.enum(["disabled", "approval_per_session", "trusted"]).optional(),

  authRequired: z.boolean().optional(),

  capabilities: z.array(z.string()).optional(),

  timestamp: z.iso.datetime(),

});

/** 客户端支持的协议版本。服务端版本不同则字段语义可能已漂移。 */
export const SUPPORTED_PROTOCOL_VERSION = 1;



export type Health = z.infer<typeof healthSchema>;



export async function getHealth(): Promise<Health> {

  return healthSchema.parse(await request("/api/health"));

}



const runtimeProjectSchema = z.object({

  id: z.string(),

  name: z.string(),

  path: z.string(),

  lastOpenedAt: z.string(),

});



const runtimeSchema = z.object({

  host: z.string(),

  port: z.number().int(),

  workspaceRoot: z.string(),

  workspaceName: z.string(),

  runtimeFile: z.string(),

  dataFile: z.string(),

  mode: z.string(),

  restartRequired: z.boolean(),

  projects: z.array(runtimeProjectSchema),

  activeProjectId: z.string().nullable().optional(),

  listenHint: z.string(),

});



export type RuntimeProject = z.infer<typeof runtimeProjectSchema>;

export type RuntimeInfo = z.infer<typeof runtimeSchema>;



export async function getRuntime(): Promise<RuntimeInfo> {

  return runtimeSchema.parse(await request("/api/runtime"));

}



export async function updateRuntime(input: {

  host?: string;

  port?: number;

  workspaceRoot?: string;

}): Promise<RuntimeInfo> {

  return runtimeSchema.parse(

    await request("/api/runtime", {

      method: "PUT",

      body: JSON.stringify(input),

    }),

  );

}



export async function listRuntimeProjects(): Promise<{

  projects: RuntimeProject[];

  activeProjectId?: string | null;

}> {

  return z

    .object({

      projects: z.array(runtimeProjectSchema),

      activeProjectId: z.string().nullable().optional(),

    })

    .parse(await request("/api/runtime/projects"));

}



export async function addRuntimeProject(path: string, open = true): Promise<{

  project: RuntimeProject;

  activeProjectId?: string | null;

}> {

  return z

    .object({

      project: runtimeProjectSchema,

      activeProjectId: z.string().nullable().optional(),

    })

    .parse(

      await request("/api/runtime/projects", {

        method: "POST",

        body: JSON.stringify({ path, open }),

      }),

    );

}



export async function openRuntimeProject(projectId: string): Promise<{

  project: RuntimeProject;

  activeProjectId?: string | null;

}> {

  return z

    .object({

      project: runtimeProjectSchema,

      activeProjectId: z.string().nullable().optional(),

    })

    .parse(await request(`/api/runtime/projects/${projectId}/open`, { method: "POST" }));

}



export async function deleteRuntimeProject(projectId: string): Promise<void> {

  await request(`/api/runtime/projects/${projectId}`, { method: "DELETE" });

}



export async function readWorkspaceFile(path: string): Promise<{

  path: string;

  content: string;

  truncated: boolean;

}> {

  const result = await request(`/api/workspace/file?path=${encodeURIComponent(path)}`);

  return z

    .object({ path: z.string(), content: z.string(), truncated: z.boolean() })

    .parse(result);

}



export async function writeWorkspaceFile(path: string, content: string): Promise<{

  path: string;

  bytes: number;

}> {

  const result = await request("/api/workspace/file", {

    method: "PUT",

    body: JSON.stringify({ path, content }),

  });

  return z.object({ path: z.string(), bytes: z.number().int().nonnegative() }).parse(result);

}



export type TerminalExecResult = {
  exitCode: number | null;
  durationMs: number;
  output: string;
  totalBytes: number;
  timedOut: boolean;
  isError: boolean;
  command: string;
  workdir: string;
};

export async function execTerminal(input: {
  sessionId: string;
  command: string;
  workdir?: string;
  timeoutMs?: number;
}): Promise<TerminalExecResult> {
  const result = await request("/api/terminal/exec", {
    method: "POST",
    body: JSON.stringify({
      sessionId: input.sessionId,
      command: input.command,
      workdir: input.workdir ?? "",
      timeoutMs: input.timeoutMs ?? 10000,
    }),
  });
  return z
    .object({
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative(),
      output: z.string(),
      totalBytes: z.number().int().nonnegative(),
      timedOut: z.boolean(),
      isError: z.boolean(),
      command: z.string(),
      workdir: z.string(),
    })
    .parse(result);
}

export type WorkspaceSearchHit = {
  path: string;
  line: number;
  text: string;
};

export async function searchWorkspace(
  query: string,
  path = "",
  limit = 100,
): Promise<WorkspaceSearchHit[]> {
  const params = new URLSearchParams({
    q: query,
    path,
    limit: String(limit),
  });
  const result = await request(`/api/workspace/search?${params.toString()}`);
  return z
    .object({
      matches: z.array(
        z.object({
          path: z.string(),
          line: z.number().int().positive(),
          text: z.string(),
        }),
      ),
    })
    .parse(result).matches;
}

export async function listWorkspaceFiles(path = "", limit = 2000): Promise<string[]> {
  const params = new URLSearchParams({
    path,
    limit: String(limit),
  });
  const result = await request(`/api/workspace/files?${params.toString()}`);
  return z.object({ files: z.array(z.string()) }).parse(result).files;
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



export async function cancelAgentRuns(sessionId: string, runId?: string | null): Promise<{
  cancelledRunIds: string[];
  deniedApprovals: number;
}> {
  const result = await request(`/api/sessions/${sessionId}/runs/cancel`, {
    method: "POST",
    body: JSON.stringify(runId ? { runId } : {}),
  });
  return z
    .object({
      cancelledRunIds: z.array(z.string()),
      deniedApprovals: z.number().int().nonnegative(),
    })
    .parse(result);
}

export async function listActiveRuns(sessionId: string): Promise<string[]> {
  const result = await request(`/api/sessions/${sessionId}/runs/active`);
  return z.object({ runIds: z.array(z.string()) }).parse(result).runIds;
}

export function getTerminalWebSocketUrl(sessionId: string, cols = 120, rows = 32): string {
  const base = getControlPlaneUrl();
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/terminal";
  url.search = "";
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("cols", String(cols));
  url.searchParams.set("rows", String(rows));
  return appendAccessToken(url).toString();
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




export const teamTaskPatchSchema = z.object({
  teamRunId: z.string(),
  teamTaskId: z.string(),
  agentLabel: z.string(),
  status: z.string(),
  changedPaths: z.array(z.string()).default([]),
  disallowedPaths: z.array(z.string()).default([]),
  conflictPaths: z.array(z.string()).default([]),
  patchBytes: z.number().int().nonnegative(),
  patch: z.string(),
});

export type TeamTaskPatch = z.infer<typeof teamTaskPatchSchema>;

export async function getTeamTaskPatch(teamRunId: string, teamTaskId: string): Promise<TeamTaskPatch> {
  const result = await request(`/api/team-runs/${teamRunId}/tasks/${teamTaskId}/patch`);
  return z.object({ patch: teamTaskPatchSchema }).parse(result).patch;
}

export const livePendingApprovalSchema = z.object({
  approvalId: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  eventId: z.string(),
  createdAt: z.string(),
  toolName: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export type LivePendingApproval = z.infer<typeof livePendingApprovalSchema>;

export async function listLivePendingApprovals(): Promise<LivePendingApproval[]> {
  const result = await request("/api/approvals/pending");
  return z.object({ approvals: z.array(livePendingApprovalSchema) }).parse(result).approvals;
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

    socket = new WebSocket(sessionSocketUrl(sessionId, afterSequence));

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

  const token = getAccessToken();

  if (token && !headers.has("authorization")) {

    headers.set("authorization", `Bearer ${token}`);

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


export type ExtensionStore = {
  id: string;
  kind: "skills" | "mcp" | string;
  name: string;
  description: string;
  source: string;
  defaultConnected: boolean;
  homepage?: string | null;
};

export type ExtensionCatalogEntry = {
  id: string;
  storeId: string;
  kind: "skill" | "mcp" | string;
  name: string;
  description: string;
  homepage?: string | null;
  tags: string[];
  installed: boolean;
  install: Record<string, unknown>;
  config?: {
    requiredEnv?: string[];
    transport?: string;
  } | null;
};

export type ExtensionInstallResult =
  | { kind: "skill"; skill: SkillSummary }
  | { kind: "mcp"; server: McpServer };

export async function listExtensionStores(): Promise<ExtensionStore[]> {
  const response = await request("/api/extension-stores") as { stores: ExtensionStore[] };
  return response.stores;
}

export async function listExtensionCatalog(
  storeId: string,
  options?: { q?: string; refresh?: boolean },
): Promise<ExtensionCatalogEntry[]> {
  const params = new URLSearchParams();
  if (options?.q?.trim()) params.set("q", options.q.trim());
  if (options?.refresh) params.set("refresh", "true");
  const query = params.toString();
  const response = await request(
    `/api/extension-stores/${encodeURIComponent(storeId)}/catalog${query ? `?${query}` : ""}`,
  ) as { entries: ExtensionCatalogEntry[] };
  return response.entries;
}

export async function installExtension(
  storeId: string,
  input: {
    entryId: string;
    env?: Record<string, string>;
    enabled?: boolean;
  },
): Promise<ExtensionInstallResult> {
  const response = await request(`/api/extension-stores/${encodeURIComponent(storeId)}/install`, {
    method: "POST",
    body: JSON.stringify(input),
  }) as { result: ExtensionInstallResult };
  return response.result;
}

export async function installGithubSkill(input: {
  repo: string;
  path: string;
  ref?: string;
  skillId?: string;
}): Promise<SkillSummary> {
  const response = await request("/api/skills/install-github", {
    method: "POST",
    body: JSON.stringify(input),
  }) as { skill: SkillSummary };
  return response.skill;
}

