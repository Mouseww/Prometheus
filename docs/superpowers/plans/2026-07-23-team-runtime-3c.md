# Isolated Team Workspaces 3C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Team Runtime 增加真实 Git worktree 写隔离、显式路径所有权、durable 变更审计、保守 patch apply、冲突保留和安全清理，并让 Web/Tauri 客户端可以跨端操作待合并结果。

**Architecture:** `GitWorktreeManager` 封装仓库发现、worktree 创建、changed-path 审计、二进制 patch 生成、保守 apply 与 cleanup；`TeamRunService` 只编排 task 生命周期，不拼 Git 命令。团队默认 `readonly`，child 只获得只读工具；`worktree` 模式要求每个 Agent 拥有互不重叠的显式路径，child 的文件与 Shell 工具绑定到独立 workspace root。变更状态保存在 SQLite，自动合并只执行可通过 `git apply --check` 的 patch，冲突或越界变更永不覆盖父工作区并保留 worktree。

**Tech Stack:** TypeScript、Zod、Node.js SQLite、Fastify、React 19、Vitest、Git CLI、Playwright、OpenAI-compatible SSE fixture。

---

## File map

- `packages/protocol/src/index.ts`: workspace mode、merge strategy、path assignment、change status 和 task durable fields。
- `packages/protocol/src/index.test.ts`: 协议默认值、路径安全、完整 Agent assignment 和重叠路径拒绝。
- `apps/server/src/database.ts`: 3C 向后兼容列迁移。
- `apps/server/src/git-worktree-manager.ts`: Git worktree 深模块，唯一负责 Git 生命周期与 patch。
- `apps/server/src/git-worktree-manager.test.ts`: 临时真实 Git 仓库的创建、审计、apply、冲突与 cleanup。
- `apps/server/src/team-run-repository.ts`: workspace metadata 与 change status 持久化。
- `apps/server/src/team-run-service.ts`: readonly/worktree task 编排、auto/manual apply、discard 和重启后保留状态。
- `apps/server/src/agent-run-service.ts`: child execution tool factory，避免 child 继承父工作区写工具。
- `apps/server/src/workspace-tools.ts`: 分离只读工具集合和完整工具集合。
- `apps/server/src/app.ts`: async GUI team launch、manual apply 和 explicit discard API。
- `apps/server/src/index.ts`: worktree root 配置和运行时依赖装配。
- `apps/client/src/api.ts` / `use-prometheus.ts`: apply/discard action 与 durable team refresh。
- `apps/client/src/App.tsx` / `styles.css`: workspace mode、merge strategy、每 Agent 路径所有权、变更/冲突面板。
- `scripts/openai_compatible_fixture.py`: 3C child 的真实 write tool conversation。
- `scripts/e2e_team_worktree.py` / `run_e2e_team_worktree.py`: 临时 Git 仓库、跨端审批、manual apply 和 reload 验收。
- `docs/research/agent-tools-benchmark.md`: 记录固定源码版本和 3C 直接结论。
- `docs/architecture.md` / `agent-runtime.md` / `README.md`: 只声明已验收边界。

### Task 1: Versioned isolation protocol

- [x] RED: protocol test 验证 `readonly` 默认值、`manual` 默认值、worktree 模式必须为每个 Agent 提供一次 path assignment、拒绝绝对路径/`.`/`..`/跨 Agent 前缀重叠。
- [x] GREEN: 增加 `teamWorkspaceModeSchema`、`teamMergeStrategySchema`、`teamPathAssignmentSchema`、`teamChangeStatusSchema`；TeamRun/Task 暴露 allowed paths、branch/base commit、changed/conflict paths、patch bytes 和 change status，但不暴露宿主机 worktree 绝对路径。
- [x] VERIFY: `pnpm --filter @prometheus/protocol test` 通过。

### Task 2: Durable backward-compatible records

- [x] RED: repository test 验证旧 3B 数据库打开后获得默认列，3C team/task metadata 能跨 repository 重建，并能更新 `isolated → pending/applied/conflicted/rejected/discarded/no_changes`。
- [x] GREEN: 使用 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 做幂等迁移；JSON 字段统一经 schema parse，禁止调用方直接写任意状态字符串。
- [x] VERIFY: focused database/repository tests 通过，现有 3A/3B repository tests 不回归。

### Task 3: Real Git worktree deep module

- [x] RED→GREEN: 在临时真实 Git 仓库创建 `prometheus/team/<task-id>` 分支和仓库外 worktree，返回 child workspace root 与固定 base commit；非 Git、unborn HEAD、workspace 不在 repo 内时给出明确错误。
- [x] RED→GREEN: 审计 tracked/untracked/deleted/rename 路径，统一为 `/` 相对路径；路径不属于 assignment 时返回 `rejected`，不生成可应用结果。
- [x] RED→GREEN: 对允许路径生成 staged binary patch 后恢复 index；父工作区只有在 `git apply --check` 成功后才 apply。父文件已变化时返回 conflict paths，且父内容保持原样。
- [x] RED→GREEN: cleanup 只接受配置 storage root 内、同一 git common dir、`prometheus/team/` 前缀的 worktree；dirty worktree 只有 applied/no_changes 或显式 discard 才强制删除。
- [x] VERIFY: `pnpm --filter @prometheus/server test -- git-worktree-manager.test.ts` 通过，并检查测试临时目录全部清理。

### Task 4: Team orchestration and capability isolation

- [x] RED: AgentRunService test 验证 readonly child 只有 list/read/search + team communication；worktree child 的 list/read/write/shell 全部绑定隔离 root；primary 工具集合保持不变。
- [x] GREEN: 增加 child execution tool factory；`WorkspaceToolRegistry` 提供 `readonly()` 与 `list()`，不按工具名在 AgentRunService 内硬编码过滤。
- [x] RED: TeamRunService test 验证每 task 先创建 worktree 再调用 Provider；manual 保存 pending；auto 依序保守 apply；越界或冲突使 TeamRun failed 但不取消其他 task；readonly 不创建 worktree。
- [x] GREEN: UI launch 返回初始 durable TeamRun 并后台执行，避免审批卡被 modal 阻塞；`delegate_team` 继续等待完整 team result，不建立第二套调度器。
- [x] GREEN: worktree prompt 明确 workspace root 已隔离、允许路径和违规结果；readonly prompt 明确没有写/Shell capability。

### Task 5: Apply/discard API and cross-device UI

- [x] RED: app test 覆盖 `POST /api/team-runs/{teamRunId}/tasks/{taskId}/apply`、`.../discard`，错误 team/task 404、非 pending 状态 409、冲突返回 durable task 状态而不是 500。
- [x] GREEN: API 只调用 TeamRunService；apply 成功后 cleanup，conflict/rejected 保留；discard 必须显式请求并记录 `team.workspace.discarded` event。
- [x] GREEN: Team modal 提供 readonly/worktree、manual/auto；worktree 下每个选中 Agent 必须填写互不重叠路径；提交前客户端做同协议 schema 校验。
- [x] GREEN: Team summary 显示 mode/strategy、path ownership、changed paths、patch bytes、conflicts，以及 pending 时 Apply/Discard；所有动作后从服务端重新加载，不用本地状态冒充真相源。
- [x] GREEN: footer 升级 Team Runtime 3C / protocol v0.8，event description 不输出宿主机绝对路径或完整 patch。

### Task 6: Real worktree E2E and regression

- [x] RED: fixture child 必须真实调用 `write_file`；测试仓库有初始 commit，目标文件在允许路径内，未批准前 base/worktree 都无变更。
- [x] GREEN: 双浏览器 E2E 从一个终端启动 manual worktree team，另一终端批准 write；完成后看到 pending + changed path，点击 Apply 后 base 文件出现真实内容、task 为 applied、worktree 被清理。
- [x] GREEN: reload 后 team metadata 与 apply 结果仍存在；另一个冲突用例证明父文件变化时 apply 不覆盖并保留 worktree。
- [x] VERIFY: 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、Tauri `cargo check`、Team Worktree E2E 和既有七条 E2E；确认测试端口与子进程释放。

### Task 7: Research and product truth

- [x] 记录 LiveAgent `a22bd6f` 的 branch/worktree、binary patch、3-way/fallback、冲突保留与 cleanup guard；Prometheus 自动路径采用更保守的 direct check/apply，不自动 file-copy 覆盖。
- [x] 记录 Claude Code agent teams 共享目录会同文件覆盖，worktree 是独立的手动并行能力，因此 Prometheus 不把默认 team 宣称为写隔离。
- [x] 记录 Pi `65ff8e7` 冲突块反馈和 Grok Build `a5727c5` worktree/session 分层；Codex `9e1f43d` 的 patch apply 状态和 merge strategy 保持协议显式。
- [x] 更新 README、architecture、agent-runtime，明确 3C 仍不提供 OS sandbox、容器隔离、自动冲突解决、跨节点 worktree 或重启后继续 Provider request。

## Explicit non-goals for 3C

- 不自动执行 `git commit`、`git merge` 或 `git push`；apply 只把已审计 patch 写回父工作区。
- 不用 `git apply --3way` 或文件复制 fallback 自动制造冲突标记/覆盖用户文件。
- 不把 worktree 当 OS sandbox；Shell 仍需现有 approval/policy，且 secrets 继续过滤。
- 不实现容器、远端 Execution Node、跨节点共享文件系统或分布式锁。
- 不在 Control Plane 重启后自动重放 Provider/tool call；只保留和重新审计 worktree 结果。
