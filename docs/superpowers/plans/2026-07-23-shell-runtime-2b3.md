# Shell Runtime 2B3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Agent Runtime 增加真实、一次性、跨平台的 `shell_command`，并通过现有 durable event 与跨终端审批闭环安全执行。

**Architecture:** Shell 作为独立 `AgentTool` 注册，不把进程管理塞进 Provider adapter 或 UI。节点端只允许工作区内的真实目录作为 cwd，执行前统一经过现有 `ApprovalCoordinator`；进程输出以有限尾部返回，完整命令摘要和执行结果进入现有 session event log。第一版不提供 PTY、后台 session、stdin 续写或“自动允许”规则，因为这些能力需要独立的进程会话与 sandbox/permission policy。

**Tech Stack:** Node.js 24 `child_process.spawn`、TypeScript、Zod、Vitest、React 19、Fastify、Playwright/Python E2E。

---

## File map

- `apps/server/src/shell-command-tool.ts`: Shell tool schema、环境过滤、进程生命周期、超时/中止、输出截断。
- `apps/server/src/shell-command-tool.test.ts`: 通过公开 `AgentTool.execute` 验证真实命令、cwd、失败、超时与边界。
- `apps/server/src/workspace-service.ts`: 公开安全解析现有工作区目录的窄接口。
- `apps/server/src/index.ts`: 将 Shell tool 组合进现有 registry。
- `apps/client/src/event-description.ts`: 生成 write/shell 通用审批展示模型。
- `apps/client/src/App.tsx`: 使用展示模型渲染跨端审批卡片。
- `scripts/openai_compatible_fixture.py`: Fixture provider 发出真实 `shell_command` tool call。
- `scripts/e2e_shell_command.py`、`scripts/run_e2e_shell_command.py`: 浏览器双客户端批准命令并验证真实文件和 durable events。
- `docs/research/agent-tools-benchmark.md`: 固化本切片采用的成熟实现边界。
- `README.md`: 只声明已验收能力和明确未实现边界。

### Task 1: Workspace-bounded execution directory

- [x] 在 `workspace-service.test.ts` 写失败测试：根目录和真实子目录可解析；`..`、文件路径、符号链接外跳被拒绝。
- [x] 运行 `pnpm --filter @prometheus/server test -- workspace-service.test.ts`，确认新测试先失败。
- [x] 在 `WorkspaceService` 增加 `resolveDirectory(relativePath = ""): string`，内部复用 canonical containment check，且只返回真实目录。
- [x] 重跑该测试并保持现有文件读写测试全绿。

### Task 2: Real one-shot shell tool

- [x] 写单个 tracer test：调用 `shell_command` 后在工作区 cwd 执行真实命令，结果包含退出码和输出，tool 标记 `approval: "always"`。
- [x] 实现 `ShellCommandTool`：输入 `command`、`workdir`、`timeout_ms`；Windows 使用非交互 PowerShell，Unix 使用用户 shell或 `/bin/sh`；通过 `spawn` 参数传递命令。
- [x] 逐个增加测试与最小实现：非零退出码返回 `isError: true`；超时与 AbortSignal 终止进程；输出只保留最后 64 KiB 并声明总字节数；敏感环境变量不继承；工作区外 cwd 被拒绝。
- [x] 命令摘要保留可审阅命令、cwd、timeout，并对常见 secret assignment 做脱敏。

### Task 3: Cross-device approval presentation

- [x] 在 `event-description.test.ts` 写 shell 审批展示测试，要求标题为工作目录、详情为 Shell command、预览为命令、按钮为 Approve command/Deny command。
- [x] 在 `event-description.ts` 增加纯函数 `describeApprovalRequest`，保留 write_file 的既有文案。
- [x] `App.tsx` 改为消费该纯函数，避免 UI 内继续假设所有审批都是文件写入。
- [x] 侧栏将 Shell 标记为 connected，运行时标签更新为 Tool Runtime 2B3。

### Task 4: True end-to-end verification

- [x] Fixture provider 在收到 `Execute an approved shell command.` 时发出平台适配的 `shell_command`，命令在工作区创建 `shell-note.txt` 并打印证据。
- [x] Playwright 打开两个浏览器上下文：主终端发起任务，审阅终端批准；断言两端看到 resolution 和最终 agent 回复。
- [x] Python runner 启动真实 fixture、生产构建 server、临时 workspace；结束后读取 `shell-note.txt` 验证真实副作用。
- [x] 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`cargo check --manifest-path "apps/client/src-tauri/Cargo.toml"` 和 Shell E2E。

## Explicit non-goals

- PTY/交互式终端、后台进程 session、`write_stdin`。
- 操作系统级 sandbox、网络隔离、容器隔离。
- 持久化 allow/ask/deny command prefix rules。
- 服务重启后恢复正在运行的命令或 pending approval。

这些能力必须在后续切片中基于 Execution Node 与 durable process state 实现，当前界面不得标记为可用。
