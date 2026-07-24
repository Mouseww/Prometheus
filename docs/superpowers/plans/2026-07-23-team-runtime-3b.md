# Autonomous Team Delegation 3B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让主 Agent 能在真实 Provider tool loop 中自主委派已配置 Agent 团队，并让 child Agent 通过 durable message bus 交换 direct/shared/decision/question 消息。

**Architecture:** `TeamRuntimeToolFactory` 按执行身份生成动态工具：primary 只获得 `delegate_team`，subagent 只获得 `send_team_message`/`read_team_messages`，从结构上禁止递归 spawn。`TeamMessageRepository` 是 SQLite 真相源，`TeamMessageService` 在持久化后提交 `agent.message` session event。委派工具仍调用 3A `TeamRunService`，不建第二套调度器。

**Tech Stack:** TypeScript、Zod、Node.js SQLite、Fastify、React 19、Vitest、Playwright、OpenAI-compatible SSE fixture。

---

## File map

- `packages/protocol/src/index.ts`: message channel/record schema 与 `agent.message` event type。
- `apps/server/src/database.ts`: `team_messages` durable table/index。
- `apps/server/src/team-message-repository.ts`: 收件人校验、append/list/wait query。
- `apps/server/src/team-message-service.ts`: message 持久化与 session event 原子顺序边界。
- `apps/server/src/team-runtime-tools.ts`: 主 Agent 委派工具和 child message tools。
- `apps/server/src/agent-run-service.ts`: 按 execution context 组合静态/动态工具。
- `apps/server/src/app.ts`: TeamMessage 只读资源 API。
- `apps/client/src/api.ts` / `use-prometheus.ts`: message bus 加载与跨端刷新。
- `apps/client/src/App.tsx` / `styles.css`: Team summary 内的通信面板。
- `scripts/openai_compatible_fixture.py`: coordinator 委派、research 发送、review 读取的真实 tool/SSE 对话。
- `scripts/e2e_autonomous_team.py`: 双浏览器自主团队验收。

### Task 1: Versioned message protocol

- [x] RED: protocol test 验证 `direct/shared/decision/question`、有界 subject/body、正整 UUID/team sequence 和 `agent.message` event。
- [x] GREEN: 增加 `teamMessageChannelSchema`、`teamMessageSchema`、`TeamMessage` 类型和 event type。
- [x] VERIFY: `pnpm --filter @prometheus/protocol test` 通过。

### Task 2: Durable message bus

- [x] RED: repository/service test 覆盖 append/list、顺序、broadcast/parent/direct 收件人、非 team 成员拒绝和 durable `agent.message`。
- [x] GREEN: 新增 `team_messages`，body 最大 12,000 字符，subject 最大 160，每条消息保存 source run/tool call。
- [x] GREEN: `TeamMessageService.send` 先 append repository，再 append/publish session event，不建 UI 私有通道。
- [x] VERIFY: focused server tests 通过。

### Task 3: Context-aware runtime tools

- [x] RED: AgentRunService test 验证 primary 能看到 `delegate_team`，child 只看到 send/read message tools，child 不能递归 delegate。
- [x] GREEN: 增加 `AgentRuntimeToolContext`/factory port，每次 run 在已知 runId 后构建 runtime tools，tool lifecycle 继续写同一 event log。
- [x] RED: `TeamRuntimeToolFactory` test 验证 agent ID 白名单、数量/并发上限、非成员收件人拒绝、afterSequence 读取。
- [x] GREEN: `delegate_team` 返回有界 Agent 结果与 parent/shared messages；message tools 使用 `parent`/`*`/成员 UUID 稳定地址。
- [x] VERIFY: provider-neutral loop 的工具结果回灌与现有审批/权限测试均不回归。

### Task 4: Resource API and cross-device UI

- [x] RED: API test 覆盖 `GET /api/team-runs/{teamRunId}/messages?afterSequence=N`、缺失 team 404 和参数 400。
- [x] GREEN: 客户端在 team/event 刷新时并行拉取 roster 与 message bus，不串行制造 waterfall。
- [x] GREEN: Team summary 显示 channel、sender/recipient、subject/body，使用 bounded list 和 `content-visibility`。
- [x] GREEN: `agent.message` 时间线文案不 dump 原始 JSON，footer 升级 protocol v0.7。

### Task 5: Real autonomous delegation E2E

- [x] RED: fixture 的 coordinator 首轮必须调用 `delegate_team`，research 调用 send，review 调用 read，coordinator 只在完整 tool result 后返回终答。
- [x] GREEN: 双浏览器 E2E 验证用户只发一条主 Agent 请求，然后出现 TeamRun、durable bus message、两个 child reply 和主 Agent 汇总。
- [x] GREEN: HTTP 验证 `delegate_team` tool lifecycle、`agent.message`、team completed、message API 和 reload 恢复。
- [x] VERIFY: 不存在产品内置固定回复或假 Agent result。

### Task 6: Documentation and regression

- [x] 更新 README、architecture、agent-runtime 和 benchmark，引用 Pi `65ff8e7`、LiveAgent `a22bd6f`、Codex `34b935e` 的工具/通信边界。
- [x] 明确 3B 不支持 worktree 隔离/自动 merge、运行中外部强制唤醒、重启后继续 provider request 和跨节点调度。
- [x] 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、Tauri cargo check、Autonomous Team E2E 与既有六条 E2E。

## Explicit non-goals for 3B

- worktree/容器写隔离、patch apply 和自动 merge。
- child Agent 再次调用 `delegate_team`的递归委派。
- 向 idle Agent 的外部强制唤醒或中断转向。
- Control Plane 重启后继续未完成 Provider/tool request。
- 跨 Execution Node 调度。

