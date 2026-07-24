import { randomUUID } from "node:crypto";
import {
  runAgentLoop,
  type AgentMessage,
  type AgentTool,
  type ProviderFactory,
  type ProviderUsage,
} from "@prometheus/agent-core";
import {
  permissionRuleToolSchema,
  type AgentRunResult,
  type SessionEvent,
  type TeamWorkspaceMode,
} from "@prometheus/protocol";
import type { AgentRepository } from "./agent-repository.js";
import type { EventHub } from "./event-hub.js";
import type { ProviderRepository } from "./provider-repository.js";
import type { SessionRepository } from "./session-repository.js";
import { ApprovalCoordinator } from "./approval-coordinator.js";
import type { ToolPermissionPolicy } from "./tool-permission-policy.js";
import { RunStreamHub } from "./run-stream-hub.js";

export class AgentRunService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly agents: AgentRepository,
    private readonly providers: ProviderRepository,
    private readonly providerFactory: ProviderFactory,
    private readonly eventHub: EventHub,
    private readonly tools: AgentTool[] = [],
    private readonly approvals: ApprovalCoordinator = new ApprovalCoordinator(),
    private readonly permissionPolicy?: ToolPermissionPolicy,
    private readonly runStreams: RunStreamHub = new RunStreamHub(),
    private readonly runtimeToolFactory?: AgentRuntimeToolFactory,
    private readonly taskToolFactory?: AgentTaskToolFactory,
  ) {}

  async run(sessionId: string, agentId: string): Promise<AgentRunResult> {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new AgentRunValidationError("Session not found");
    const messages = buildHistory(this.sessions.listEvents(sessionId));
    if (messages.length === 0 || messages.at(-1)?.role !== "user") {
      throw new AgentRunValidationError("A user message is required before starting an agent run");
    }
    return this.#execute(sessionId, agentId, messages, { isSubagent: false });
  }

  async runTask(
    sessionId: string,
    agentId: string,
    task: string,
    metadata: AgentTaskMetadata,
  ): Promise<AgentRunResult> {
    if (!this.sessions.getSession(sessionId)) throw new AgentRunValidationError("Session not found");
    const prompt = task.trim();
    if (!prompt || prompt.length > 12_000) throw new AgentRunValidationError("Subagent task is invalid");
    return this.#execute(
      sessionId,
      agentId,
      [{ role: "user", content: prompt }],
      { isSubagent: true, ...metadata },
    );
  }

  async #execute(
    sessionId: string,
    agentId: string,
    messages: AgentMessage[],
    metadata: AgentExecutionMetadata,
  ): Promise<AgentRunResult> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new AgentRunValidationError("Agent not found");
    const provider = this.providers.getRuntime(agent.providerId);
    if (!provider) throw new AgentRunValidationError("Provider not found");

    const runId = randomUUID();
    const runtimeContext: AgentRuntimeToolContext = metadata.isSubagent
      ? {
          sessionId,
          runId,
          agentId: agent.id,
          agentLabel: agent.name,
          isSubagent: true,
          teamRunId: metadata.teamRunId,
          teamTaskId: metadata.teamTaskId,
        }
      : {
          sessionId,
          runId,
          agentId: agent.id,
          agentLabel: agent.name,
          isSubagent: false,
        };
    const executionTools = metadata.isSubagent && this.taskToolFactory
      ? this.taskToolFactory(metadata)
      : this.tools;
    const runtimeTools = [
      ...executionTools,
      ...(this.runtimeToolFactory?.(runtimeContext) ?? []),
    ];
    const metadataPayload = metadata.isSubagent ? {
      isSubagent: true,
      teamRunId: metadata.teamRunId,
      teamTaskId: metadata.teamTaskId,
      workspaceMode: metadata.workspaceMode ?? "readonly",
      allowedPaths: metadata.allowedPaths ?? [],
    } : {};
    this.commit(sessionId, {
      eventId: randomUUID(),
      type: "agent.run.started",
      actor: { kind: "agent", id: agent.id, label: agent.name },
      payload: {
        runId,
        agentId: agent.id,
        providerId: provider.id,
        model: agent.model,
        ...metadataPayload,
      },
    });

    try {
      const modelProvider = this.providerFactory.create({
        kind: provider.kind,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
      });
      const response = await runAgentLoop({
        provider: modelProvider,
        request: {
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          messages,
          signal: AbortSignal.timeout(120_000),
        },
        tools: runtimeTools,
        authorizeToolCall: async ({ tool, toolCall, signal }) => {
          const permissionTool = permissionRuleToolSchema.safeParse(tool.definition.name);
          const target = tool.permissionTarget?.(toolCall.arguments);
          if (this.permissionPolicy && permissionTool.success && target !== undefined) {
            const evaluation = this.permissionPolicy.evaluate(permissionTool.data, target);
            if (evaluation.rules.length > 0) {
              this.commit(sessionId, {
                eventId: randomUUID(),
                type: "permission.rule.matched",
                actor: { kind: "system", id: "permission-policy", label: "Permission Policy" },
                payload: {
                  runId,
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  effect: evaluation.decision,
                  arguments: summarizeToolArguments(tool, toolCall.arguments),
                  rules: evaluation.rules.map((rule) => ({ id: rule.id, pattern: rule.pattern })),
                  ...metadataPayload,
                },
              });
            }
            if (evaluation.decision === "allow") {
              return { decision: "approved" } as const;
            }
            if (evaluation.decision === "deny") {
              return {
                decision: "denied",
                message: "Tool execution denied by permission rule",
              } as const;
            }
          }
          const pending = this.approvals.create(sessionId, signal);
          const summarizedArguments = summarizeToolArguments(tool, toolCall.arguments);
          this.commit(sessionId, {
            eventId: randomUUID(),
            type: "approval.requested",
            actor: { kind: "system", id: "approval-gate", label: "Approval Gate" },
            payload: {
              approvalId: pending.approvalId,
              runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              arguments: summarizedArguments,
              ...metadataPayload,
            },
          });
          const decision = await pending.decision;
          this.commit(sessionId, {
            eventId: randomUUID(),
            type: "approval.resolved",
            actor: { kind: "system", id: "approval-gate", label: "Approval Gate" },
            payload: {
              approvalId: pending.approvalId,
              runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              decision,
              ...metadataPayload,
            },
          });
          return decision;
        },
        onEvent: (event) => {
          if (event.type === "provider.turn.started") {
            this.runStreams.startTurn({
              sessionId,
              runId,
              agentId: agent.id,
              agentLabel: agent.name,
              turn: event.turn,
            });
            return;
          }
          if (event.type === "assistant.text.delta") {
            this.runStreams.append(sessionId, runId, event.turn, event.delta);
            return;
          }
          if (event.type === "tool.started") {
            this.commit(sessionId, {
              eventId: randomUUID(),
              type: "tool.call.started",
              actor: { kind: "tool", id: event.toolCall.name, label: event.toolCall.name },
              payload: {
                runId,
                toolCallId: event.toolCall.id,
                toolName: event.toolCall.name,
                arguments: summarizeToolArguments(
                  runtimeTools.find((tool) => tool.definition.name === event.toolCall.name),
                  event.toolCall.arguments,
                ),
                ...metadataPayload,
              },
            });
            return;
          }
          this.commit(sessionId, {
            eventId: randomUUID(),
            type: "tool.call.completed",
            actor: { kind: "tool", id: event.toolCall.name, label: event.toolCall.name },
            payload: {
              runId,
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              output: event.result.content.slice(0, 8_000),
              outputTruncated: event.result.content.length > 8_000,
              isError: event.result.isError,
              ...metadataPayload,
            },
          });
        },
      });
      const replyEvent = this.commit(sessionId, {
        eventId: randomUUID(),
        type: "message.agent",
        actor: { kind: "agent", id: agent.id, label: agent.name },
        payload: { text: response.text, runId, ...metadataPayload },
      });
      this.runStreams.clear(sessionId, runId);
      const completedEvent = this.commit(sessionId, {
        eventId: randomUUID(),
        type: "agent.run.completed",
        actor: { kind: "agent", id: agent.id, label: agent.name },
        payload: {
          runId,
          providerResponseId: response.providerResponseId,
          usage: compactUsage(response.usage),
          ...metadataPayload,
        },
      });
      return { runId, replyEvent, completedEvent };
    } catch (error) {
      const message = sanitizeProviderError(error);
      this.commit(sessionId, {
        eventId: randomUUID(),
        type: "agent.run.failed",
        actor: { kind: "agent", id: agent.id, label: agent.name },
        payload: { runId, message, ...metadataPayload },
      });
      this.runStreams.clear(sessionId, runId);
      throw new AgentRunExecutionError(message);
    }
  }

  private commit(sessionId: string, input: Parameters<SessionRepository["appendEvent"]>[1]): SessionEvent {
    const event = this.sessions.appendEvent(sessionId, input);
    this.eventHub.publish(event);
    return event;
  }
}

export class AgentRunValidationError extends Error {}
export class AgentRunExecutionError extends Error {}

export interface AgentTaskMetadata {
  teamRunId: string;
  teamTaskId: string;
  workspaceMode?: TeamWorkspaceMode;
  workspaceRoot?: string;
  allowedPaths?: string[];
}

export type AgentTaskToolFactory = (metadata: AgentTaskMetadata) => AgentTool[];

export type AgentRuntimeToolContext =
  | {
      sessionId: string;
      runId: string;
      agentId: string;
      agentLabel: string;
      isSubagent: false;
    }
  | {
      sessionId: string;
      runId: string;
      agentId: string;
      agentLabel: string;
      isSubagent: true;
      teamRunId: string;
      teamTaskId: string;
    };

export type AgentRuntimeToolFactory = (context: AgentRuntimeToolContext) => AgentTool[];

type AgentExecutionMetadata =
  | { isSubagent: false }
  | ({ isSubagent: true } & AgentTaskMetadata);

function buildHistory(events: SessionEvent[]): AgentMessage[] {
  return events.flatMap((event) => {
    if (event.type !== "message.user" && event.type !== "message.agent") return [];
    if (event.payload.isSubagent === true) return [];
    const text = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
    if (!text) return [];
    return [{ role: event.type === "message.user" ? "user" as const : "assistant" as const, content: text }];
  });
}

function compactUsage(usage?: ProviderUsage): Record<string, number> | undefined {
  if (!usage) return undefined;
  return Object.fromEntries(
    Object.entries(usage).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

function compactToolArguments(argumentsValue: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(argumentsValue);
  if (serialized.length <= 4_000) return argumentsValue;
  return { summary: `Arguments omitted (${serialized.length} bytes)` };
}

function summarizeToolArguments(
  tool: AgentTool | undefined,
  argumentsValue: Record<string, unknown>,
): Record<string, unknown> {
  if (!tool?.summarizeArguments) return compactToolArguments(argumentsValue);
  try {
    return tool.summarizeArguments(argumentsValue);
  } catch {
    return { summary: "Tool arguments could not be summarized" };
  }
}

function sanitizeProviderError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/(api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 500);
  }
  return "Provider request failed";
}
