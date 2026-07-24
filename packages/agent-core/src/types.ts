export interface TextAgentMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export type AgentMessage = TextAgentMessage | ToolResultMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export type ToolApprovalPolicy = "never" | "always";
export type ToolAuthorizationDecision = "approved" | "denied";
export interface ToolAuthorizationResult {
  decision: ToolAuthorizationDecision;
  message?: string;
}
export type ToolAuthorizationResponse = ToolAuthorizationDecision | ToolAuthorizationResult;

export interface AgentTool {
  approval?: ToolApprovalPolicy;
  definition: ToolDefinition;
  summarizeArguments?(argumentsValue: Record<string, unknown>): Record<string, unknown>;
  permissionTarget?(argumentsValue: Record<string, unknown>): string;
  execute(
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export interface ToolExecutionContext {
  toolCall: ToolCall;
}

export interface ToolAuthorizationRequest {
  tool: AgentTool;
  toolCall: ToolCall;
  signal: AbortSignal;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderRequest {
  model: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  toolCalls?: ToolCall[];
  usage?: ProviderUsage;
  providerResponseId?: string;
}

export type ProviderStreamEvent =
  | { type: "text.delta"; delta: string }
  | { type: "response.completed"; response: ProviderResponse };

export type AgentLoopEvent =
  | { type: "provider.turn.started"; turn: number }
  | { type: "assistant.text.delta"; turn: number; delta: string }
  | { type: "tool.started"; toolCall: ToolCall }
  | { type: "tool.completed"; toolCall: ToolCall; result: ToolResult };

export interface AgentLoopResult extends ProviderResponse {
  turns: number;
}

export interface ModelProvider {
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export interface ProviderRuntimeConfig {
  kind: "openai" | "openai_compatible" | "anthropic" | "gemini";
  apiKey: string;
  baseUrl: string | null;
}
