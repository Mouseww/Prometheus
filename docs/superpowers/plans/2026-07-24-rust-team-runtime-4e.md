# Prometheus 4E: Readonly Team Runtime

> 在 4D 之上迁移 Node 3A 级只读 Team Runtime。

**Goal:**
1. Team run create/list/get API 与 SQLite 持久化
2. 有界并发子 Agent（maxConcurrency 1-4）
3. 子 Agent 独立 task prompt，不读父会话历史
4. 只读 tools：`list_directory` / `read_file` / `search_text`
5. durable `agent.spawned` / `agent.status` / subagent `message.agent`

**Non-goals:** worktree apply/discard、team messages bus、delegate_team tool、默认切 Rust

### Tasks
- [x] TeamRun models + repository
- [x] AgentRunService::run_task + 只读 tool filter
- [x] TeamRunService launch/execute
- [x] HTTP routes + residual 501 for worktree/messages
- [x] contract tests
- [x] README / plan
