import type { AgentTool } from "@prometheus/agent-core";
import {
  createTeamRunSchema,
  teamMessageChannelSchema,
  teamMessageRecipientSchema,
  type CreateTeamRunInput,
  type TeamMessage,
  type TeamRun,
} from "@prometheus/protocol";
import { z } from "zod";
import type { AgentRepository } from "./agent-repository.js";
import type { AgentRuntimeToolContext } from "./agent-run-service.js";
import type { TeamMessageRepository } from "./team-message-repository.js";
import type { TeamMessageService } from "./team-message-service.js";

interface TeamRunner {
  start(sessionId: string, input: CreateTeamRunInput): Promise<TeamRun>;
}

const sendMessageSchema = z.object({
  to: teamMessageRecipientSchema.default("parent"),
  message: z.string().trim().min(1).max(12_000),
  channel: teamMessageChannelSchema.optional(),
  subject: z.string().trim().max(160).optional(),
});
const readMessagesSchema = z.object({
  afterSequence: z.number().int().nonnegative().default(0),
  waitMs: z.number().int().min(0).max(5_000).default(0),
});

export class TeamRuntimeToolFactory {
  #teamRunner?: TeamRunner;

  constructor(
    private readonly agents: AgentRepository,
    private readonly messages: TeamMessageRepository,
    private readonly messageService: TeamMessageService,
  ) {}

  attachTeamRunner(teamRunner: TeamRunner): void {
    this.#teamRunner = teamRunner;
  }

  create(context: AgentRuntimeToolContext): AgentTool[] {
    return context.isSubagent
      ? [this.#sendMessageTool(context), this.#readMessagesTool(context)]
      : this.#primaryTools(context);
  }

  #primaryTools(context: Extract<AgentRuntimeToolContext, { isSubagent: false }>): AgentTool[] {
    const eligibleAgents = this.agents.list().filter((agent) => agent.id !== context.agentId);
    if (eligibleAgents.length === 0) return [];
    const eligibleIds = eligibleAgents.map((agent) => agent.id);
    const eligibleIdSet = new Set(eligibleIds);
    const inputSchema = createTeamRunSchema.superRefine((value, refinement) => {
      for (const [index, agentId] of value.agentIds.entries()) {
        if (!eligibleIdSet.has(agentId)) {
          refinement.addIssue({
            code: "custom",
            path: ["agentIds", index],
            message: "Agent is not available for delegation",
          });
        }
      }
    });
    const roster = eligibleAgents
      .map((agent) => `${agent.name} (${agent.id}): ${agent.description || agent.model}`)
      .join("\n");

    return [{
      approval: "never",
      definition: {
        name: "delegate_team",
        description: [
          "Delegate one team goal to one or more configured agents with isolated contexts.",
          "Independent agents run in parallel up to maxConcurrency. Subagents cannot delegate recursively.",
          "The default workspaceMode is readonly. Use worktree only with one non-overlapping path assignment per Agent.",
          "mergeStrategy=manual preserves reviewed patches for a user; auto applies only conflict-free patches.",
          "Include all context each agent needs in the goal because parent chat history is not copied.",
          "Available agents:",
          roster,
        ].join("\n"),
        inputSchema: {
          type: "object",
          properties: {
            goal: { type: "string", minLength: 1, maxLength: 12_000 },
            agentIds: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              uniqueItems: true,
              items: { type: "string", enum: eligibleIds },
            },
            maxConcurrency: { type: "integer", minimum: 1, maximum: 4, default: 4 },
            workspaceMode: { enum: ["readonly", "worktree"], default: "readonly" },
            mergeStrategy: { enum: ["manual", "auto"], default: "manual" },
            pathAssignments: {
              type: "array",
              maxItems: 8,
              default: [],
              description: "Required in worktree mode: exactly one entry per selected Agent with non-overlapping workspace-relative paths.",
              items: {
                type: "object",
                properties: {
                  agentId: { type: "string", enum: eligibleIds },
                  paths: {
                    type: "array",
                    minItems: 1,
                    maxItems: 64,
                    uniqueItems: true,
                    items: { type: "string", minLength: 1, maxLength: 2_048 },
                  },
                },
                required: ["agentId", "paths"],
                additionalProperties: false,
              },
            },
          },
          required: ["goal", "agentIds"],
          additionalProperties: false,
        },
      },
      summarizeArguments: (argumentsValue) => {
        const parsed = inputSchema.safeParse(argumentsValue);
        return parsed.success
          ? {
              goal: parsed.data.goal,
              agentIds: parsed.data.agentIds,
              maxConcurrency: parsed.data.maxConcurrency,
              workspaceMode: parsed.data.workspaceMode,
              mergeStrategy: parsed.data.mergeStrategy,
              pathAssignments: parsed.data.pathAssignments,
            }
          : { summary: "Invalid autonomous team delegation request" };
      },
      execute: async (argumentsValue, signal) => {
        if (signal.aborted) return { content: "Team delegation cancelled", isError: true };
        const input = inputSchema.safeParse(argumentsValue);
        if (!input.success) return { content: formatIssues(input.error), isError: true };
        if (!this.#teamRunner) return { content: "Team runtime is unavailable", isError: true };
        const team = await this.#teamRunner.start(context.sessionId, input.data);
        return {
          content: renderTeamResult(team, this.messages.list(team.id, 0)),
          isError: team.status !== "completed",
        };
      },
    }];
  }

  #sendMessageTool(
    context: Extract<AgentRuntimeToolContext, { isSubagent: true }>,
  ): AgentTool {
    return {
      approval: "never",
      definition: {
        name: "send_team_message",
        description: [
          "Send a durable message to parent, all agents (*), or one agent id in this team.",
          "Use channel=question for a requested reply and channel=decision for a shared durable decision.",
          "Do not use workspace files as an Agent communication channel.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "parent, *, or a team member agent UUID", default: "parent" },
            message: { type: "string", minLength: 1, maxLength: 12_000 },
            channel: { enum: ["direct", "shared", "decision", "question"] },
            subject: { type: "string", maxLength: 160 },
          },
          required: ["message"],
          additionalProperties: false,
        },
      },
      summarizeArguments: (argumentsValue) => {
        const input = sendMessageSchema.safeParse(argumentsValue);
        return input.success
          ? {
              to: input.data.to,
              channel: normalizeChannel(input.data.channel, input.data.to),
              subject: input.data.subject,
              messagePreview: preview(input.data.message, 240),
            }
          : { summary: "Invalid team message" };
      },
      execute: async (argumentsValue, signal, executionContext) => {
        if (signal.aborted) return { content: "Message send cancelled", isError: true };
        const input = sendMessageSchema.safeParse(argumentsValue);
        if (!input.success) return { content: formatIssues(input.error), isError: true };
        try {
          const message = this.messageService.send({
            teamRunId: context.teamRunId,
            senderAgentId: context.agentId,
            recipientId: input.data.to,
            channel: normalizeChannel(input.data.channel, input.data.to),
            subject: input.data.subject,
            body: input.data.message,
            sourceRunId: context.runId,
            sourceToolCallId: executionContext?.toolCall.id,
          });
          return {
            content: `Message sent to ${message.recipientLabel}.\nsequence=${message.sequence}\nchannel=${message.channel}`,
            isError: false,
          };
        } catch (error) {
          return { content: error instanceof Error ? error.message : "Message send failed", isError: true };
        }
      },
    };
  }

  #readMessagesTool(
    context: Extract<AgentRuntimeToolContext, { isSubagent: true }>,
  ): AgentTool {
    return {
      approval: "never",
      definition: {
        name: "read_team_messages",
        description: "Read durable shared, direct and self-sent team messages after a sequence. Optionally wait briefly for another agent.",
        inputSchema: {
          type: "object",
          properties: {
            afterSequence: { type: "integer", minimum: 0, default: 0 },
            waitMs: { type: "integer", minimum: 0, maximum: 5_000, default: 0 },
          },
          additionalProperties: false,
        },
      },
      execute: async (argumentsValue, signal) => {
        const input = readMessagesSchema.safeParse(argumentsValue);
        if (!input.success) return { content: formatIssues(input.error), isError: true };
        const messages = await this.#readWithWait(
          context.teamRunId,
          context.agentId,
          input.data.afterSequence,
          input.data.waitMs,
          signal,
        );
        return {
          content: messages.length > 0 ? renderMessages(messages) : "[No team messages]",
          isError: false,
        };
      },
    };
  }

  async #readWithWait(
    teamRunId: string,
    agentId: string,
    afterSequence: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<TeamMessage[]> {
    const deadline = Date.now() + waitMs;
    while (true) {
      const messages = this.messages.listVisibleTo(teamRunId, agentId, afterSequence);
      if (messages.length > 0 || Date.now() >= deadline || signal.aborted) return messages;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  }
}

function normalizeChannel(
  channel: z.infer<typeof teamMessageChannelSchema> | undefined,
  recipientId: z.infer<typeof teamMessageRecipientSchema>,
): z.infer<typeof teamMessageChannelSchema> {
  if (recipientId === "*") return !channel || channel === "direct" ? "shared" : channel;
  return channel === "shared" ? "direct" : channel ?? "direct";
}

function renderTeamResult(team: TeamRun, messages: TeamMessage[]): string {
  const results = team.tasks.map((task) => [
    `### ${task.agentLabel} · ${task.status}`,
    preview(task.output ?? task.error ?? "[No result]", 4_000),
  ].join("\n"));
  const parentMessages = messages.filter((message) =>
    message.recipientId === "parent" || message.recipientId === "*");
  return [
    `Team ${team.status}: ${team.tasks.filter((task) => task.status === "completed").length}/${team.tasks.length} completed`,
    ...results,
    parentMessages.length > 0 ? "## Team messages\n" + renderMessages(parentMessages) : "",
  ].filter(Boolean).join("\n\n");
}

function renderMessages(messages: TeamMessage[]): string {
  return messages.map((message) => [
    `#${message.sequence} ${message.senderLabel} -> ${message.recipientLabel} [${message.channel}]`,
    message.subject ? `Subject: ${message.subject}` : "",
    preview(message.body, 2_400),
  ].filter(Boolean).join("\n")).join("\n\n---\n\n");
}

function preview(value: string, maxLength: number): string {
  const text = value.trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 32)}\n[truncated; chars=${text.length}]`;
}

function formatIssues(error: z.ZodError): string {
  return `Invalid tool arguments: ${error.issues.map((issue) => issue.message).join("; ")}`;
}
