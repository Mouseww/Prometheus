# Prometheus 4D: Permission Rules + Run Stream Hub

> 在 4C tool loop 上接入真实 permission policy 与跨端 draft streaming。

**Goal:**
1. `write_file` / `shell_command` 执行前评估 permission rules（deny/ask/allow）
2. durable `permission.rule.matched`
3. `RunStreamHub`：`run.stream.snapshot|delta|cleared` 经 WebSocket 推送
4. provider SSE 文本 delta 实时广播；run 结束 clear

**Non-goals:** Team/worktree、默认切 Rust、GitHub packaging

### Tasks
- [x] ToolPermissionPolicy（glob、shell segment、precedence）
- [x] 接入 AgentRunService authorize 路径
- [x] RunStreamHub + WS 订阅/快照
- [x] provider 文本 delta 回调
- [x] contract tests + HTTP/WS E2E
- [x] README / plan 勾选
