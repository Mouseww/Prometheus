# 子项目 3：混合执行设计

日期：2026-11-05 · 分支：`feat/team-mode` · 依赖：子项目 1、2 · 上级文档：`2026-11-05-team-mode-architecture.md`

## 1. 目标

- 团队会话可以在两种执行模式间切换：
  - **本机优先**：Agent（大脑）在用户本机 server 上运行；需要时调用团队 server 上的「远程之手」，或把整个会话移交到团队 server。
  - **团队优先**：大脑在团队 server 上该用户的**隔离租户实例**里运行；需要读本机内容时调用「本机之手」（本机确认）。
- 用户对自己有操作权限的会话，本机副本与团队 server 副本之间同步（排除编译产物）。
- 团队 server 为每个用户提供隔离的租户实例：有 Docker 用容器，无 Docker 用系统沙箱，都不可用时受限模式；企业模式支持多台执行节点。

非目标：同一文件多人实时协同；跨企业共享租户实例。

## 2. 术语

| 术语 | 含义 |
|---|---|
| 本机 server | 用户自己机器上的 Prometheus（装团队插件成员角色） |
| 租户实例 | Hub 为某用户拉起的独立 Prometheus server 进程或容器，`serverOwner = userId`，只有该用户（或其委托）能连 |
| 运行时驱动 | `docker`、`sandbox`、`restricted` 三种拉起租户实例的方式 |
| 执行位置 | 会话大脑当前所在：`local` 或 `team` |
| 手 | 一组工具的执行端。`local.*` 工具在本机执行；`team.*` 工具在租户实例执行 |

## 3. 租户实例

### 3.1 实例内容

- 进程：`node apps/server/src/main.ts`（容器内同理），环境：
  - `PROMETHEUS_HOME=<tenantRoot>/<userId>/data`、`CWD=<tenantRoot>/<userId>/work`
  - `PROMETHEUS_HOST=127.0.0.1`（容器内 `0.0.0.0`）、`PORT=<分配端口>`、`PROMETHEUS_TOKEN=<随机，仅 Hub 持有>`
  - `PROMETHEUS_TRUST_KEY=<Hub 公钥>`、`PROMETHEUS_TRUST_ISSUER`、`PROMETHEUS_TRUST_AUDIENCE=prometheus`
  - `PROMETHEUS_POLICY=<data>/policy.json`，由 Hub 生成：`serverOwner=userId`、`forbiddenModes=["bypassPermissions","auto"]`、`readOutsideProject="ask"`、`pluginAllowlist`（默认内置插件去掉 `computer-use`、`ssh`、`browser` 的桌面依赖项；保留 `team`、`git`、`memory`、`skills`、`todos`、`subagents`、`modes`、`mcp`、`knowledge-lancedb`、`terminal`）、`gateways`（指向 Hub 模型代理）、`managedBy`
  - `TEAM_HUB_URL`、`TEAM_TENANT_TOKEN`（Hub 签发的长期租户凭证，`aud="prometheus-tenant"`，`sub=userId`，`tenant=true`），团队插件据此以成员角色连接 Hub，免登录。
- 受限模式额外：策略 `disabledTools=["bash","powershell"]` 且 `pluginAllowlist` 去掉 `terminal`（需要 core 策略新增 `disabledTools`，见 §8）。

### 3.2 访问

- 客户端访问自己的租户实例：Hub 反向代理 `/plugins/team/rt/*` 到该用户的实例（HTTP 与 WebSocket 都代理）。Hub 用访问令牌识别用户，代理时把请求头 `Authorization: Bearer <给实例的 JWT>` 替换为 Hub 为该用户签发的 JWT（`aud=prometheus`），实例通过子项目 1 的可插拔认证识别身份。
- web：Hub 模式的 `HubApp` 增加「我的工作台」入口，在 iframe 或新标签打开 `/plugins/team/rt/`（实例的 web 静态资源由实例自己提供，`PROMETHEUS_WEB_ROOT` 指向同一份构建产物）。
- 他人永远不能连到别人的实例（`serverOwner` 约束 + 代理层只代理到令牌主人的实例）。

### 3.3 生命周期

- 按需启动：用户打开工作台、某会话切到团队执行、或有该用户的远程之手调用时启动。
- 闲置停止：无客户端连接、无运行中的 Agent、无待处理转发，持续 `HUB_TENANT_IDLE_MINUTES`（默认 30）分钟后停止。数据目录保留。
- 健康检查：`/api/health` 轮询；崩溃自动重启最多 3 次/10 分钟，超出标记 `failed` 并通知用户。
- 表 `tenant_runtimes(user_id primary key, org_id null, driver, node_id null, status check in ('stopped','starting','running','stopping','failed'), port, container_id, pid, started_at, last_seen_at, cpu_limit, mem_limit_mb)`（迁移 `005_runtime.sql`）。

### 3.4 运行时驱动

接口（`packages/hub/src/runtime/driver.ts`）：

```ts
export interface RuntimeDriver {
	readonly kind: "docker" | "sandbox" | "restricted";
	available(): Promise<boolean>;
	start(spec: TenantSpec): Promise<TenantHandle>;
	stop(handle: TenantHandle): Promise<void>;
	stats(handle: TenantHandle): Promise<{ cpuPercent?: number; memMb?: number }>;
}
export interface TenantSpec { userId: string; root: string; env: Record<string, string>; cpuLimit: number; memLimitMb: number; node?: ExecutorNode }
export interface TenantHandle { userId: string; host: string; port: number; containerId?: string; pid?: number }
```

选择：`HUB_RUNTIME=docker|sandbox|restricted|auto`（默认 `auto`：docker 可用则 docker，否则 sandbox 可用则 sandbox，否则 restricted）。在线服务（子项目 4）强制 docker。

**docker**
- 不引入 Docker SDK 依赖：实现一个最小 Docker Engine API 客户端（`packages/hub/src/runtime/docker-api.ts`），支持 Unix socket（`/var/run/docker.sock`）、Windows 命名管道（`//./pipe/docker_engine`）、`tcp://` + TLS（`DOCKER_CERT_PATH` 下 `ca.pem`/`cert.pem`/`key.pem`）。用到的端点：`/_ping`、`/containers/create`、`/containers/{id}/start|stop|json|stats?stream=false`、`DELETE /containers/{id}`、`/images/create`（拉取镜像）。
- 镜像：`HUB_TENANT_IMAGE`（默认使用仓库 `Dockerfile` 构建的镜像名 `prometheus:local`）。
- 容器参数：非 root（uid 10001）、`--read-only` 根文件系统 + 可写 bind mount `<tenantRoot>/<userId>` 到 `/data` 与 `/workspace`、`--cap-drop ALL`、`--security-opt no-new-privileges`、`NanoCpus`、`Memory`、`PidsLimit=512`、可选 `Runtime: "runsc"`（`HUB_DOCKER_RUNTIME`，在线服务推荐 gVisor）、网络：`HUB_TENANT_NETWORK`（默认 bridge；企业可指定只能访问 Hub 与白名单的网络）。端口发布到 `127.0.0.1:<随机>`（单机）或节点地址（多节点）。

**sandbox**（同机进程 + 系统沙箱）
- Linux：`bwrap`，只读绑定 `/usr /lib /lib64 /bin /etc/ssl /etc/resolv.conf` 与 Node 与仓库目录，可写绑定租户目录，`--unshare-pid --unshare-ipc --die-with-parent`，新 `/tmp`；用 `systemd-run --user --scope -p MemoryMax= -p CPUQuota=`（可用时）限制资源，否则只记录告警。
- macOS：`sandbox-exec -p <profile>`，profile 默认 deny，允许读 Node、仓库、系统库，读写租户目录，允许网络。资源限制：无硬限制，Hub 侧监控内存超额时重启并告警。
- Windows：每个租户一个本地低权限账号 `prom_t_<短id>`（`net user` 创建，随机密码用 DPAPI 保存在 `<hubDataDir>/tenants.secrets`），`icacls` 授予该账号对租户目录完全控制、移除 Users 组对 Hub 主人个人目录的继承访问不在我们权限内 → 改为：确保租户账号**不在** Users 以外的组、并对 Hub 主人家目录显式 `deny` 该账号读取（`icacls <home> /deny prom_t_x:(OI)(CI)R`）。用 PowerShell `Start-Process -Credential` 以该账号启动 Node。首次启用需要管理员权限：Hub 检测到非管理员时，返回 `adminRequired`，UI 引导主人用「以管理员身份运行」执行一次 `pnpm hub:setup-sandbox`（脚本创建账号、设置 ACL、写标记）。资源：无 Job Object 时仅监控告警。
- `available()`：对应平台二进制存在（Linux `bwrap`，macOS `/usr/bin/sandbox-exec`，Windows 已完成 setup 标记）。

**restricted**
- 与 sandbox 相同的进程启动方式但不加沙箱，只对 **Hub 主人本人** 开放团队优先模式；其他用户的租户实例以受限策略启动（禁 shell、禁 terminal 插件、读取策略 ask），UI 明确显示「受限模式」。

### 3.5 执行节点（企业模式）

- 表 `executor_nodes(id, name, docker_url, tls_dir, cpu_capacity, mem_capacity_mb, status check in ('active','draining','offline'), last_ping_at)`。
- 后台管理：增删节点、标记 draining、查看每节点已分配的 CPU/内存与租户列表。
- 调度：选择 `active` 节点中「剩余内存」最多的；单机（无节点）时使用本机 Docker。容量不足时返回 `capacityExhausted`，UI 显示排队提示，Hub 每 30 秒重试一次，最多 10 分钟。
- 资源默认：`HUB_TENANT_CPU=1`、`HUB_TENANT_MEM_MB=2048`，企业/用户可在后台覆盖（`tenant_runtimes` 上的 limit 字段由后台写）。

## 4. 两只手

### 4.1 工具

由团队插件注册（`ctx.tools.register`），只在团队会话（cwd 位于团队 worktree 下）中可用：

| 工具 | 注册在 | 执行在 | 说明 |
|---|---|---|---|
| `local_read`, `local_ls`, `local_grep`, `local_exec` | 租户实例 | 用户本机 | 团队优先模式的本机之手 |
| `team_exec`, `team_read`, `team_ls` | 本机 server | 租户实例 | 本机优先模式的远程之手 |

- 工具描述明确写出「在哪台机器执行」，以便 Agent 选择；UI 在工具调用块上显示执行位置徽标。
- 本机之手的确认：本机团队插件收到调用请求后，通过插件流（`ctx.stream.publish("handRequest", ...)`）通知本机客户端，团队视图与聊天界面顶部弹出确认条（显示工具、参数、发起会话）；用户可选「允许一次 / 本会话内允许同类 / 拒绝」。路径类请求仍套用读取策略：项目副本内的路径可设为自动允许。超时 120 秒视为拒绝。
- 远程之手无需确认（租户实例是用户自己的隔离环境），但受租户实例自身策略约束（受限模式下 `team_exec` 不可用）。

### 4.2 转发通道

- 本机团队插件与租户实例中的团队插件都已连在 Hub WebSocket 上（成员角色）。新增消息：
  - `{type:"hand.call", callId, fromSession, tool, input, targetUserId, target:"local"|"team"}` → Hub 检查发起方与目标属于同一用户（或目标为委托允许的人），转发给目标端连接。
  - `{type:"hand.result", callId, ok, output?, error?}` 原路返回。
- 目标离线 → 立即返回错误 `handOffline`，Agent 收到可读的错误文本。

## 5. 副本同步

- 范围：用户有操作权限的团队会话；排除规则同子项目 2 §6.2。
- 机制：基于 git 快照 ref，单写者。
  - 每个会话在两端各有一个 worktree（本机 `.../sessions/<id>`，租户实例 `/workspace/teams/.../sessions/<id>`），对应同一会话分支。
  - 当前执行位置一侧为「写者」。写者在每轮结束（`agent_end`）与每次手调用前后生成快照（临时索引 commit-tree），推送到 `refs/prometheus/snapshots/<userId>/<sessionId>/latest`，并经 Hub WebSocket 广播 `snapshot.updated`。
  - 另一侧收到后 fetch 并**应用**：若本侧工作区自上次应用后未被修改（比较当前临时索引树与 `last-applied` 记录的树），直接把工作区更新为快照树（`git read-tree -u --reset <tree>`，配合临时索引，未跟踪且被忽略的文件不动）；若被修改（例如用户在本机手动改了文件），先把本侧状态快照到 `refs/prometheus/snapshots/<userId>/<sessionId>/conflict-<时间>`，再应用，并发通知「你的本地改动已另存，未丢失」，UI 提供「恢复我的改动」（把冲突快照 checkout 到一个新会话分支）。
- 换手屏障：切换执行位置或调用另一侧的手之前，写者先推送最新快照，等待另一侧确认已应用（`snapshot.applied` 回执，超时 30 秒则中止切换并提示）。

## 6. 模式切换与移交

- 会话级字段：`sessions.exec_location`（`local`/`team`）、`sessions.exec_mode`（`local-first`/`team-first`）。用户在会话顶部切换。
- **本机 → 团队（移交）**：
  1. 本机写者推送快照并停止本地 Agent（若在运行，提示用户等待或中断）。
  2. 本机导出转写，`PUT /api/sessions/:id/transcript`。
  3. Hub 确保租户实例运行；租户团队插件在实例中准备 worktree（clone/fetch 团队仓库，检出会话分支与快照树），`importTranscript` 导入为实例内会话，回报 `tenantSessionId`。
  4. `exec_location='team'`；本机会话标记为只读镜像（UI 显示「此会话在团队 server 执行中」，输入框改为发往租户实例）。
- **团队 → 本机**：对称流程。
- 用户的客户端在团队执行时，通过 Hub 反向代理直接连租户实例的会话（完整交互），而不是旁观视图。

## 7. 小团队模式（Hub 在成员电脑上）

- 默认 `HUB_RUNTIME=auto`：多数 Windows 个人电脑无 Docker → sandbox（需管理员一次性 setup）→ 否则 restricted。
- 同时运行的租户实例上限 `HUB_TENANT_MAX`（默认 3），超出排队。
- Hub 主人自己的团队优先会话：可直接使用其个人实例以外的一个租户实例（也受隔离），保持「Hub 进程不跑 Agent」。

## 8. core 补充

- `AdminPolicy.disabledTools?: string[]`：被禁用的工具不提供给 Agent（PI 运行时在工具注册处过滤；其他运行时在权限门 `decide` 前直接 `block`，原因「已被管理员禁用」）。
- `PrometheusHost` 允许插件为某会话设置展示信息 `ctx.sessions.setBadge(sessionId, {text, tone})`，用于 UI 显示「团队 server 执行中」「受限模式」等（`SessionSummary.badge?`）。

## 9. 测试

- 驱动选择逻辑（假 `available()`）；Docker API 客户端对本地假 HTTP 服务器（socket 文件或 TCP）构造正确请求；容器参数快照测试。
- sandbox：Linux 下若 `bwrap` 存在则做真实启动测试（否则 skip）；各平台命令构造的单元测试；Windows setup 脚本的命令构造测试（不执行）。
- 租户生命周期：用一个假的 `process` 驱动（直接 spawn 真实 `apps/server/src/main.ts`，127.0.0.1）跑通：启动、健康检查、通过 Hub 反向代理用 JWT 访问、`serverOwner` 拒绝他人、闲置停止。
- 手转发：两个假成员连接，`hand.call` 往返、离线错误、跨用户拒绝。
- 同步：两个 worktree 目录 + 本地 bare 仓库，写者快照/应用、被修改时另存冲突快照、换手屏障超时。
- 移交：假 Hub + 假租户插件，转写导入与 `exec_location` 变化。

## 10. 开发拆分

| 块 | 内容 | 文件所有权 |
|---|---|---|
| 3A | 运行时：驱动接口、docker API 客户端、docker/sandbox/restricted 驱动、`005_runtime.sql`、生命周期管理、执行节点与调度、反向代理、后台管理 API（节点、资源）、`hub:setup-sandbox` 脚本 | `packages/hub/src/runtime/**`、`src/routes/runtime.ts`、`scripts/hub-setup-sandbox.*` |
| 3B | 两只手与同步与移交：团队插件中的工具、转发协议、快照写/应用、换手屏障、移交流程；core 补充（§8） | `plugins/team/src/hands/**`、`plugins/team/src/sync/**`、`packages/core/**`（§8 部分）、`packages/hub/src/services/hands.ts` |
| 3C | UI：执行位置切换、手确认条、受限模式徽标、工作台入口、节点与资源后台页面 | `apps/web/**` |
