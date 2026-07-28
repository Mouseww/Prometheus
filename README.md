# Prometheus

Prometheus 是一个本地优先、服务端可接续的 AI 开发环境。同一任务可以在 Windows、macOS、Android、iOS 和浏览器之间实时同步；代码与密钥默认留在执行节点，服务端保存可恢复的任务事件日志。

当前仓库已完成 Foundation、Agent Runtime 2A、Tool Runtime 2B1/2B2/2B3/2B4、Streaming Runtime 2C 与 Team Runtime 3A/3B/3C 纵向切片，包含：

- 真实工作区目录浏览
- SQLite 持久化会话与事件日志
- WebSocket 多客户端实时同步
- React WebUI
- Tauri 2 桌面/移动端壳层基础
- OpenAI Responses、Anthropic、Gemini 与 OpenAI-compatible Provider 配置
- AES-256-GCM 加密的 Provider 密钥存储
- 可配置 Agent Profile 与真实模型调用
- OpenAI Responses、OpenAI-compatible Chat、Anthropic Messages 与 Gemini GenerateContent 的真实 Provider token streaming
- session-scoped `RunStreamHub`：运行中草稿仅经 WebSocket 临时广播，晚加入终端可收到当前 snapshot
- Web/Tauri 客户端按 run/turn/revision 合并增量，异常断线后从最后 durable sequence 自动重连
- 最终 `message.agent` 仍只写入 SQLite 一次，逐 token delta 不进入 durable event log
- `agent.run.started`、`message.agent`、`agent.run.completed`、`agent.run.failed` 持久事件
- Provider-neutral Agent tool loop，支持工具结果回灌与最多八轮有界执行
- 真实只读工作区工具：`list_directory`、`read_file`、`search_text`
- `tool.call.started`、`tool.call.completed` 跨端可重放事件
- 真实 `write_file`：只允许现有工作区父目录、拒绝越界与符号链接、限制 1 MiB UTF-8 内容
- 跨终端审批：任一连接到同一任务的 Web/Tauri 客户端均可批准或拒绝写入
- `approval.requested`、`approval.resolved` durable 事件与资源化 resolution API
- 写入参数脱敏摘要：事件只保存路径、字节数、非完整预览和 SHA-256，不保存完整内容
- 真实一次性 `shell_command`：工作目录强制位于当前工作区，默认 10 秒/最长 2 分钟，合并 stdout/stderr，保留最后 64 KiB 输出
- Shell 每次执行均经过跨终端审批；超时或取消会终止进程树，控制面的 Provider/master key 等敏感环境变量不会继承给子进程
- Shell 审批事件保存可审阅且经过常见 inline secret 脱敏的命令摘要、工作目录与超时
- SQLite 持久化权限规则：支持 `shell_command` 与 `write_file` 的 `deny`、`ask`、`allow`，并可从 Web/Tauri Runtime 面板真实创建和删除
- 权限优先级固定为 deny → ask → allow；Shell 复合命令逐子命令匹配，复杂语法回退审批，已知 shell wrapper 的通配 allow 不会自动放行
- `permission.rule.matched` durable 审计事件：自动允许、规则拒绝和显式 ask 均通过同一多端任务时间线重放
- 真实 SubAgent 团队：在 GUI 中从已配置 Agent 选择 1-8 个成员，以 1-4 并发度执行同一 team goal
- 每个 child Agent 使用独立 task context，不读取父会话聊天历史；仍复用真实 Provider streaming、workspace tools、审批与权限策略
- SQLite 持久化 `team_runs`/`team_run_tasks` roster 与终态，`agent.spawned`/`agent.status` 进入同一 session event log
- 同一 session 可同时广播多个 child run 草稿，新连接终端可收到所有 active snapshot；单个 Agent 失败不会取消其他 Agent
- Control Plane 重启时未完成 team task 会持久标记为 `interrupted`，不会自动重放可能带副作用的 child run
- 模型自主团队委派：主 Agent 在真实 Provider tool loop 中可调用 `delegate_team`，从已配置 roster 选择 Agent 并控制并发度
- 结构化防止递归委派：primary 只获得 `delegate_team`，child 只获得 `send_team_message`/`read_team_messages`
- durable Agent message bus：支持 `direct`/`shared`/`decision`/`question`、`parent`/`*`/团队成员稳定收件人、after-sequence 拉取和最长 5 秒有界等待
- 消息先写入 SQLite `team_messages`，再作为 `agent.message` 进入同一 session event log；记录 source run/tool call 用于追踪
- Web/Tauri Team panel 显示真实持久消息，跨终端刷新和重载均从 Control Plane 恢复
- Team 默认使用只读工作区能力；选择 Git worktree 时，每个 child Agent 必须拥有互不重叠的显式路径范围
- 每个可写 child 在独立 `prometheus/team/{taskId}` 分支和仓库外 worktree 中运行，文件工具与 Shell cwd 均绑定到该隔离工作区
- tracked、untracked、删除和重命名统一进入 changed-path 审计；越界路径被拒绝且不会生成可应用结果
- manual 模式保存 durable pending patch，由任一终端显式 Apply 或 Discard；auto 模式只应用通过 `git apply --check --binary` 的 patch
- 冲突不会执行 `--3way`、文件复制、自动 commit/merge/push，也不会覆盖父工作区；冲突 worktree 会保留供人工处理
- Control Plane 重启后会重新审计已保存 worktree，但不会自动重放 Provider 请求或自动应用 patch

PTY/交互式终端、后台命令 session、操作系统级 sandbox、容器隔离、managed policy 层级、SSH 与定时任务尚未接入，界面只将它们标为 planned，不会伪装成可用功能。Skills/MCP 已接入真实配置与执行路径。Settings 默认连接 Open Skills / Open MCP 开源目录，可在 UI 中浏览、搜索、安装与配置（含 GitHub skill 路径安装与 MCP 环境变量）。Git worktree 只提供版本库写入隔离，不是进程、网络或密钥 sandbox；Shell 仍经过现有审批与权限策略。当前 pending approval、运行中命令和 Provider stream 在 Control Plane 进程存活期间可真实处理；服务重启后的 run/approval/process/stream 恢复尚未实现。当前也不声称支持自动解决 Git 冲突、跨节点 worktree、用户取消、steering/follow-up queue 或 reasoning/thinking token 展示。

## 本地开发

要求：Node.js 24+、pnpm 10+、Rust stable（默认 Control Plane 与 Tauri 均需要）。

```powershell
pnpm install
pnpm dev
```

- WebUI: `http://127.0.0.1:5173`
- Control Plane: `http://127.0.0.1:4310`
- 默认工作区：Prometheus 仓库根目录，可通过 `PROMETHEUS_WORKSPACE_ROOT` 覆盖

验证：

```powershell
pnpm test
pnpm typecheck
pnpm build
cargo check --manifest-path "apps/client/src-tauri/Cargo.toml"
python scripts/run_e2e_team_runtime.py
python scripts/run_e2e_autonomous_team.py
python scripts/run_e2e_team_worktree.py
python scripts/run_cross_runtime_sqlite.py
python scripts/run_e2e_rust_foundation.py
```


## Control Plane（默认 Rust）

`apps/server-rs` 是默认 Control Plane（health、workspace、session/event、WebSocket sync、Provider/Agent/Permission Rule、agent/tool/team runtime、SPA 静态托管）。Node 实现保留为对照与回退。

```powershell
pnpm dev
```

这会同时启动 Rust Control Plane 与 Vite WebUI。

- WebUI 开发服务器：`http://127.0.0.1:5173`
- API/WebSocket：`http://127.0.0.1:4310`

仅启动 Rust 服务：

```powershell
pnpm dev:server-rs
```

回退 Node Control Plane：

```powershell
pnpm dev:node
```

生产预览（先构建前端，再由 Rust 托管 `apps/client/dist`）：

```powershell
pnpm --filter @prometheus/client build
pnpm start:server-rs
```

环境变量：`PROMETHEUS_WORKSPACE_ROOT`、`PROMETHEUS_DATA_FILE`、`PROMETHEUS_PORT`、`PROMETHEUS_HOST`、`PROMETHEUS_MASTER_KEY`、`PROMETHEUS_WEB_ROOT`、`PROMETHEUS_WORKTREE_ROOT`、`PROMETHEUS_ACCESS_TOKEN`、`PROMETHEUS_ALLOWED_ORIGINS`、`PROMETHEUS_TERMINAL_MODE`。

### 安全边界

Control Plane 拥有工作区读写与 shell 执行能力，所以它的网络暴露面等同于一个远程 shell。默认配置按「本机自用」收紧，向外暴露必须显式解锁：

| 变量 | 默认 | 语义 |
|---|---|---|
| `PROMETHEUS_ACCESS_TOKEN` | 未设置 | 所有 `/api/*` 与 `/ws*` 的 Bearer 令牌（≥16 字符）。绑定非回环地址而未设置时，server 在 `bind` 之前拒绝启动。`/api/health` 保持公开，客户端才能区分「服务器离线」与「令牌错误」。 |
| `PROMETHEUS_ALLOWED_ORIGINS` | 本机开发地址 | 逗号分隔的浏览器来源白名单，不再是 `Any`。 |
| `PROMETHEUS_TERMINAL_MODE` | `disabled` | `disabled` \| `approval`（每次开终端走审批）\| `trusted`（免审批，仅允许回环绑定）。 |

交互式 PTY（`/ws/terminal`）与一次性执行（`POST /api/terminal/exec`）与 agent 的 `shell_command` 工具走同一条链路：权限规则 → 跨终端审批 → `tool.call.started` / `permission.rule.matched` / `approval.requested` / `approval.resolved` / `tool.call.completed` 持久化事件。两条通道都会在子进程中剥离 `PROMETHEUS_MASTER_KEY`、各类 `*_API_KEY` / `*_TOKEN` / `*_SECRET`，避免一条 `env` 就解开 SecretVault。

WebSocket 握手无法自定义请求头，令牌通过 `?token=` 查询参数传递；客户端按控制平面 URL 分别保存令牌，切换远程实例不会串用。

5A 默认入口已切换到 **Rust Control Plane**；5B 已接入真实 **Skills + MCP**（`read_skill`、stdio MCP tools）；5C 提供 GitHub Release 多平台二进制与 Docker Rust 镜像。4I 多 Provider、4H `delegate_team`、4G 消息总线与 4F worktree 仍可用。SSH/定时任务尚未接入。

## 服务器托管 WebUI

生产构建后，Control Plane 会直接托管 `apps/client/dist`：

```powershell
pnpm build
pnpm start:server-rs
```

访问 `http://127.0.0.1:4310` 即可同时使用 WebUI、HTTP API 与 WebSocket。Node 回退：`node apps/server/dist/index.js`。容器部署入口见根目录 `Dockerfile`；挂载 `/data` 保存事件数据库，挂载 `/workspace` 暴露执行工作区。



## 多平台安装包（GitHub Actions）

推送 `v*` tag 会触发完整 Release 矩阵：

| 产物 | Runner | 说明 |
|---|---|---|
| Control plane 二进制 | Win/Linux/macOS | `prometheus-server-*` |
| Desktop installers | Win/Linux/macOS | Tauri NSIS/MSI、DMG、deb/AppImage，并打包 control-plane sidecar |
| Android APK | Ubuntu + Android SDK/NDK | `tauri android build --apk` |
| iOS | macOS + Xcode | 有 `IOS_DEVELOPMENT_TEAM` 时导出调试 IPA；否则产出 simulator app zip 与 Xcode 工程 zip |
| WebUI | Ubuntu | `prometheus-webui.zip` |

本地桌面构建：

```powershell
pnpm install
cargo build --release --manifest-path apps/server-rs/Cargo.toml
# 按当前 triple 复制 sidecar 到 apps/client/src-tauri/binaries/
pnpm tauri:build
```

可选 secrets：

- `IOS_DEVELOPMENT_TEAM`：启用 iOS 真机/调试导出
- Android 发布签名可在后续接入 keystore secrets（当前默认产出 CI APK）


架构与范围见 [docs/architecture.md](docs/architecture.md)，参考项目研究见 [docs/research/agent-tools-benchmark.md](docs/research/agent-tools-benchmark.md)。






## 安装包如何使用

### 1. 桌面安装包（推荐本机使用）

从 GitHub Release 下载并安装：

- Windows: `Prometheus_0.1.0_x64-setup.exe` 或 `.msi`
- macOS: `Prometheus_0.1.0_aarch64.dmg` / `Prometheus_0.1.0_x64.dmg`
- Linux: `.AppImage` / `.deb` / `.rpm`

安装后直接打开 **Prometheus**。桌面端会尝试自动启动本地 control-plane sidecar，并连接：

```text
http://127.0.0.1:4310
```

首次可用路径：

1. 右上角/侧栏状态应显示 **SERVER ONLINE** 或 **Reachable**
2. 打开 **Configure runtime**
3. 在 **Control plane server** 确认 URL 为 `http://127.0.0.1:4310`，必要时点 **Retry connect**
4. 配置 Provider（OpenAI / Anthropic / 兼容接口）与 Agent
5. **Create task** 创建任务，再发送消息

如果一直 Connecting / Create Task 无效：

1. 浏览器访问 `http://127.0.0.1:4310/api/health` 看服务是否起来
2. 若 health 不通，单独启动 server 二进制（见下）
3. 回到客户端 Configure runtime → Save and reconnect

### 2. 独立 Server + WebUI

下载 `prometheus-server-windows-x64.exe`（或对应平台二进制）后：

```powershell
# Windows 示例：在任意目录运行
.\prometheus-server-windows-x64.exe
```

默认监听 `http://127.0.0.1:4310`，工作区为当前目录。可选环境变量：

```powershell
$env:PROMETHEUS_HOST = "127.0.0.1"
$env:PROMETHEUS_PORT = "4310"
$env:PROMETHEUS_WORKSPACE_ROOT = "D:\work\my-project"
$env:PROMETHEUS_DATA_FILE = "D:\work\my-project\.prometheus\prometheus.db"
.\prometheus-server-windows-x64.exe
```

验证：

```powershell
curl http://127.0.0.1:4310/api/health
```

然后：

- 浏览器打开 `http://127.0.0.1:4310`（若已附带 WebUI 静态资源）
- 或打开桌面客户端，把 Control plane URL 指到该地址

**要让局域网/公网的其他设备连进来**，必须同时设置访问令牌，否则 server 会拒绝启动：

```powershell
$env:PROMETHEUS_HOST = "0.0.0.0"
$env:PROMETHEUS_ACCESS_TOKEN = [Convert]::ToHexString((New-Object byte[] 32 | % { (New-Object Random).NextBytes($_); $_ }))
$env:PROMETHEUS_ALLOWED_ORIGINS = "http://192.168.1.10:5173"
.\prometheus-server-windows-x64.exe
```

在客户端 Settings → Connection 里把同一个令牌填入 Access token 后保存重连。

### 3. Android / iOS

Android APK：CI 会用仓库内 debug 证书签名，可侧载安装（非 Play 商店签名；仅 arm64）。手机需允许未知来源。APK **不内置 server**，需能访问 control plane（模拟器可用 10.0.2.2:4310 指向宿主机）。若安装器报 PackageInfo is null，说明拿到了未签名/损坏包，请改用带 debugsigned 的新版本。
- iOS 当前 Release 主要提供 Xcode 工程，**不是**可直接安装的签名 IPA

### 4. 资产职责对照

| 资产 | 作用 |
|------|------|
| Desktop installer | GUI + 本地 sidecar（本机一站式） |
| `prometheus-server-*` | 独立 control plane / 多端共享后端 |
| `prometheus-webui.zip` | 纯 Web 前端静态文件，需配合 server |
| Android APK | 移动客户端，不内置本机 server |
| iOS zip | 工程产物，不是商店包 |

