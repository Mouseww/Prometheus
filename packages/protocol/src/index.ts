import { z } from "zod";

export const sessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "completed",
  "failed",
]);

export const eventTypeSchema = z.enum([
  "message.user",
  "message.agent",
  "session.status",
  "agent.spawned",
  "agent.status",
  "agent.message",
  "tool.call.started",
  "tool.call.completed",
  "approval.requested",
  "approval.resolved",
  "permission.rule.matched",
  "system.notice",
  "agent.run.started",
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.cancelled",
  "team.workspace.created",
  "team.changes.detected",
  "team.changes.applied",
  "team.changes.conflicted",
  "team.workspace.discarded",
  "team.workspace.cleaned",
]);

export const providerKindSchema = z.enum([
  "openai",
  "openai_compatible",
  "anthropic",
  "gemini",
]);

export const actorSchema = z.object({
  kind: z.enum(["user", "agent", "system", "tool"]),
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
});

export const workspaceNodeSchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["directory", "file"]),
});

export const sessionSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(160),
  status: sessionStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastSequence: z.number().int().nonnegative(),
});

export const sessionEventSchema = z.object({
  sequence: z.number().int().positive(),
  eventId: z.uuid(),
  sessionId: z.uuid(),
  type: eventTypeSchema,
  actor: actorSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});

export const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(160),
});

export const appendEventSchema = z.object({
  eventId: z.uuid(),
  type: eventTypeSchema,
  actor: actorSchema,
  payload: z.record(z.string(), z.unknown()),
});

export const providerSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  kind: providerKindSchema,
  baseUrl: z.url().nullable(),
  defaultModel: z.string().min(1).max(160),
  hasApiKey: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: providerKindSchema,
    baseUrl: z.url().nullable().optional(),
    defaultModel: z.string().trim().min(1).max(160),
    apiKey: z.string().trim().min(1).max(4096),
  })
  .superRefine((value, context) => {
    if (value.kind === "openai_compatible" && !value.baseUrl) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Base URL is required for OpenAI-compatible providers",
      });
    }
  });

export const updateProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    baseUrl: z.url().nullable().optional(),
    defaultModel: z.string().trim().min(1).max(160).optional(),
    apiKey: z.string().trim().min(1).max(4096).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const agentProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(80),
  description: z.string().max(400),
  systemPrompt: z.string().min(1).max(40_000),
  providerId: z.uuid(),
  model: z.string().min(1).max(160),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createAgentProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).default(""),
  systemPrompt: z.string().trim().min(1).max(40_000),
  providerId: z.uuid(),
  model: z.string().trim().min(1).max(160),
});

export const updateAgentProfileSchema = createAgentProfileSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const createAgentRunSchema = z.object({
  agentId: z.uuid(),
});

export const teamRunStatusSchema = z.enum(["running", "completed", "failed", "interrupted"]);
export const teamRunTaskStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
]);
export const teamWorkspaceModeSchema = z.enum(["readonly", "worktree"]);
export const teamMergeStrategySchema = z.enum(["manual", "auto"]);
export const teamChangeStatusSchema = z.enum([
  "not_applicable",
  "isolated",
  "no_changes",
  "pending",
  "applied",
  "conflicted",
  "rejected",
  "discarded",
]);
export const teamOwnedPathSchema = z.string().trim().min(1).max(2_048)
  .transform(normalizeOwnedPath)
  .superRefine((value, context) => {
    const segments = value.split("/");
    if (
      value.startsWith("/")
      || /^[A-Za-z]:\//.test(value)
      || segments.some((segment) => segment === "." || segment === ".." || segment === ".git")
    ) {
      context.addIssue({ code: "custom", message: "Path must be a safe workspace-relative path" });
    }
  });
export const teamPathAssignmentSchema = z.object({
  agentId: z.uuid(),
  paths: z.array(teamOwnedPathSchema).min(1).max(64),
}).superRefine((value, context) => {
  if (new Set(value.paths.map(pathComparisonKey)).size !== value.paths.length) {
    context.addIssue({ code: "custom", path: ["paths"], message: "Assigned paths must be unique" });
  }
});
export const createTeamRunSchema = z.object({
  goal: z.string().trim().min(1).max(12_000),
  agentIds: z.array(z.uuid()).min(1).max(8),
  maxConcurrency: z.number().int().min(1).max(4).default(4),
  workspaceMode: teamWorkspaceModeSchema.default("readonly"),
  mergeStrategy: teamMergeStrategySchema.default("manual"),
  pathAssignments: z.array(teamPathAssignmentSchema).max(8).default([]),
}).superRefine((value, context) => {
  if (new Set(value.agentIds).size !== value.agentIds.length) {
    context.addIssue({
      code: "custom",
      path: ["agentIds"],
      message: "Agent IDs must be unique",
    });
  }
  if (value.workspaceMode === "readonly") {
    if (value.pathAssignments.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["pathAssignments"],
        message: "Readonly teams cannot assign writable paths",
      });
    }
    if (value.mergeStrategy !== "manual") {
      context.addIssue({
        code: "custom",
        path: ["mergeStrategy"],
        message: "Readonly teams must use manual merge strategy",
      });
    }
    return;
  }

  const selectedAgents = new Set(value.agentIds);
  const assignedAgents = value.pathAssignments.map((assignment) => assignment.agentId);
  if (
    assignedAgents.length !== value.agentIds.length
    || new Set(assignedAgents).size !== assignedAgents.length
    || assignedAgents.some((agentId) => !selectedAgents.has(agentId))
  ) {
    context.addIssue({
      code: "custom",
      path: ["pathAssignments"],
      message: "Worktree teams require exactly one path assignment for every selected Agent",
    });
    return;
  }

  const ownedPaths = value.pathAssignments.flatMap((assignment) =>
    assignment.paths.map((path) => ({ agentId: assignment.agentId, path })),
  );
  for (let left = 0; left < ownedPaths.length; left += 1) {
    for (let right = left + 1; right < ownedPaths.length; right += 1) {
      const first = ownedPaths[left]!;
      const second = ownedPaths[right]!;
      if (first.agentId === second.agentId) continue;
      if (pathsOverlap(first.path, second.path)) {
        context.addIssue({
          code: "custom",
          path: ["pathAssignments"],
          message: `Assigned paths overlap across Agents: ${first.path} and ${second.path}`,
        });
        return;
      }
    }
  }
});
export const teamRunTaskSchema = z.object({
  id: z.uuid(),
  teamRunId: z.uuid(),
  sessionId: z.uuid(),
  agentId: z.uuid(),
  agentLabel: z.string().min(1).max(128),
  prompt: z.string().min(1).max(12_000),
  status: teamRunTaskStatusSchema,
  output: z.string().max(1_000_000).nullable(),
  error: z.string().max(2_000).nullable(),
  allowedPaths: z.array(teamOwnedPathSchema).max(64).default([]),
  worktreeBranch: z.string().min(1).max(256).nullable().default(null),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable().default(null),
  changedPaths: z.array(teamOwnedPathSchema).max(2_000).default([]),
  changeStatus: teamChangeStatusSchema.default("not_applicable"),
  conflictPaths: z.array(teamOwnedPathSchema).max(2_000).default([]),
  patchBytes: z.number().int().nonnegative().default(0),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export const teamRunSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  goal: z.string().min(1).max(12_000),
  status: teamRunStatusSchema,
  maxConcurrency: z.number().int().min(1).max(4),
  workspaceMode: teamWorkspaceModeSchema.default("readonly"),
  mergeStrategy: teamMergeStrategySchema.default("manual"),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  tasks: z.array(teamRunTaskSchema).min(1).max(8),
});

export const teamMessageChannelSchema = z.enum(["direct", "shared", "decision", "question"]);
export const teamMessageRecipientSchema = z.union([
  z.literal("parent"),
  z.literal("*"),
  z.uuid(),
]);
export const teamMessageSchema = z.object({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  teamRunId: z.uuid(),
  sessionId: z.uuid(),
  senderAgentId: z.uuid(),
  senderLabel: z.string().min(1).max(128),
  recipientId: teamMessageRecipientSchema,
  recipientLabel: z.string().min(1).max(128),
  channel: teamMessageChannelSchema,
  subject: z.string().max(160).nullable(),
  body: z.string().min(1).max(12_000),
  sourceRunId: z.uuid().nullable(),
  sourceToolCallId: z.string().min(1).max(256).nullable(),
  createdAt: z.iso.datetime(),
});

export const permissionRuleToolSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.:*-]+$/, "toolName must be a tool identifier");
export const permissionRuleEffectSchema = z.enum(["deny", "ask", "allow"]);
export const createPermissionRuleSchema = z.object({
  toolName: permissionRuleToolSchema,
  effect: permissionRuleEffectSchema,
  pattern: z.string().trim().min(1).max(2_000),
});
export const permissionRuleSchema = createPermissionRuleSchema.extend({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
});

export const approvalDecisionSchema = z.enum(["approved", "denied"]);

export const resolveApprovalSchema = z.object({
  decision: approvalDecisionSchema,
});

export const approvalResolutionSchema = z.object({
  approvalId: z.uuid(),
  sessionId: z.uuid(),
  decision: approvalDecisionSchema,
});

export const agentRunResultSchema = z.object({
  runId: z.uuid(),
  replyEvent: sessionEventSchema,
  completedEvent: sessionEventSchema,
});

export const runStreamSnapshotSchema = z.object({
  sessionId: z.uuid(),
  runId: z.uuid(),
  agentId: z.uuid(),
  agentLabel: z.string().min(1).max(128),
  turn: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  text: z.string().max(1_000_000),
});

export const websocketEnvelopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sync"),
    events: z.array(sessionEventSchema),
  }),
  z.object({
    kind: z.literal("event"),
    event: sessionEventSchema,
  }),
  z.object({
    kind: z.literal("error"),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("run.stream.snapshot"),
    stream: runStreamSnapshotSchema,
  }),
  z.object({
    kind: z.literal("run.stream.delta"),
    sessionId: z.uuid(),
    runId: z.uuid(),
    turn: z.number().int().positive(),
    revision: z.number().int().positive(),
    delta: z.string().min(1).max(65_536),
  }),
  z.object({
    kind: z.literal("run.stream.cleared"),
    sessionId: z.uuid(),
    runId: z.uuid(),
  }),
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type EventType = z.infer<typeof eventTypeSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type WorkspaceNode = z.infer<typeof workspaceNodeSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type AppendEventInput = z.infer<typeof appendEventSchema>;
export type WebSocketEnvelope = z.infer<typeof websocketEnvelopeSchema>;
export type ProviderKind = z.infer<typeof providerKindSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type CreateProviderInput = z.infer<typeof createProviderSchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type CreateAgentProfileInput = z.infer<typeof createAgentProfileSchema>;
export type UpdateAgentProfileInput = z.infer<typeof updateAgentProfileSchema>;
export type CreateAgentRunInput = z.infer<typeof createAgentRunSchema>;
export type TeamRunStatus = z.infer<typeof teamRunStatusSchema>;
export type TeamRunTaskStatus = z.infer<typeof teamRunTaskStatusSchema>;
export type TeamWorkspaceMode = z.infer<typeof teamWorkspaceModeSchema>;
export type TeamMergeStrategy = z.infer<typeof teamMergeStrategySchema>;
export type TeamChangeStatus = z.infer<typeof teamChangeStatusSchema>;
export type TeamPathAssignment = z.infer<typeof teamPathAssignmentSchema>;
export type CreateTeamRunInput = z.input<typeof createTeamRunSchema>;
export type TeamRunTask = z.infer<typeof teamRunTaskSchema>;
export type TeamRun = z.infer<typeof teamRunSchema>;
export type TeamMessageChannel = z.infer<typeof teamMessageChannelSchema>;
export type TeamMessageRecipient = z.infer<typeof teamMessageRecipientSchema>;
export type TeamMessage = z.infer<typeof teamMessageSchema>;
export type PermissionRuleTool = z.infer<typeof permissionRuleToolSchema>;
export type PermissionRuleEffect = z.infer<typeof permissionRuleEffectSchema>;
export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export type CreatePermissionRuleInput = z.infer<typeof createPermissionRuleSchema>;
export type AgentRunResult = z.infer<typeof agentRunResultSchema>;
export type RunStreamSnapshot = z.infer<typeof runStreamSnapshotSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ResolveApprovalInput = z.infer<typeof resolveApprovalSchema>;
export type ApprovalResolution = z.infer<typeof approvalResolutionSchema>;

function normalizeOwnedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

function pathComparisonKey(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function pathsOverlap(first: string, second: string): boolean {
  const left = pathComparisonKey(first);
  const right = pathComparisonKey(second);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
