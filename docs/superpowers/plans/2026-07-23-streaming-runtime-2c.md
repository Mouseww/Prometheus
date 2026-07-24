# Provider Streaming Runtime 2C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为四个内置 Provider 增加真实 token streaming，并让 Web/Tauri 多终端实时看到同一运行中回复，同时保持最终消息一次持久化和工具调用完成后才执行。

**Architecture:** `@prometheus/agent-core` 定义 provider-neutral 的 `ProviderStreamEvent`，每个适配器把原生 SDK 流映射为 text delta 与唯一 completed response；Agent Loop 发出 turn start/text delta，但仍只在完整 tool call 参数完成后执行工具。Control Plane 使用独立的进程内 `RunStreamHub` 保存 active snapshot、广播 delta，并在最终 durable `message.agent` 或失败事件后清理；SQLite 不保存逐 token 事件。WebSocket 新连接先收到 durable sync，再收到当前 active snapshot，客户端按 run/turn/revision 合并。

**Tech Stack:** TypeScript、OpenAI SDK Responses/Chat streams、Anthropic MessageStream、Google GenAI `generateContentStream`、Fastify WebSocket、React 19、Zod、Vitest、Python SSE fixture、Playwright。

---

## File map

- `packages/protocol/src/index.ts`: active run snapshot、delta、cleared WebSocket envelope schema/type。
- `packages/agent-core/src/types.ts`: `ProviderStreamEvent`、stream-capable `ModelProvider` 与 Agent Loop delta events。
- `packages/agent-core/src/provider-stream.ts`: 收集 stream completion 的共享不变量。
- `packages/agent-core/src/agent-loop.ts`: 每个 Provider turn 的 start/delta/completed 生命周期。
- `packages/agent-core/src/providers/*.ts`: 四个官方 SDK 的真实 streaming 映射。
- `apps/server/src/run-stream-hub.ts`: session-scoped active snapshot 与订阅广播。
- `apps/server/src/agent-run-service.ts`: 将 Agent Loop delta 路由到 RunStreamHub，终态仍持久化一次。
- `apps/server/src/app.ts`、`index.ts`: WebSocket active snapshot/delta/clear 连接。
- `apps/client/src/api.ts`、`state.ts`、`use-prometheus.ts`: 自动重连、stream revision 合并和终态清理。
- `apps/client/src/App.tsx`、`styles.css`: 真实运行中 assistant 草稿卡片。
- `scripts/openai_compatible_fixture.py`: OpenAI-compatible SSE chunk 与增量 tool-call 参数。
- `scripts/e2e_streaming.py`、`run_e2e_streaming.py`: 两浏览器真实跨端流式验收。

### Task 1: Versioned transient stream protocol

- [x] 在 protocol test 增加合法 snapshot/delta/cleared envelope，并拒绝空 delta、非正 revision 与缺失 run/session ID。
- [x] 增加以下协议，保持 durable `SessionEvent` 不变：

```ts
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
  // existing sync/event/error variants
  z.object({ kind: z.literal("run.stream.snapshot"), stream: runStreamSnapshotSchema }),
  z.object({
    kind: z.literal("run.stream.delta"),
    sessionId: z.uuid(), runId: z.uuid(), turn: z.number().int().positive(),
    revision: z.number().int().positive(), delta: z.string().min(1).max(65_536),
  }),
  z.object({ kind: z.literal("run.stream.cleared"), sessionId: z.uuid(), runId: z.uuid() }),
]);
```

### Task 2: Provider-neutral streaming Agent Loop

- [x] 先写失败测试：两个 delta 在 final response 前按顺序发出；含 tool call 的 turn 必须等 completed response 后才触发 `tool.started`；下一 turn 重新发 `provider.turn.started`。
- [x] 在 `types.ts` 定义唯一完成事件，不允许调用方从 delta 猜最终 tool call：

```ts
export type ProviderStreamEvent =
  | { type: "text.delta"; delta: string }
  | { type: "response.completed"; response: ProviderResponse };

export interface ModelProvider {
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export type AgentLoopEvent =
  | { type: "provider.turn.started"; turn: number }
  | { type: "assistant.text.delta"; turn: number; delta: string }
  | { type: "tool.started"; toolCall: ToolCall }
  | { type: "tool.completed"; toolCall: ToolCall; result: ToolResult };
```

- [x] 新增 `collectProviderStream`，要求恰好一个 `response.completed`；stream 提前结束或重复 completed 显式失败。
- [x] Agent Loop 每轮先发 turn started；内置 Provider 消费 `provider.stream()`，自定义/测试 Provider 没有 stream 时兼容原有 `generate()`；delta 只用于展示，工具执行只使用 completed response。

### Task 3: Four real SDK stream adapters

- [x] OpenAI Responses 使用 `responses.create({ stream: true })`，映射 `response.output_text.delta`，从 `response.completed.response` 解析完整文本、tool calls、usage 和 response id。
- [x] OpenAI-compatible Chat 使用 `chat.completions.create({ stream: true, stream_options: { include_usage: true } })`，按 tool-call index 累积 id/name/arguments，结束后统一 JSON 解析。
- [x] Anthropic 使用 `messages.stream(...)`；只把 `content_block_delta/text_delta` 暴露为文本 delta，最终结构从 `finalMessage()` 读取，避免执行半截 `input_json_delta`。
- [x] Gemini 使用 `models.generateContentStream(...)`；逐 chunk 发 `chunk.text`，累积完整文本、function calls，并保留最后 response id/usage。
- [x] 保留 `generate()` 兼容入口；内置 Agent Loop 统一优先调用 `stream()`，request/final mapper 在 SDK 语义允许处复用，不强迫非流式公开入口伪装成流式调用。

### Task 4: Session-scoped RunStreamHub

- [x] 为 `RunStreamHub` 写 start-turn、append、late snapshot、stale run rejection、clear 测试。
- [x] 实现单一职责 Hub：

```ts
class RunStreamHub {
  startTurn(input: Omit<RunStreamSnapshot, "revision" | "text">): void;
  append(sessionId: string, runId: string, turn: number, delta: string): void;
  current(sessionId: string): RunStreamSnapshot | undefined;
  clear(sessionId: string, runId: string): void;
  subscribe(sessionId: string, listener: (envelope: RunStreamEnvelope) => void): () => void;
}
```

其中 `RunStreamEnvelope` 是 `WebSocketEnvelope` 中三个 `run.stream.*` variant 的 `Extract` 类型，不建立第二份协议定义。

- [x] AgentRunService 在 `provider.turn.started` 调用 `startTurn`，在 delta 调用 `append`；提交最终 `message.agent` 后清理，失败路径提交 `agent.run.failed` 后也清理。
- [x] 集成测试断言 delta 可实时订阅、最终 SQLite 事件仍只有一个 `message.agent`，且失败不会留下 active snapshot。

### Task 5: WebSocket and client live draft

- [x] `buildApp` 接收同一 RunStreamHub；WebSocket 注册 stream listener，并在连接时发送当前 snapshot；socket close/error 同时释放两个 listener。
- [x] `subscribeToSession` 记录已收到的最大 durable sequence，异常断线后以该 cursor 自动重连；主动 unsubscribe 不重连。
- [x] 在 `state.ts` 增加纯函数：snapshot 替换当前草稿；同 run/turn 且 revision 连续的 delta 追加；过期 delta 忽略；cleared 或 durable terminal event 清空。
- [x] `usePrometheus` 暴露 `activeStream`；切换 session 时清空，WebSocket stream envelope 更新它，`message.agent`/`agent.run.failed` 清除同 run 草稿。
- [x] Timeline 在 durable events 之后渲染 `.streaming-event`，显示 Agent 名、`streaming · turn N`、实时文本与光标；空文本显示“Waiting for provider output…”。

### Task 6: True cross-device streaming E2E and docs

- [x] fixture 对所有 Chat Completions 请求断言 `stream: true`，输出真实 `text/event-stream`；文本至少分三段并延迟发送，tool-call arguments 至少分两段。
- [x] 两个浏览器连接同一 session：A 发任务，B 在最终 durable 回复出现前看到第一段和增长后的第二段；最终两端草稿消失并显示完全一致的 durable reply。
- [x] 通过 HTTP 读取 session events，断言只有最终 `message.agent`，不存在逐 token durable event；重载 B 后仍从 SQLite 看到最终全文。
- [x] 更新 README、architecture、agent-runtime 和 benchmark research，明确 2C 的 transient/durable 边界与仍未支持的 provider stream restart recovery。
- [x] 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、Tauri cargo check、streaming E2E，并回归 read-only tool、write approval、Shell 与 permission rule E2E。

## Explicit non-goals

- Provider stream 在 Control Plane 重启后的恢复。
- 用户取消 API、steering/follow-up queue。
- reasoning/thinking token 展示。
- 将逐 token delta 写入 SQLite。
- PTY、后台进程、OS sandbox、SubAgent、MCP、SSH 或 scheduler。
