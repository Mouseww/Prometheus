# Prometheus 4B: Rust Agent Runtime (text run vertical slice)

> **For agentic workers:** 用 RED→GREEN 完成 Rust `POST /api/sessions/{sessionId}/runs` 的真实编排，合同对齐 Node `AgentRunService` 的无工具文本 run。未迁移能力保持 501。

**Goal:** 在 `apps/server-rs` 中用真实 Provider HTTP 调用替换 `501 runtime_not_migrated` 的 Agent Run 路径：校验 session/agent/provider、从 durable events 重建 history、解密 API key、调用 OpenAI-compatible Chat Completions（stream）、写入 `agent.run.started` / `message.agent` / `agent.run.completed` 或 `agent.run.failed`。

**Architecture:** 保持 Node 为默认入口。Rust 控制面继续托管 SPA 与配置；4B 只增加 Agent text-run 纵切。Tools / approvals / streaming draft hub / team 仍 501。Provider 首切片仅 `openai_compatible`（+ 同协议的显式 baseUrl `openai` 可选后续）；`anthropic`/`gemini` 失败并写入 `agent.run.failed`。

**Tech Stack:** Rust 2024, axum 0.8, sqlx/sqlite, reqwest(stream+json+rustls), AES vault 兼容, 现有协议字段 camelCase。

---

## File structure

- `apps/server-rs/src/agent_run_service.rs` — 编排：history、events、provider 调用、错误消毒
- `apps/server-rs/src/providers/mod.rs` / `openai_compatible.rs` — Chat Completions stream 客户端
- `apps/server-rs/src/config_repository.rs` — `get_provider_runtime`（解密 key）
- `apps/server-rs/src/models.rs` — `CreateAgentRunInput` / `AgentRunResult`
- `apps/server-rs/src/error.rs` — `configuration_not_found` / `provider_request_failed`
- `apps/server-rs/src/app.rs` — wire `POST .../runs`
- `apps/server-rs/tests/agent_run_contract.rs` — HTTP contract + 本地 fixture
- `scripts/e2e_rust_agent_runtime.py` / `run_e2e_rust_agent_runtime.py` — 真实 fixture + Rust HTTP E2E
- `docs/superpowers/plans/2026-07-24-rust-agent-runtime-4b.md` — 本计划

---

### Task 1: Runtime provider + contract skeleton

- [x] RED: contract 创建 provider/agent/session/user message，POST run 仍 501。
- [x] GREEN: `RuntimeProvider { id, kind, base_url, api_key }` + `get_provider_runtime` 解密 vault。
- [x] VERIFY: 既有 config/api tests 仍绿。

### Task 2: OpenAI-compatible stream client

- [x] GREEN: `POST {baseUrl}/chat/completions`，`Authorization: Bearer`，`stream: true`，`stream_options.include_usage`。
- [x] GREEN: 解析 SSE `data:` chunks，聚合 text、providerResponseId、usage；tool_calls 暂返回错误（4B 无工具）。
- [x] GREEN: 非 2xx / 网络错误映射为可消毒消息。

### Task 3: AgentRunService orchestration

- [x] GREEN: `build_history` 仅 `message.user`/`message.agent` 且非 subagent、非空 text；最后一条必须是 user。
- [x] GREEN: 缺失 session/agent/provider → validation → HTTP 404 `configuration_not_found`（对齐 Node）。
- [x] GREEN: success path events: started → message.agent → completed；return `{ run: { runId, replyEvent, completedEvent } }` 201。
- [x] GREEN: failure path: `agent.run.failed` + 502 `provider_request_failed`；sanitize api key。

### Task 4: Route + residual 501

- [x] GREEN: 仅替换 runs 路由；approvals/team 仍 501。
- [x] VERIFY: `cargo test`、`cargo clippy -- -D warnings`。

### Task 5: E2E with real fixture

- [x] GREEN: 启动 `openai_compatible_fixture.py` + Rust server；HTTP 创建 config/session/message/run；断言 reply 文本与 durable events。
- [x] 可选：Playwright 双浏览器仍可不做（UI 同 Node 合同）。

### Task 6: Docs

- [x] README 标注 4B text-run 已迁移，tools/team/approval 仍 501；默认入口仍 Node。

## Explicit non-goals for 4B

- Tools / approval gate / permission rules during run
- RunStreamHub draft streaming over WebSocket
- Team / worktree / subagent runTask
- anthropic/gemini/openai Responses API
- Switching `pnpm dev` default to Rust
- GitHub packaging matrix

