# Approval-Gated Write Runtime 2B2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Prometheus 增加跨终端可处理的工具审批，以及审批后才会真实落盘的 `write_file` 工具。

**Architecture:** Agent Core 只负责在执行高风险工具前调用 provider-neutral 授权回调；Control Plane 的 `ApprovalCoordinator` 管理当前进程中的 pending resolver，并把请求与决定写入既有 session append-only event log。WebUI 通过资源化 REST 端点解决审批，所有终端通过现有 WebSocket 看到同一事件序列；工具层仅负责工作区边界、参数校验、敏感参数摘要和实际文件写入。

**Tech Stack:** TypeScript 5.9、Node.js 24、Fastify、Zod、SQLite、React、Vitest、Playwright、Tauri 2。

---

## File map

- `packages/agent-core/src/types.ts`: 工具审批元数据、授权回调与审批生命周期事件的公共类型。
- `packages/agent-core/src/agent-loop.ts`: 在工具执行前统一调用授权回调，拒绝结果作为 tool result 回灌模型。
- `packages/agent-core/src/agent-loop.test.ts`: Agent Loop 的批准、拒绝与无需审批行为测试。
- `apps/server/src/approval-coordinator.ts`: 进程内 pending approval 的创建、等待、单次解决和 session 归属校验。
- `apps/server/src/approval-coordinator.test.ts`: 协调器公开接口的并发与冲突测试。
- `apps/server/src/workspace-service.ts`: 安全解析可新建文件路径并执行有边界的 UTF-8 写入。
- `apps/server/src/workspace-service.test.ts`: 新文件、覆盖、越界、父目录缺失、符号链接与大小限制测试。
- `apps/server/src/workspace-tools.ts`: 注册 `write_file`，声明 `approval: "always"` 并提供脱敏参数摘要。
- `apps/server/src/workspace-tools.test.ts`: 工具定义、摘要和真实落盘测试。
- `apps/server/src/agent-run-service.ts`: 把授权请求接入协调器并提交 durable approval events。
- `apps/server/src/agent-run-service.test.ts`: 审批事件顺序、拒绝不执行、敏感内容不落日志测试。
- `apps/server/src/app.ts`: 资源化 approval resolution API 与 404/409 错误映射。
- `apps/server/src/app.test.ts`: 跨请求解决审批、重复解决和 session 隔离测试。
- `apps/server/src/index.ts`: 创建并注入唯一 `ApprovalCoordinator` 实例。
- `packages/protocol/src/index.ts`: approval decision 请求/响应 schema。
- `packages/protocol/src/index.test.ts`: 协议 schema 验证。
- `apps/client/src/api.ts`: approval resolution API 客户端。
- `apps/client/src/use-prometheus.ts`: 暴露审批操作及 busy/error 状态。
- `apps/client/src/App.tsx`: `approval.requested` 专用卡片及 Approve/Deny 操作。
- `apps/client/src/event-description.ts`: 审批事件的人类可读描述。
- `apps/client/src/styles.css`: 桌面与移动端审批卡片样式。
- `scripts/openai_compatible_fixture.py`: 可选择发起 `write_file` 并验证 tool result 回灌。
- `scripts/e2e_approval_write.py`: 临时工作区上的批准/拒绝真实 E2E。
- `docs/research/agent-tools-benchmark.md`: 记录成熟项目对审批分层的源码证据。
- `docs/agent-runtime.md`, `docs/architecture.md`, `README.md`: 记录真实能力、边界与运行方式。

### Task 1: Agent Core authorization seam

- [ ] 在 `agent-loop.test.ts` 增加一个 `approval: "always"` 工具测试：授权回调返回 `approved` 时，断言顺序为 `tool.started → approval.requested → approval.resolved → execute → tool.completed`，并验证结果被下一轮 provider 请求接收。
- [ ] 只运行 Agent Core 测试并确认因类型/回调缺失而失败：`pnpm --filter @prometheus/agent-core test`。
- [ ] 在 `types.ts` 增加 `ToolApprovalPolicy = "never" | "always"`、`ToolAuthorizationDecision = "approved" | "denied"`、`AgentTool.approval`、可选 `summarizeArguments()`、`authorizeToolCall` 输入及审批事件。
- [ ] 在 `agent-loop.ts` 中仅对已注册且 `approval === "always"` 的工具调用授权回调；拒绝时生成 `{ content: "Tool execution denied by user", isError: true }`，不得调用 `execute()`。
- [ ] 增加无需审批工具不触发授权回调、拒绝结果继续回灌模型的测试并运行至通过。

### Task 2: ApprovalCoordinator public behavior

- [ ] 创建失败测试：`create(sessionId, context)` 返回稳定 `approvalId` 与 `decision` promise；`resolve(sessionId, approvalId, decision)` 只允许解决一次。
- [ ] 实现最小 `ApprovalCoordinator`，内部仅保存当前进程 pending map；成功解决后立即从 pending map 移除。
- [ ] 增加错误行为：未知 approval 为 `ApprovalNotFoundError`，session 不匹配同样按 not found 处理以避免跨会话枚举，重复解决通过已解决 ID 集合返回 `ApprovalConflictError`。
- [ ] 运行 `pnpm --filter @prometheus/server test -- approval-coordinator.test.ts` 至通过。

### Task 3: Safe workspace write primitive

- [ ] 先写测试验证：在现有父目录中新建 UTF-8 文件并返回相对路径/字节数；覆盖普通文件成功。
- [ ] 实现 `WorkspaceService.writeTextFile(relativePath, content, maxBytes = 1 MiB)`：先做 lexical containment，再 `realpathSync(dirname(candidate))` 校验真实父目录仍在 root；不创建父目录。
- [ ] 增加测试并实现：拒绝 `..` 越界、绝对路径、缺失父目录、目录目标、目标 symlink、超过 1 MiB 的 UTF-8 内容。
- [ ] 使用单次 `writeFileSync` 写入，返回 `{ path, bytes }`；运行 workspace service 测试至通过。

### Task 4: write_file tool and secret-safe summaries

- [ ] 先写工具测试：registry 暴露 `write_file`，其 `approval` 为 `always`，执行后真实文件存在。
- [ ] 在 `WorkspaceToolRegistry` 注册 `write_file(path, content)`，使用 Zod 限制路径 2048 字符、内容最多 1 MiB。
- [ ] 为该工具实现 `summarizeArguments()`，只返回 `path`、UTF-8 `contentBytes`、最多 200 字符 `contentPreview`、SHA-256；不得返回完整 `content`。
- [ ] 让只读工具显式声明 `approval: "never"`，运行 workspace tool 测试至通过。

### Task 5: Durable approval lifecycle in AgentRunService

- [ ] 先写 service 测试：高风险工具在 resolve 前没有执行；事件为 `tool.call.started → approval.requested`，批准后为 `approval.resolved → tool.call.completed → message.agent → agent.run.completed`。
- [ ] 给 `AgentRunService` 注入 `ApprovalCoordinator`，将 Agent Core 的授权回调映射为 `create()`、durable request event、等待 decision、durable resolved event。
- [ ] `approval.requested.payload` 包含 `approvalId/runId/toolCallId/toolName/arguments`；arguments 使用工具自己的摘要器。`approval.resolved.payload` 包含同一关联 ID 和 `decision`。
- [ ] 增加拒绝测试：工具 `execute` 未调用，模型收到 error tool result，run 仍可生成最终答复。
- [ ] 增加日志脱敏测试：SQLite events 的 JSON 中不出现完整 `write_file.content`，但含 byte count、preview 和 hash。

### Task 6: Resource-oriented approval resolution API

- [ ] 在 protocol 中增加 `{ decision: "approved" | "denied" }` schema 和 response type 测试。
- [ ] 在 app integration test 中启动一个会等待审批的 run，并通过 `POST /api/sessions/{sessionId}/approvals/{approvalId}/resolution` 解决它。
- [ ] 实现端点：成功返回 200 和 `{ approval: { approvalId, sessionId, decision } }`；未知或跨 session 返回 404；重复解决返回 409。
- [ ] 确保 run HTTP 请求可以保持 pending，同时第二个终端请求能并发解决；运行 server 测试至通过。

### Task 7: Cross-device approval UI

- [ ] 为 event description 增加 `approval.requested` 与 `approval.resolved` 测试。
- [ ] 在 API 层增加 `resolveApproval(sessionId, approvalId, decision)`，按 protocol schema 校验响应。
- [ ] 在 hook 中暴露 `resolveApproval` action；避免用本地 pending state 作为真相源，按钮状态由 event log 中对应 `approval.resolved` 决定。
- [ ] 将 `TimelineEvent` 拆出审批卡片：显示工具名、路径、字节数、200 字符预览，以及 Approve/Deny；提交期间禁用按钮，另一终端解决后通过 WebSocket 自动显示结果。
- [ ] 增加可访问性标签、移动端布局和错误展示；运行 client tests、typecheck、build。

### Task 8: Real approve/deny E2E

- [ ] 扩展 OpenAI-compatible fixture：第一次响应发出 `write_file`，收到 matching tool result 后返回最终文本。
- [ ] 新建 E2E 脚本，为服务端设置临时 `PROMETHEUS_WORKSPACE_ROOT`、独立数据库和端口，不写 Prometheus 源码树。
- [ ] 批准路径：Playwright 等待审批卡片、点击 Approve、确认临时文件真实内容、最终答复和 durable event 顺序。
- [ ] 拒绝路径：点击 Deny、确认目标文件不存在、tool result 为 error、run 最终正常结束。
- [ ] 精确清理 fixture/server/client 子进程，确认测试端口未监听。

### Task 9: Documentation and complete verification

- [ ] 更新研究文档，记录 Codex approval orchestrator、Grok deny-by-default/ask 和 Pi before-event confirmation 的直接源码结论。
- [ ] 更新架构与运行时文档，明确当前审批 resolver 是进程内真实能力：多终端可处理，但 Control Plane 重启会中断 pending run，durable recovery 留给 scheduler 阶段。
- [ ] 更新 README 能力表，不宣称 Shell、重启恢复或未实现的策略规则。
- [ ] 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`。
- [ ] 运行 `cargo check --manifest-path "apps/client/src-tauri/Cargo.toml"`。
- [ ] 运行批准/拒绝 E2E，检查所有临时端口和进程已清理。

## Acceptance criteria

- 任一连接到同一 session 的终端都能看到并解决 pending `write_file` 审批。
- 未批准前文件系统零变更；拒绝后目标文件不存在或保持原内容。
- 审批只能被解决一次，且不能跨 session 解决。
- 完整文件内容不会进入 durable approval/tool-call events。
- 模型确实收到批准执行结果或拒绝错误结果，并能继续生成最终回复。
- 服务重启恢复 pending approval、Shell、目录自动创建均明确不在本切片范围内。
