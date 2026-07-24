# Permission Rules 2B4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `shell_command` 与 `write_file` 增加节点级、SQLite 持久化的 deny/ask/allow 权限规则，并在 Web/Tauri 中真实管理和审计。

**Architecture:** 权限规则是 Control Plane 配置资源，独立于工具实现和审批 UI。`ToolPermissionPolicy` 通过工具提供的安全匹配目标求值；Shell 命令在引号感知的分隔符扫描后逐子命令匹配，deny 优先于 ask，只有每段都命中 allow 才跳过审批。规则命中写入现有 session durable log，未命中或复杂语法保持 ask。

**Tech Stack:** TypeScript、Zod、Node SQLite、Fastify、React 19、Vitest、Playwright/Python E2E。

---

## File map

- `packages/protocol/src/index.ts`: 权限规则 schema/type 与 `permission.rule.matched` 事件。
- `apps/server/src/permission-rule-repository.ts`: SQLite CRUD。
- `apps/server/src/tool-permission-policy.ts`: glob 匹配、Shell 分段与优先级求值。
- `apps/server/src/agent-run-service.ts`: allow/deny/ask 路由与 durable 审计。
- `apps/server/src/app.ts`: `/api/permission-rules` REST 资源。
- `apps/client/src/api.ts`、`use-prometheus.ts`: 真实规则状态与 mutation。
- `apps/client/src/App.tsx`、`styles.css`: Runtime 配置中的规则创建、列表和删除。
- `scripts/openai_compatible_fixture.py`: 生成自动允许与规则拒绝的真实 Shell tool calls。
- `scripts/e2e_permission_rules.py`、`run_e2e_permission_rules.py`: 浏览器配置规则后验证真实副作用和 deny 优先级。

### Task 1: Protocol and persistence resource

- [x] 先在 protocol test 写失败行为：只接受 `shell_command|write_file` 和 `deny|ask|allow`，pattern 必须非空且不超过 2000 字符。
- [x] 增加 `PermissionRule`、`CreatePermissionRuleInput` schema/type，并把 `permission.rule.matched` 加入 event type。
- [x] 在 database migration 创建 `permission_rules(id, tool_name, effect, pattern, created_at)` 与 tool/effect 索引。
- [x] 逐个红绿实现 repository 的 create/list/delete；list 按 deny、ask、allow 后按 created_at 稳定排序。

### Task 2: Conservative policy engine

- [x] 写 tracer test：`allow shell_command / pnpm test*` 自动允许单命令。
- [x] 写优先级测试：同一目标同时匹配 allow/ask/deny 时返回 deny；移除 deny 后返回 ask。
- [x] 写复合命令测试：`pnpm test && git status` 只有两个子命令分别命中 allow 才返回 allow。
- [x] 写复杂语法测试：命令替换、反引号、未闭合引号一律回退 ask；deny 规则仍可阻止明确匹配段。
- [x] 为 `shell_command` 提供原始 command 匹配目标，为 `write_file` 提供 workspace-relative path。

### Task 3: Runtime authorization and audit

- [x] 在 AgentRunService integration test 验证 allow rule 不产生 `approval.requested`、工具真实执行，并写 `permission.rule.matched(effect=allow)`。
- [x] 验证 deny rule 不执行工具、不产生 approval，并把“denied by permission rule”作为 error tool result 回灌 Provider。
- [x] 验证 ask rule 写 matched event 后继续现有跨端审批链路。
- [x] 保持没有规则时默认 ask，确保 2B2/2B3 行为不变。

### Task 4: API and multi-surface UI

- [x] 增加 `GET/POST/DELETE /api/permission-rules` 集成测试；不存在的删除返回 404。
- [x] Client 启动时加载规则，并在 mutation 成功后更新共享状态。
- [x] Runtime modal 增加工具、效果、pattern 表单与现有规则列表；明确显示 deny > ask > allow 和复合命令逐段匹配说明。
- [x] `permission.rule.matched` 在任务时间线显示具体 effect、tool 与 pattern，不显示 UI 私有状态。

### Task 5: True E2E

- [x] 通过 UI 创建 broad allow `node -e *` 与 narrow deny `*blocked-rule*`。
- [x] Agent 发起 allowed command，在没有审批卡的情况下创建 `allowed-rule.txt`，并看到 durable allow event。
- [x] Agent 发起同时命中 broad allow 和 narrow deny 的 command，确认不执行、不创建 `blocked-rule.txt`，并看到 durable deny event。
- [x] 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、Tauri cargo check、permission E2E，并回归 Shell ask 和 write approval E2E。

## Explicit non-goals

- OS filesystem/network sandbox 与 privilege escalation。
- 自动修改规则的“不要再问”审批按钮。
- 多用户/多租户 managed policy 层级。
- 完整 Bash/PowerShell AST；无法保守分析的语法始终 ask。
