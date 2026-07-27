# Prometheus 优化方案

> 基于 2026-07-26 工作区快照（含未提交改动）的全面分析。
> 分析范围：`apps/server-rs`（11391 行）、`apps/server`（6827 行）、`apps/client`（6266 行）、`packages/*`（1636 行）、CI/Docker/文档。

---

## 一、项目目的复核

### 1.1 产品定位

Prometheus 的核心命题是：**让一个 AI 开发任务的执行状态脱离单台设备、单个进程而存在。**

三条支撑它的不变量：

| 不变量 | 实现载体 | 竞品对比 |
|---|---|---|
| 任务状态是服务端的全序事实 | SQLite append-only `session_events` + 单调 `sequence` | Cursor/Copilot 状态绑定单编辑器进程 |
| 高风险副作用必须显式裁决 | `approval.requested` / `approval.resolved` durable 事件 + 跨终端 resolver | Claude Code 的审批绑定单终端 |
| 并行 Agent 的写入必须隔离 | `GitWorktreeManager` 独立分支 + 路径所有权 + 保守 apply | Devin 类产品的隔离不可审计 |

这三点构成真正的护城河。**它不是"又一个 AI IDE"，而是一个 AI 执行的可审计控制平面。** 后续所有优化都应强化这个定位，而不是去和 VS Code 拼编辑器体验。

### 1.2 当前交付状态

已闭环：Foundation → Agent Runtime → Tool Runtime → Streaming → Team Runtime 3A/3B/3C → Skills/MCP → 多平台打包。

未提交的工作区改动（约 +4281/-448 行）做了一次形态转向：从"聊天式控制台"改造为"IDE 工作台"——引入 Monaco 编辑器、xterm PTY 终端、命令面板、底部面板、运行时项目切换、run 取消。

**这次转向的方向正确，但执行上留下了必须先偿还的债务。**

---

## 二、问题诊断（按严重度）

### P0-1 🔴 安全模型回归：PTY 通道绕过全部权限体系

**事实：**

- [terminal_ws.rs](apps/server-rs/src/terminal_ws.rs) 的 `/ws/terminal` 直接 `PtySession::spawn` 拉起 `powershell.exe` / `$SHELL`
- 该路径**不经过** `ApprovalCoordinator`、**不经过** `ToolPermissionPolicy`、**不产生**任何 durable 事件
- 而 README 明确承诺："Shell 每次执行均经过跨终端审批"

同一个 Control Plane 上，`shell_command` 工具被严格审批，`/ws/terminal` 却是完全敞开的交互式 shell。攻击者（或误操作）从 PTY 拿到的能力是 `shell_command` 的超集，且不留审计痕迹。

**这直接推翻了架构文档"安全模型"章节的全部前提。**

### P0-2 🔴 零认证 + 全通配 CORS

```rust
// apps/server-rs/src/app.rs:108
.layer(CorsLayer::permissive());
```

- 全部 API 路由无任何鉴权
- `/ws` 与 `/ws/terminal` 升级握手无 token 校验（[ws.rs:24](apps/server-rs/src/ws.rs#L24)）
- Dockerfile 中 `PROMETHEUS_HOST=0.0.0.0`，容器部署默认对外全开

`CorsLayer::permissive()` 意味着**任意网页都能从浏览器直接调用本机 4310 端口**，读写整个工作区、拉起 shell、读取 Agent 历史。仅"默认绑 127.0.0.1"不足以防御——DNS rebinding 与本机恶意页面都能绕过。

### P0-3 🟠 双运行时漂移，测试资产在错误的一半

| | 行数 | 单元测试数 | 是否默认 |
|---|---|---|---|
| `apps/server-rs` | 11391 | **5** | ✅ 默认 |
| `apps/server` (Node) | 6827（含 2725 行测试） | ~15 个测试文件 | ❌ 回退 |

默认运行时几乎裸奔，回退运行时测试完备。Rust 侧的正确性目前只由 `scripts/run_e2e_*.py` 的黑盒 E2E 兜底——反馈慢、定位难、无法覆盖分支。

同时这是明确的 DRY 违反：`agent-run-service`、`team-run-service`、`git-worktree-manager`、`tool-permission-policy` 等 12+ 个模块存在语义等价的两份实现，任何行为变更都要改两遍。

### P0-4 🟠 仓库卫生

```
prometheus-server-windows-x64.exe      12 MB 二进制在仓库根
scripts/_patch_local_runtime_ui.py     一次性 patch 脚本
scripts/_patch_local_runtime_ui2.py    一次性 patch 脚本
scripts/_patch_local_url.py            一次性 patch 脚本
scripts/_patch_restart_flag.py         一次性 patch 脚本
scripts/_patch_sidecar_runtime.py      一次性 patch 脚本
scripts/_rewrite_runtime_modal.js      一次性 patch 脚本
apps/client/src/App.ide.part1.tsx      1 行占位文件
apps/client/src/_app_new_flag.txt      0 行标记文件
```

违反 YAGNI。这些是改造过程的脚手架，应在改造完成时删除。

### P1-1 单文件膨胀（SRP 违反）

| 文件 | 行数 | 承担职责 |
|---|---|---|
| [App.tsx](apps/client/src/App.tsx) | **2096** | App 主体 + 11 个组件（`RuntimeSetupModal` 单个就 730 行） |
| [app.rs](apps/server-rs/src/app.rs) | **1068** | 路由表 + 全部 handler + DTO |
| [team_run_service.rs](apps/server-rs/src/team_run_service.rs) | 1049 | 调度 + 持久化编排 + worktree 生命周期 |
| [agent_run_service.rs](apps/server-rs/src/agent_run_service.rs) | 956 | 工具装配 + loop + 审批 + 事件提交 |
| [styles.css](apps/client/src/styles.css) | 1296 | 全部样式 |
| [api.ts](apps/client/src/api.ts) | 1017 | 全部 HTTP 客户端 |

`App.tsx` 中 `execute()` 单个函数承担了 skill 装配、MCP 装配、system prompt 拼接、team 工具注入、worktree 工具重绑定、delegate 工具构造六件事（[agent_run_service.rs:131-300](apps/server-rs/src/agent_run_service.rs#L131)）。

### P1-2 上下文管理缺失（正确性风险）

```rust
const MAX_TURNS: u32 = 8;              // 硬编码
const TOOL_OUTPUT_LIMIT: usize = 8_000; // 硬编码
```

`build_history()` 无条件重放 session 内**全部** `message.user` / `message.agent`（[agent_run_service.rs:780](apps/server-rs/src/agent_run_service.rs#L780)）。没有 token 预算、没有摘要压缩、没有滑动窗口。

**后果：** 长 session 必然触发 provider context limit 错误，且失败发生在 API 调用时而非可控的本地裁剪时。这不是性能问题，是功能天花板。

### P1-3 事件全量拉取，无分页

```rust
// session_repository.rs:110
WHERE session_id = ? AND sequence > ?  ORDER BY sequence ASC
```

无 `LIMIT`。客户端 `listEvents(sessionId)` 默认 `afterSequence=0`，即**每次进入 session 拉全量事件**。前端 `timeline` 也是全量 `.map()` 渲染，无虚拟化。数千事件的 session 会同时打爆网络与主线程。

### P1-4 崩溃恢复语义不完整

`TeamRunRepository::interrupt_running()` 在启动时把 team task 标记为 `interrupted`（[state.rs:60](apps/server-rs/src/state.rs#L60)），但**普通 agent run 没有对等处理**：

- 进程崩溃后，已写入的 `agent.run.started` 永远等不到 `completed` / `failed`
- 事件类型枚举里也没有 `agent.run.interrupted`
- 客户端据此判断 `running` 状态，会永久显示"Agent running"

同样，pending approval 在重启后其 `oneshot::Sender` 消失，UI 上的审批卡片变成死按钮。

### P1-5 前端状态层过载

`usePrometheus()` 单 hook 内 **30+ 个 `useState`**，聚合 health/runtime/sessions/providers/agents/permissions/skills/mcp/teamRuns/teamMessages/events/streams/workspace tree/connection 全部领域。任一字段变更触发整树 re-render；无缓存、无 stale-while-revalidate、无请求去重。

### P2-1 设计 token 只覆盖一半

```
硬编码 hex 字面量：156 处
var(--*) 引用：    169 处
```

`:root` 只定义了 12 个变量（`--ink`/`--muted`/`--panel`/`--ember`…），但 `#181b19`、`#3a403b`、`#101311` 这类中间色调直接散落在 1296 行里。**无浅色主题、无对比度验证、无语义层 token（success/warning/danger 各自为政）。**

### P2-2 缺失的关键产品能力

| 缺口 | 影响 |
|---|---|
| **无 diff 视图** | Team patch 只能盲选 Apply/Discard。durable pending patch 已在服务端存好，UI 却不给看——这是当前最大的产品缺口 |
| **无全局审批收件箱** | approval 内联在 timeline 中，多端场景下用户滚动过去就再也看不到 |
| **无成本/token 面板** | `usage` 已进 `agent.run.completed` payload，UI 未消费 |
| **无 reasoning 展示** | 现代模型的 thinking token 完全丢弃 |
| **无 steering / follow-up 队列** | agent 运行中输入框直接 `disabled`，只能 Stop 后重来 |

### P2-3 无可观测性

无 `tracing` 结构化日志、无 `/metrics`、无 request id 贯穿。故障排查依赖 `eprintln!`。

### P2-4 协议无版本协商

REST 与 WebSocket envelope 均无版本字段。桌面安装包内置 sidecar 与用户手动升级的独立 server 版本会漂移，届时表现为难以诊断的字段缺失。

---

## 三、优化方案

### 阶段 P0：安全与一致性修复（1 周，必须优先）

#### P0-A 统一 PTY 到权限体系

**设计原则：能力等价则策略等价。** PTY 是 `shell_command` 的超集，策略只能更严不能更松。

```rust
// 新增 apps/server-rs/src/terminal_policy.rs
pub enum TerminalMode {
    Disabled,           // 默认。生产/远程部署
    ApprovalPerSession, // 开启 PTY 需一次会话级审批
    Trusted,            // 仅当 bind=127.0.0.1 且显式 opt-in
}
```

改造要点：

1. `TerminalMode` 由 `PROMETHEUS_TERMINAL_MODE` 环境变量控制，**默认 `Disabled`**
2. `ApprovalPerSession` 模式下，`/ws/terminal` 升级前发 `approval.requested`（`tool: "terminal_session"`），等待任一终端裁决
3. PTY 会话开启/关闭写入 `tool.call.started` / `tool.call.completed` durable 事件，含 cwd 与会话时长
4. 复用 `shell_command` 的环境变量剥离逻辑（不继承 `PROMETHEUS_MASTER_KEY` 等）
5. README 与 `docs/architecture.md` 同步更新——**不能让文档继续声称一个已被绕过的保证**

#### P0-B 引入鉴权层

```rust
// apps/server-rs/src/auth.rs
pub struct AuthLayer {
    token: Option<String>,  // PROMETHEUS_ACCESS_TOKEN
    bind_is_loopback: bool,
}
```

规则：

| 绑定地址 | Token 配置 | 行为 |
|---|---|---|
| 127.0.0.1 | 未配置 | 允许（本机单用户），启动日志明确提示 |
| 非 loopback | 未配置 | **拒绝启动**，退出码非零 |
| 任意 | 已配置 | 全部 API + WS 升级要求 `Authorization: Bearer` 或 `?token=` |

CORS 收紧：

```rust
CorsLayer::new()
    .allow_origin(allowed_origins)   // 默认 [http://127.0.0.1:5173, self]
    .allow_credentials(true)
```

Tauri 侧：sidecar 启动时生成随机 token 写入 `runtime.json`（`0600` 权限），前端从 Tauri command 读取。

#### P0-C 清理仓库

```bash
git rm --cached prometheus-server-windows-x64.exe   # 加入 .gitignore
rm scripts/_patch_*.py scripts/_rewrite_runtime_modal.js
rm apps/client/src/App.ide.part1.tsx apps/client/src/_app_new_flag.txt
```

`.gitignore` 追加 `prometheus-server-*`、`*.exe`。

---

### 阶段 P1：架构收敛（2-3 周）

#### P1-A 终结双运行时

**决策建议：删除 `apps/server`（Node 实现），保留 `packages/protocol`。**

理由：
- Rust 已是默认且功能超集（PTY、runtime 项目切换只在 Rust 侧）
- 6827 行的对照实现，其价值不足以抵消双份维护成本（DRY）
- "回退"场景从未被真实需要——CI 与 Docker 都只构建 Rust

迁移动作：
1. 把 Node 侧 2725 行测试**翻译成 Rust 单元测试**（这是最有价值的资产，不能随代码一起丢）
2. `packages/agent-core` 仅被 Node server 引用 → 一并归档
3. `packages/protocol` 保留（前端与协议契约的单一真相源）
4. `pnpm dev:node` / `test` 脚本清理

> 若坚持保留 Node 实现作对照，则必须建立**契约测试套件**：同一组 Python E2E 脚本跑通两个实现，CI 强制。否则漂移不可避免。

#### P1-B Rust 测试补齐

目标：核心模块行覆盖 ≥ 70%。优先级：

```
tool_permission_policy.rs   ← 安全关键，deny/ask/allow 优先级、复合命令逐段匹配
git_worktree_manager.rs     ← 路径所有权、越界拒绝、保守 apply
agent_run_service.rs        ← history 构建、工具装配、审批分支、取消
team_run_service.rs         ← 并发上限、单任务失败隔离、中断标记
workspace_service.rs        ← 路径逃逸、符号链接、大小限制
session_repository.rs       ← sequence 单调性、幂等写入
```

用 `sqlite::memory:` + `tempfile` 做隔离夹具，已有 `Database::open` 支持 `:memory:`。

#### P1-C 模块拆分

**服务端：**

```
app.rs (1068)  →  routes/mod.rs        路由表组装（≈80 行）
                  routes/workspace.rs
                  routes/session.rs
                  routes/runtime.rs
                  routes/config.rs     provider/agent/permission/mcp/skill
                  routes/team.rs
                  dto.rs               全部请求/响应结构

agent_run_service.rs (956) → agent_run/mod.rs        编排
                             agent_run/toolset.rs    工具装配（当前 execute() 中 170 行）
                             agent_run/history.rs    上下文构建 + 压缩
                             agent_run/events.rs     事件提交
```

**前端：**

```
App.tsx (2096) → App.tsx                     壳层 + 布局（≈200 行）
                 components/NavigationRail.tsx
                 components/WorkspaceTree.tsx
                 components/EditorPane.tsx
                 components/ChatPane.tsx
                 timeline/TimelineEvent.tsx
                 timeline/StreamingEvent.tsx
                 timeline/ApprovalCard.tsx
                 team/TeamRunSummary.tsx
                 team/TeamRunModal.tsx
                 team/TeamMessageBus.tsx
                 settings/SettingsWorkspace.tsx   ← 拆掉 730 行的 RuntimeSetupModal
                 settings/ConnectionSection.tsx
                 settings/ProvidersSection.tsx
                 settings/AgentsSection.tsx
                 settings/PermissionsSection.tsx
                 settings/McpSection.tsx
```

注意：当前 Settings 页面是把 `RuntimeSetupModal` 传 `embedded` 当页面用——modal 与 page 是两种布局契约，应彻底分开（ISP：不要让一个组件既满足 modal 又满足 page 的胖接口）。

`api.ts (1017)` → 按域拆 `api/workspace.ts`、`api/session.ts`、`api/config.ts`、`api/team.ts`、`api/transport.ts`（公共 fetch/错误/token 注入）。

#### P1-D 上下文预算管理

```rust
pub struct ContextBudget {
    max_input_tokens: usize,     // 来自 Agent Profile，可配置
    reserve_for_output: usize,
    tool_output_limit: usize,
}

pub enum CompactionStrategy {
    SlidingWindow { keep_recent: usize },
    Summarize { summarizer_agent_id: String },  // 复用现有 Agent 基础设施
}
```

改造 `build_history()`：
1. 估算 token（`tiktoken-rs` 或按 provider 的字符启发式）
2. 超预算时按策略压缩，压缩事实写入 `system.notice` 事件（可审计、跨端可见）
3. `MAX_TURNS` / `TOOL_OUTPUT_LIMIT` 移入 `AgentProfile`，DB schema 加列

#### P1-E 事件分页与虚拟化

服务端：

```rust
// GET /api/sessions/{id}/events?afterSequence=0&limit=200&direction=forward|backward
const DEFAULT_EVENT_PAGE: i64 = 200;
const MAX_EVENT_PAGE: i64 = 1000;
```

响应加 `hasMore` / `nextCursor`。

客户端：
- 初次只拉最新 200 条（`direction=backward`），向上滚动增量加载
- Timeline 接入 `@tanstack/react-virtual`
- WebSocket 增量仍按 `sequence` 合并（现有 `mergeEvents` 逻辑保留）

#### P1-F 恢复语义补全

1. 协议新增事件类型：`agent.run.interrupted`
2. 启动时扫描所有 `agent.run.started` 且无终态的 run，写入 `agent.run.interrupted`（幂等，带 `reason: "control_plane_restart"`）
3. 同理处理 `approval.requested` 无 `approval.resolved` 的：写入 `approval.resolved` with `decision: "expired"`
4. 客户端据此正确显示"已中断"而非永久 running

**不变量补充**（写入 `docs/architecture.md`）：
> 17. Control Plane 启动时，所有无终态的 run 与 approval 必须被标记为 interrupted/expired，不自动重放。

#### P1-G 前端状态分层

引入 TanStack Query（或等价的轻量方案），把 `usePrometheus` 拆为：

```
useHealth()        stale: 5s
useRuntime()       stale: 30s
useSessions()      stale: 10s
useProviders()     stale: ∞（mutation 后失效）
useAgents()        stale: ∞
usePermissions()   stale: ∞
useSkills()        stale: ∞
useMcpServers()    stale: ∞
useSessionEvents() 分页 + WS 增量合并
useLiveStreams()   纯 WS，不进缓存
```

收益：自动去重、后台刷新、错误重试、按需 re-render。配置类数据（provider/agent/permission）当前每次 bootstrap 全量重拉，实际几乎不变。

---

### 阶段 P2：产品能力（3-4 周）

#### P2-A Diff 视图（最高优先）

这是投入产出比最高的功能——**服务端数据已经全部就绪**（`team_run_tasks` 中已存 `changed_paths_json`、`patch_bytes`、`base_commit`、`conflict_paths_json`），只差 UI 与一个读取端点。

```
GET /api/team-runs/{teamRunId}/tasks/{taskId}/patch
→ { patch: string, changedPaths: [...], conflictPaths: [...], truncated: bool }
```

UI：复用已引入的 Monaco `DiffEditor`（`@monaco-editor/react` 已在依赖中）。

```
┌─ Team task: refactor-auth ──── 3 files, +142 −38 ─┐
│ ▸ src/auth/login.ts        +89 −12                │
│ ▸ src/auth/session.ts      +41 −20                │
│ ▸ src/auth/index.ts        +12 −6                 │
├───────────────────────────────────────────────────┤
│  [Monaco DiffEditor — 原文 | 补丁后]               │
├───────────────────────────────────────────────────┤
│           [Discard]        [Apply patch]          │
└───────────────────────────────────────────────────┘
```

同样适用于 `write_file` 审批：当前审批卡片只显示路径 + 字节数 + SHA-256，用户在盲批。应显示行级 diff（服务端已有脱敏摘要机制，扩展为携带 diff hunk）。

#### P2-B 全局审批收件箱

```
GET /api/approvals/pending          // 跨 session
```

UI：导航栏常驻徽标 + 抽屉式列表。审批是这个产品的核心交互，不应埋在 timeline 滚动流里。移动端尤其重要——手机上批准桌面端发起的操作，正是"多端接续"最有说服力的场景。

#### P2-C 运行成本与遥测面板

`usage` 已在 `agent.run.completed` payload 中，只需消费：

```
Session 累计    输入 128.4k · 输出 22.1k · 约 $0.94
本次 run       输入 12.1k · 输出 3.2k · 8 轮中的第 3 轮
```

Agent Profile 增加 `costPer1kInput` / `costPer1kOutput` 配置。

#### P2-D Steering / Follow-up 队列

当前 agent 运行中输入框 `disabled`，只能 Stop 重来。改为：

- 运行中输入 → 排入 pending queue，显示"将在当前轮次后发送"
- 新增事件类型 `message.user.queued`
- Agent loop 在每轮结束检查队列，有则注入下一轮上下文

这是与 Claude Code / Cursor 对齐的基本体感。

#### P2-E 可观测性

```rust
tracing_subscriber::fmt()
    .json()
    .with_env_filter(EnvFilter::from_env("PROMETHEUS_LOG"))
```

- 每个 HTTP 请求注入 `request_id`，贯穿到 tool call 与 provider 调用
- `/api/metrics`（Prometheus 文本格式）：active runs、pending approvals、provider 延迟直方图、tool 调用计数
- provider 错误分类计数（rate limit / auth / timeout / context overflow）

#### P2-F 协议版本协商

```
GET /api/health → { version: "0.1.0", protocolVersion: 1, capabilities: ["pty", "worktree", "mcp"] }
```

客户端启动时校验 `protocolVersion`，不匹配则明确提示升级，而非静默失败。`capabilities` 让 UI 精确地知道哪些功能可用——替代当前硬编码的 `Capability status="planned"` 标记。

---

### 阶段 P3：UI/UX 体系化（2-3 周，可与 P2 并行）

#### P3-A 设计 token 分层

当前 156 处硬编码 hex 需收敛为三层：

```css
/* 1. 原始色板 — 只在此处出现字面量 */
:root {
  --gray-0:#0a0c0b;  --gray-1:#0d0f0e;  --gray-2:#131614;
  --gray-3:#191c19;  --gray-4:#2a2f2b;  --gray-5:#3a403b;
  --gray-6:#555b56;  --gray-7:#8c918a;  --gray-8:#e7e8df;
  --ember-4:#f26a3d; --ember-3:#ef8068; --ember-2:#f0a088;
  --lime-4:#b7e25a;  --cyan-4:#7ecfc7;  --amber-4:#e4c267;
}

/* 2. 语义层 — 组件只引用这一层 */
:root {
  --bg-canvas:var(--gray-1);     --bg-panel:var(--gray-2);
  --bg-raised:var(--gray-3);     --bg-hover:var(--gray-3);
  --fg-default:var(--gray-8);    --fg-muted:var(--gray-7);
  --fg-subtle:var(--gray-6);
  --border-default:var(--gray-4); --border-strong:var(--gray-5);
  --accent:var(--ember-4);       --accent-fg:var(--gray-0);
  --status-success:var(--lime-4); --status-warning:var(--amber-4);
  --status-danger:var(--ember-4); --status-info:var(--cyan-4);
  --focus-ring:var(--cyan-4);
}

/* 3. 主题覆盖 */
[data-theme="light"] { --bg-canvas:#fafaf8; --fg-default:#16181a; ... }
@media (prefers-color-scheme: light) { :root:not([data-theme]) { ... } }
```

配 CI 检查：`styles/` 下除 `tokens.css` 外禁止出现 hex 字面量（stylelint `color-no-hex`）。

#### P3-B 样式文件拆分

```
styles/tokens.css      色板 + 语义 token + 主题
styles/base.css        reset + 排版 + 焦点样式
styles/layout.css      app-shell 栅格 + 响应式断点
styles/components/*.css  按组件拆（与 components/ 目录一一对应）
```

1296 行单文件 → 每文件 < 200 行。

#### P3-C 无障碍与键盘可达性

当前缺口：
- 无统一 `:focus-visible` 样式（键盘用户看不到焦点位置）
- 模态框无 focus trap、无 `Esc` 关闭统一处理、无 `aria-modal`
- 对比度未验证：`--faint:#555b56` 对 `--panel:#131614` 约 3.4:1，**低于 WCAG AA 正文要求的 4.5:1**
- Timeline 无 `role="log"` + `aria-live`，屏幕阅读器读不到流式输出

修复清单：
1. 全局 `:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; }`
2. 抽取 `<Modal>` 组件统一处理 focus trap / Esc / backdrop / `aria-modal`
3. 调整 `--fg-subtle` 至 ≥ 4.5:1，CI 引入对比度检查
4. Timeline 加 `role="log" aria-live="polite" aria-relevant="additions"`
5. 全部图标按钮补 `aria-label`（当前部分缺失）

#### P3-D 响应式与移动端策略

**现实判断：IDE 三栏 + Monaco + xterm 在手机上不可用。** 不要试图把桌面布局塞进 375px。

采用**能力分级**而非布局压缩：

| 断点 | 形态 | 可用能力 |
|---|---|---|
| ≥1280px | 完整 IDE：Rail + Sidebar + Editor + Chat + Bottom | 全部 |
| 768–1279px | Rail + 单侧栏 + Editor/Chat 切换 | 全部，Bottom 面板抽屉化 |
| <768px | **移动专属视图**：任务流 + 审批 + 只读文件浏览 | 无 Monaco、无 PTY；聚焦"看进度 + 批审批 + 发指令" |

移动端的价值不是编码，而是**"离开工位仍能推进任务"**——恰好是这个产品定位的最佳体现。`@monaco-editor/react` 与 `@xterm/xterm` 在移动视图应懒加载排除（当前 `manualChunks` 已单独切出 monaco，进一步做路由级 code split）。

#### P3-E 关键交互补强

1. **连接状态**：当前 `connection-pill` 有 4 态（LIVE SYNC/SYNCING/SERVER ONLINE/OFFLINE），语义对用户不透明。改为：图标 + 明确文案 + hover 显示 `控制面 URL / 最后同步 seq / 延迟`
2. **空状态**：已有 orbital-mark 空态设计良好，补齐 Team panel、Extensions、Search 的空态
3. **错误呈现**：当前 `error-banner` 是纯文本。应结构化为 `标题 + 原因 + 建议动作按钮`（如 provider 401 → "去配置 Provider"）
4. **流式输出**：`StreamingEvent` 应显示轮次进度（`第 3/8 轮`）与当前工具调用名，而非只有文本

---

## 四、执行顺序与验收

| 阶段 | 内容 | 工期 | 验收标准 |
|---|---|---|---|
| **P0** | PTY 纳管、鉴权、CORS、仓库清理 | 1 周 | 非 loopback 无 token 拒绝启动；PTY 产生 durable 事件；`git status` 干净 |
| **P1-A/B** | 删除 Node 实现 + Rust 测试补齐 | 1.5 周 | `cargo test` ≥ 70% 行覆盖；E2E 全绿 |
| **P1-C** | 模块拆分 | 1 周 | 无文件 > 400 行 |
| **P1-D/E/F** | 上下文预算、分页、恢复语义 | 1 周 | 1000+ 事件 session 首屏 < 500ms；重启后无悬空 run |
| **P1-G** | 前端状态分层 | 0.5 周 | bootstrap 请求数下降 ≥ 50% |
| **P2-A/B** | Diff 视图 + 审批收件箱 | 1.5 周 | patch 可预览后再 apply；跨 session 待审批可见 |
| **P2-C~F** | 成本面板、steering、可观测性、协议版本 | 1.5 周 | `/api/metrics` 可用；版本不匹配有明确提示 |
| **P3** | 设计系统 + 无障碍 + 移动分级 | 2 周 | 无 hex 字面量泄漏；WCAG AA 通过；移动视图可用 |

**关键路径：P0 必须先做。** 在 PTY 与鉴权修复前，不建议对外发布任何 Release——当前 Docker 镜像默认配置等同于把 shell 暴露在 0.0.0.0 上。

---

## 五、原则应用说明

| 原则 | 本方案中的体现 |
|---|---|
| **KISS** | 移动端不压缩桌面布局而是能力分级；协议版本用整数而非 semver 协商 |
| **YAGNI** | 删除 6827 行未被真实需要的 Node 回退实现；清理一次性 patch 脚本 |
| **DRY** | 终结双运行时；设计 token 三层收敛消除 156 处重复色值 |
| **SRP** | `app.rs`/`App.tsx` 按域拆分；`agent_run_service` 分离工具装配与编排 |
| **OCP** | `CompactionStrategy`、`TerminalMode` 用枚举扩展点，新增策略不改调用方 |
| **LSP** | `Modal` 与 `Page` 不再由同一组件（`RuntimeSetupModal embedded`）兼任 |
| **DIP** | 上下文预算依赖 `ContextBudget` 抽象而非直接读硬编码常量 |
