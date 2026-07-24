import type {
  AgentLoopEvent,
  AgentLoopResult,
  AgentMessage,
  AgentTool,
  ModelProvider,
  ProviderRequest,
  ProviderUsage,
  ToolAuthorizationDecision,
  ToolAuthorizationResponse,
  ToolAuthorizationRequest,
  ToolCall,
  ToolResult,
} from "./types.js";
import { collectProviderStream } from "./provider-stream.js";

const DEFAULT_MAX_TURNS = 8;

export interface RunAgentLoopInput {
  provider: ModelProvider;
  request: ProviderRequest;
  tools: AgentTool[];
  maxTurns?: number;
  onEvent?: (event: AgentLoopEvent) => Promise<void> | void;
  authorizeToolCall?: (
    request: ToolAuthorizationRequest,
  ) => Promise<ToolAuthorizationResponse> | ToolAuthorizationResponse;
}

export async function runAgentLoop(input: RunAgentLoopInput): Promise<AgentLoopResult> {
  const messages: AgentMessage[] = [...input.request.messages];
  const toolsByName = new Map(input.tools.map((tool) => [tool.definition.name, tool]));
  const signal = input.request.signal ?? new AbortController().signal;
  const usage: ProviderUsage = {};
  let providerResponseId: string | undefined;

  for (let turn = 1; turn <= (input.maxTurns ?? DEFAULT_MAX_TURNS); turn += 1) {
    const request = {
      ...input.request,
      messages,
      tools: input.tools.map((tool) => tool.definition),
    };
    const response = input.provider.stream
      ? await (async () => {
          await input.onEvent?.({ type: "provider.turn.started", turn });
          return collectProviderStream(input.provider.stream!(request), async (delta) => {
          await input.onEvent?.({ type: "assistant.text.delta", turn, delta });
          });
        })()
      : await input.provider.generate(request);
    mergeUsage(usage, response.usage);
    providerResponseId = response.providerResponseId ?? providerResponseId;
    const toolCalls = response.toolCalls ?? [];

    if (toolCalls.length === 0) {
      const text = response.text.trim();
      if (!text) throw new Error("Provider returned neither text nor tool calls");
      return {
        text,
        turns: turn,
        providerResponseId,
        usage: Object.keys(usage).length > 0 ? usage : undefined,
      };
    }

    messages.push({ role: "assistant", content: response.text, toolCalls });
    for (const toolCall of toolCalls) {
      await input.onEvent?.({ type: "tool.started", toolCall });
      const result = await executeToolCall(
        toolsByName,
        toolCall,
        signal,
        input.authorizeToolCall,
      );
      await input.onEvent?.({ type: "tool.completed", toolCall, result });
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content,
        isError: result.isError,
      });
    }
  }

  throw new AgentLoopTurnLimitError(input.maxTurns ?? DEFAULT_MAX_TURNS);
}

export class AgentLoopTurnLimitError extends Error {
  constructor(maxTurns: number) {
    super(`Agent loop exceeded ${maxTurns} provider turns`);
  }
}

async function executeToolCall(
  toolsByName: Map<string, AgentTool>,
  toolCall: ToolCall,
  signal: AbortSignal,
  authorizeToolCall?: RunAgentLoopInput["authorizeToolCall"],
): Promise<ToolResult> {
  const tool = toolsByName.get(toolCall.name);
  if (!tool) {
    return { content: `Unknown tool: ${toolCall.name}`, isError: true };
  }
  try {
    if (tool.approval === "always") {
      const authorization = await authorizeToolCall?.({ tool, toolCall, signal }) ?? "denied";
      const decision = typeof authorization === "string" ? authorization : authorization.decision;
      if (decision === "denied") {
        return {
          content: typeof authorization === "string"
            ? "Tool execution denied by user"
            : authorization.message ?? "Tool execution denied",
          isError: true,
        };
      }
    }
    return await tool.execute(toolCall.arguments, signal, { toolCall });
  } catch (error) {
    return {
      content: error instanceof Error ? error.message.slice(0, 2_000) : "Tool execution failed",
      isError: true,
    };
  }
}

function mergeUsage(target: ProviderUsage, source?: ProviderUsage): void {
  if (!source) return;
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value = source[key];
    if (value !== undefined) target[key] = (target[key] ?? 0) + value;
  }
}
