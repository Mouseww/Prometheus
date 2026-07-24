# Read-only Tool Runtime 2B1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a configured Agent inspect the real workspace through `list_directory`, `read_file`, and `search_text`, feed durable tool results back to the model, and persist the final answer for every connected client.

**Architecture:** `@prometheus/agent-core` owns provider-neutral tool definitions, tool-call messages, provider adapters, and the sequential agent loop. The server owns workspace-bound implementations and translates loop lifecycle callbacks into the existing append-only session event log. No write, shell, approval, MCP, or SubAgent capability is exposed in this slice.

**Tech Stack:** TypeScript, Zod, official OpenAI/Anthropic/Google SDKs, Node filesystem APIs, SQLite durable events, Fastify, React, Vitest, Playwright.

---

### Task 1: Provider-neutral tool protocol

**Files:**
- Modify: `packages/agent-core/src/types.ts`
- Modify: `packages/agent-core/src/index.ts`
- Test: `packages/agent-core/src/agent-loop.test.ts`

- [x] Define `ToolDefinition`, `ToolCall`, `ToolResult`, `AgentTool`, and a message union that can represent assistant tool calls and tool results without provider-specific fields.
- [x] Allow `ProviderRequest.tools` and `ProviderResponse.toolCalls`; accept an empty text response only when at least one valid tool call exists.
- [x] Define an `AgentLoopEvent` union for tool start/completion and an `AgentLoopResult` containing final text, accumulated usage, and the last provider response ID.
- [x] Run `pnpm --filter @prometheus/agent-core test`; the new loop test must fail before the loop exists.

### Task 2: Official SDK tool-call mapping

**Files:**
- Modify: `packages/agent-core/src/providers/openai.ts`
- Modify: `packages/agent-core/src/providers/openai-compatible.ts`
- Modify: `packages/agent-core/src/providers/anthropic.ts`
- Modify: `packages/agent-core/src/providers/gemini.ts`
- Test: `packages/agent-core/src/providers.test.ts`

- [x] Add one adapter test per provider that supplies `read_file` and asserts the provider's native function/tool declaration shape.
- [x] Return normalized calls `{ id, name, arguments }` from OpenAI Responses `function_call`, Chat Completions `tool_calls`, Anthropic `tool_use`, and Gemini `functionCall` output.
- [x] Map normalized assistant tool-call messages and tool-result messages back into each provider's native conversation format for the next turn.
- [x] Keep existing text-only tests green and keep `EmptyProviderResponseError` for responses with neither text nor tool calls.

### Task 3: Sequential agent loop

**Files:**
- Create: `packages/agent-core/src/agent-loop.ts`
- Create: `packages/agent-core/src/agent-loop.test.ts`
- Modify: `packages/agent-core/src/index.ts`

- [x] Write a failing test where the provider first requests `read_file`, the tool returns workspace content, and the provider then returns a final answer.
- [x] Implement a bounded sequential loop with a maximum of eight provider turns.
- [x] Validate the tool name through the registry, validate arguments in the tool implementation, emit start/completed lifecycle events, append the assistant call plus tool result to in-memory context, then call the provider again.
- [x] Convert unknown tools, invalid arguments, and tool execution failures into `isError: true` tool results so the model can recover; do not manufacture a final assistant answer.
- [x] Accumulate usage across turns and fail explicitly if the turn limit is exceeded.

### Task 4: Workspace-bound read tools

**Files:**
- Modify: `apps/server/src/workspace-service.ts`
- Create: `apps/server/src/workspace-tools.ts`
- Test: `apps/server/src/workspace-tools.test.ts`

- [x] Write failing tests for a text file read, recursive text search, output truncation, ignored directories, binary rejection, and workspace traversal rejection.
- [x] Add bounded `readTextFile` and `searchText` operations to `WorkspaceService`, reusing one canonical containment check for list/read/search.
- [x] Implement `WorkspaceToolRegistry` with stable names and JSON schemas: `list_directory`, `read_file`, and `search_text`.
- [x] Return deterministic plain-text results with paths relative to the workspace root and explicit truncation notices.

### Task 5: Durable orchestration

**Files:**
- Modify: `apps/server/src/agent-run-service.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/src/agent-run-service.test.ts`

- [x] Write a failing service test for `message.user → agent.run.started → tool.call.started → tool.call.completed → message.agent → agent.run.completed`.
- [x] Inject the read-only tool registry into `AgentRunService` and call the agent loop rather than making one provider request.
- [x] Persist tool lifecycle payloads with `runId`, `toolCallId`, stable `toolName`, bounded arguments/output, and `isError`; publish them through the existing `EventHub`.
- [x] Keep provider/tool failures sanitized and preserve the existing no-reply-on-failure behavior.

### Task 6: Client rendering and real browser E2E

**Files:**
- Modify: `apps/client/src/App.tsx`
- Modify: `scripts/openai_compatible_fixture.py`
- Create: `scripts/e2e_readonly_tools.py`

- [x] Render `tool.call.started` as `Running <tool>` and `tool.call.completed` as a concise success/failure summary instead of raw payload JSON.
- [x] Extend the local protocol fixture so a specific prompt produces a real Chat Completions tool call, validates the returned tool result, then produces a final answer grounded in an actual repository file.
- [x] Run the server, client, and fixture through `with_server.py`; verify the durable sequence contains six events and capture a screenshot.
- [x] Assert browser console errors are empty and the final answer includes evidence read from the workspace.

### Task 7: Verification and scope documentation

**Files:**
- Modify: `docs/agent-runtime.md`
- Modify: `README.md`
- Modify: this plan

- [x] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `cargo check --manifest-path "apps/client/src-tauri/Cargo.toml"`.
- [x] Confirm the E2E ports are clear after testing.
- [x] Document that only the three read-only tools are connected; write/shell/approval/MCP/SubAgent remain planned.
- [x] Mark every completed checkbox and record exact verification evidence.

Verification on 2026-07-23: 41 tests passed; repository-wide typecheck and production build passed; Tauri `cargo check` passed. The 2B1 browser E2E completed a real OpenAI-compatible tool-call round trip against `README.md` with six durable events, and the original 2A text-only browser E2E also passed.

## Self-review

- The plan follows Pi's provider-independent loop, Codex's registry/lifecycle split, Grok Build's stable tool identity, LiveAgent's ordered durable log, and Claude Code's read-only permission boundary.
- No tool implementation imports an SDK; no provider adapter imports filesystem or server modules.
- No product fallback response or test-only Provider is added.
- Shell and write operations are intentionally absent until an approval and sandbox layer exists.
