# Parallel Team Runtime 3A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让用户从 GUI 选择 1-8 个已配置 Agent，以隔离上下文并发执行同一团队目标，并在任意连接终端实时看到每个 SubAgent 的状态、流式草稿和 durable 结果。

**Architecture:** `TeamRunService` 只负责编排和并发限制，`AgentRunService` 负责每个 Agent 的真实 Provider/tool loop；每个 SubAgent 使用显式 task message，不读取父会话聊天历史。SQLite 保存 team/task roster 与终态，session event log 保存 `agent.spawned`/`agent.status` 和每个 child run 的完整边界。`RunStreamHub` 从 session 单草稿改为 session 内多 run 草稿，避免并行输出互相覆盖。

**Tech Stack:** TypeScript、Node.js SQLite、Fastify、React 19、Zod、Vitest、Playwright、真实 OpenAI-compatible SSE fixture。

---

## File map

- `packages/protocol/src/index.ts`: Team run/task schema、并发上限、API 输入输出。
- `apps/server/src/database.ts`: `team_runs`、`team_run_tasks` 表和索引。
- `apps/server/src/team-run-repository.ts`: roster/status/result 持久化与中断恢复。
- `apps/server/src/agent-run-service.ts`: 抽出显式消息执行入口，primary 与 subagent 共用同一深模块。
- `apps/server/src/team-run-service.ts`: 有界 worker pool、失败隔离、durable lifecycle。
- `apps/server/src/run-stream-hub.ts`: 同 session 多 run active snapshot。
- `apps/server/src/app.ts`、`index.ts`: Team Run REST resources 和依赖接线。
- `apps/client/src/state.ts`、`api.ts`、`use-prometheus.ts`: 多草稿归并与 Team Run API。
- `apps/client/src/App.tsx`、`styles.css`: Team launcher、并行 Agent 状态和多草稿时间线。
- `scripts/openai_compatible_fixture.py`: 两个并行 Agent 的真实 SSE 回复。
- `scripts/e2e_team_runtime.py`、`run_e2e_team_runtime.py`: 双浏览器并行团队验收。

### Task 1: Versioned Team Run protocol

- [x] 在 protocol test 先覆盖 1-8 个唯一 `agentIds`、`maxConcurrency` 1-4、空 goal/重复 agent 拒绝。
- [x] 增加 `teamTaskStatus = queued | running | completed | failed | interrupted`。
- [x] 增加 `createTeamRunSchema = { goal, agentIds, maxConcurrency }`，并通过 `superRefine` 拒绝重复 agent。
- [x] 增加 `teamRunTaskSchema` 和 `teamRunSchema`，字段包含稳定 teamRunId/taskId、Agent 身份、prompt、status、output/error 和时间戳。

### Task 2: Durable roster repository

- [x] 先写 repository test：创建 roster、按 session 查询、状态转换、输出保存、重启恢复 running/queued 为 interrupted。
- [x] 新增 `team_runs` 与 `team_run_tasks`；task 通过外键关联 session/team/agent，删除 session 时级联。
- [x] 实现 `TeamRunRepository.create/get/listForSession/markTaskRunning/completeTask/failTask/completeRun/recoverInterrupted`。
- [x] 所有读取结果通过 protocol schema parse，不向调用方泄漏 SQLite row shape。

### Task 3: Multi-run stream hub

- [x] 修改 Hub 测试：同 session 两个 run 的 snapshot/delta 同时存在；clear A 不影响 B；late join 可枚举全部 active snapshot。
- [x] `RunStreamHub.list(sessionId)` 返回按启动顺序排列的 defensive copies；内部使用 `Map<sessionId, Map<runId, snapshot>>`。
- [x] WebSocket 连接在 durable sync 后逐个发送 active snapshot。
- [x] 客户端把 `activeStream` 改为 `activeStreams`；纯函数按 run ID 更新，revision gap 只丢弃对应 run delta，terminal durable event 只清对应 run。

### Task 4: Isolated child Agent execution

- [x] 先写 service test：child task 只向 Provider 发送自己的 user prompt，不带父会话 message history。
- [x] 将 `AgentRunService.run` 深化为共享私有执行模块；公开 `runTask(sessionId, agentId, task, metadata)`。
- [x] child run 的 `agent.run.started/message.agent/agent.run.completed|failed` payload 带 `teamRunId`、`teamTaskId`、`isSubagent: true`。
- [x] primary history 构建忽略 `payload.isSubagent === true`，避免团队结果污染下一次主 Agent 上下文。
- [x] child 继续复用真实 Provider streaming、workspace tools、权限规则和审批，不建立第二套 runtime。

### Task 5: Bounded parallel orchestrator

- [x] 先写失败测试：两个 task 在 barrier 前都进入 running，证明并行；单个失败后另一 task 仍完成；最大同时运行数不超过 `maxConcurrency`。
- [x] `TeamRunService.start` 创建 roster，依次提交 `agent.spawned`，然后用固定 worker pool 执行 task。
- [x] 每个 task 提交 `agent.status` 的 running 和 completed/failed；status payload 只保存有界 summary，完整 child reply 已由 `message.agent` 持久化。
- [x] team 终态：全部成功为 completed；任一失败为 failed，但返回所有 task 结果。
- [x] 服务启动调用 `recoverInterrupted`，不自动重放未完成 child task。

### Task 6: REST and GUI

- [x] 新增 `POST /api/sessions/{sessionId}/team-runs`、`GET /api/sessions/{sessionId}/team-runs`、`GET /api/team-runs/{teamRunId}`。
- [x] API 对不存在 Agent、跨 session team ID 和无效并发返回明确 404/422，不暴露外键错误。
- [x] Runtime 主界面增加 Team launcher：goal、Agent 多选、并发数；少于一个 Agent 时禁止启动。
- [x] 时间线同时渲染多个 `.streaming-event`；Team status panel 从 durable events/REST roster 显示 queued/running/completed/failed。
- [x] `SubAgent teams` 只在真实 API 可用时标为 connected；自动角色规划、Agent 间消息总线和 worktree 隔离仍在后续 3B/3C，不混入本切片声明。

### Task 7: Real cross-device E2E and docs

- [x] fixture 根据两个 Agent 的 system prompt 返回不同三段 SSE 文本，并保持并发请求重叠。
- [x] 两个浏览器进入同 session；A 启动两个 Agent，B 在终态前同时看到两个 streaming cards 和 running status。
- [x] 最终两端看到两个不同 durable reply；HTTP roster 显示 completed；session events 各有两个 spawned/running/completed、两个 `message.agent`。
- [x] 重载 B 后 Team roster 和回复仍存在；SQLite 中无 `run.stream.*`。
- [x] 更新 README、architecture、agent-runtime、benchmark research，明确参考 Pi/Codex/LiveAgent/Claude Code 的隔离、状态与并发边界。
- [x] 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、Tauri cargo check、Team E2E，并回归 streaming/read/write/Shell/permission E2E。

## Explicit non-goals for 3A

- 模型自主调用 `spawn_agent`。
- Agent-to-Agent message bus、direct/shared/decision/question channel。
- worktree 或容器级写隔离、结果自动合并。
- 进程重启后自动重放 running task。
- 跨 Execution Node 调度。

