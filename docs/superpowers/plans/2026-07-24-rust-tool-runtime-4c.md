# Prometheus 4C: Rust Tool Runtime + Approval Gate

> **For agentic workers:** 在 4B Agent text-run 上接入真实 tool loop、workspace 只读 tools、write/shell（approval always）与 approval HTTP 解析。

**Goal:** `POST /api/sessions/{id}/runs` 支持多轮 tool call；durable `tool.call.started/completed`；`POST .../approvals/{id}/resolution` 可用；OpenAI-compatible stream 解析 tool_calls。

**Architecture:**
- `WorkspaceService` 提供 list/read/search/write/resolve_directory
- `tools` 注册 5 个与 Node 一致的 tool 名
- `AgentRunService` 内嵌 bounded loop（max 8 turns）
- `ApprovalCoordinator` oneshot 等待审批
- Team 仍 501

**Tech:** Rust, tokio process for shell, reqwest SSE, SQLite events

---

### Task 1: Workspace filesystem primitives
- [x] read_text_file / search_text / write_text_file / resolve_directory（边界/忽略目录/截断/binary）

### Task 2: Tool registry
- [x] list_directory, read_file, search_text (never)
- [x] write_file, shell_command (always) + summarizeArguments

### Task 3: Provider tool protocol
- [x] request.tools + multi-role messages
- [x] SSE 聚合 tool_calls（id/name/arguments 分片）
- [x] 允许空 text + tool_calls

### Task 4: Agent loop + durable tool events
- [x] max 8 turns；unknown/invalid/exec error → isError tool result
- [x] events: tool.call.started/completed（output 截断 8000）

### Task 5: Approval gate
- [x] ApprovalCoordinator + resolve route
- [x] approval.requested / approval.resolved events

### Task 6: Verify
- [x] cargo test / clippy -D warnings
- [x] e2e_rust_readonly_tools.py 对真实 fixture

## Non-goals
- permission rules during run
- RunStreamHub
- team/worktree tools
- default entry switch to Rust

