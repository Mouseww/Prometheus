# 租户运行时

Hub 为每个用户按需拉起一个隔离的 Prometheus server（租户实例），`serverOwner = userId`。实例的 web 与 API 通过 Hub 反向代理访问。设计见 `docs/superpowers/specs/2026-11-05-team-mode-sp3-hybrid-exec-design.md` 第 3 节。

## 驱动

`HUB_RUNTIME=auto|docker|sandbox|restricted`，默认 `auto`：docker 可用用 docker，否则 sandbox 可用用 sandbox，否则 restricted。显式指定的驱动不可用时直接报错（`runtimeUnavailable`，Windows 沙箱未设置时为 `adminRequired`），不会悄悄降级。

| 驱动 | 隔离 | 适用 |
|---|---|---|
| docker | 容器：非 root（uid 10001）、只读根文件系统、`--cap-drop ALL`、`no-new-privileges`、CPU/内存/进程数限制，可选 gVisor | 服务器、企业模式 |
| sandbox | 同机进程 + 系统沙箱（Linux bwrap、macOS sandbox-exec、Windows 低权限本地账号） | 小团队、Hub 在成员电脑上 |
| restricted | 无沙箱的普通子进程；Hub 主人拿到正常策略，其他人的实例禁 shell 并去掉 terminal 插件 | 没有 Docker 也没有沙箱时的兜底 |

`GET /api/admin/runtimes` 返回每个驱动是否可用以及原因，`GET /api/runtime` 返回当前用户自己的实例状态（`restricted` 字段用于界面上的“受限模式”标记）。

### Docker

- 不依赖 Docker SDK，Hub 自带最小 Engine API 客户端。连接方式按顺序：`DOCKER_HOST`（`unix://`、`npipe://`、`tcp://`，TLS 证书取自 `DOCKER_CERT_PATH` 下的 `ca.pem`、`cert.pem`、`key.pem`），否则 Linux/macOS 用 `/var/run/docker.sock`，Windows 依次尝试 `//./pipe/docker_engine` 与 `//./pipe/dockerDesktopLinuxEngine`。
- 镜像 `HUB_TENANT_IMAGE`，默认 `prometheus:local`（用仓库根的 `Dockerfile` 构建：`docker build -t prometheus:local .`）。本地没有该镜像时会先拉取。
- 租户目录 `<tenantRoot>/<userId>` 下的 `data` 与 `work` 挂载为 `/data` 与 `/workspace`（可写），`policy` 以只读挂载为 `/policy`，用户在容器内改不了自己的策略。端口发布到 `127.0.0.1` 的随机端口（多节点时发布到节点地址）。
- `HUB_DOCKER_RUNTIME=runsc` 使用 gVisor。安装 gVisor 后在 `/etc/docker/daemon.json` 注册 `runsc` 运行时并重启 Docker，然后设置该变量；在线服务（子项目 4）推荐开启。
- `HUB_TENANT_NETWORK` 指定容器网络（默认 `bridge`）。企业可用只能访问 Hub 与白名单地址的网络。容器内通过 `host.docker.internal` 访问同机 Hub（Hub 的 `publicUrl` 指向回环地址时自动替换），也可以用 `HubOptions.runtime.tenantHubUrl` 显式指定。

### Linux、macOS 沙箱

- Linux：`bwrap` 只读绑定 `/usr`、`/lib*`、`/bin`、`/etc/ssl`、`/etc/resolv.conf`、Node 与仓库，可写绑定租户的 `data` 与 `work`，`--unshare-pid --unshare-ipc --die-with-parent --clearenv`，新 `/tmp`。有 `systemd-run --user --scope` 时用它强制 `MemoryMax` 与 `CPUQuota`，否则只记录告警。Hub 数据目录不在沙箱里，租户读不到 Hub 的密钥。安装与自检：`sh scripts/hub-setup-sandbox.sh`。
- macOS：`sandbox-exec -p <profile>`，默认 deny，只读 Node、仓库、系统库，读写租户目录，允许网络。没有硬性资源限制。

### Windows 沙箱

每个租户使用一个本地低权限账号 `prom_t_<8 位十六进制>`（加入组 `prometheus-tenants`），以 PowerShell `Start-Process -Credential` 启动，并放进 Job Object（退出即杀、内存上限）。密码用 DPAPI 保存在 `<hubDataDir>/tenants.secrets/`，只有运行 Hub 的账号能解开。

一次性设置（需要管理员）：

```powershell
# 以管理员身份运行 PowerShell，用运行 Hub 的账号
# -DataDir 必须是 Hub 的数据目录：<PROMETHEUS_HOME>\plugin-data\team\hub（默认 %USERPROFILE%\.prometheus-hub\plugin-data\team\hub）
pwsh scripts/hub-setup-sandbox.ps1 -DataDir "$env:USERPROFILE\.prometheus-hub\plugin-data\team\hub"
```

脚本创建组 `prometheus-tenants`，拒绝该组读取 Hub 主人的用户目录与 Hub 数据目录，创建 `<DataDir>\tenants`，并写入标记文件 `<DataDir>\sandbox-setup.json`。Hub 从自己的数据目录读取这个标记文件，所以 `-DataDir` 必须与 Hub 的数据目录一致。没有标记文件时 sandbox 驱动不可用，`auto` 模式会落到 restricted，显式指定 `HUB_RUNTIME=sandbox` 则返回 `adminRequired`。Hub 的数据目录见[团队 Hub](team-hub.md)。

注意：

- Node 与 Prometheus 仓库不能放在 Hub 主人的用户目录里（租户账号被拒绝读取，启动不了）。
- 每个租户账号第一次启动时由 Hub 创建（`net user`、`icacls`），同样需要管理员权限，所以第一次使用某个新用户的实例时请以管理员身份运行 Hub，或接受 `adminRequired` 提示后再处理。
- Windows 沙箱路径尚未在真实机器上端到端验证，仅有命令构造的单元测试。

### Restricted

与 sandbox 一样直接 spawn Node，但不加沙箱。策略对 Hub 主人（operator）是正常策略；对其他用户去掉 `terminal` 插件，并在 core 支持 `disabledTools` 时加上 `disabledTools: ["bash", "powershell"]`。core 不认识该字段时（它会拒绝未知策略键，当前仓库的 core 已认识该字段，旧版 core 才会如此）Hub 自动不写这个键，由 `HUB_TENANT_DISABLED_TOOLS=1|0` 可强制开关。

## 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `HUB_RUNTIME` | `auto` | 驱动选择 |
| `HUB_TENANT_ROOT` | `<dataDir>/tenants` | 租户目录根 |
| `HUB_TENANT_IMAGE` | `prometheus:local` | docker 镜像 |
| `HUB_DOCKER_RUNTIME` | 空 | 例如 `runsc` |
| `HUB_TENANT_NETWORK` | `bridge` | docker 网络 |
| `HUB_TENANT_ENTRY` | `apps/server/src/main.ts` | 进程类驱动的 server 入口 |
| `HUB_TENANT_CPU` | `1` | 每租户 CPU 核数 |
| `HUB_TENANT_MEM_MB` | `2048` | 每租户内存（MB） |
| `HUB_TENANT_IDLE_MINUTES` | `30` | 闲置多久后停止 |
| `HUB_TENANT_MAX` | `3` | 同机同时运行的实例数，超出排队（有执行节点时不适用） |
| `HUB_TENANT_DISABLED_TOOLS` | 自动检测 | 强制策略是否带 `disabledTools` |

## 租户实例的环境

`PROMETHEUS_HOME`、`PROMETHEUS_CWD`、`PROMETHEUS_HOST`、`PROMETHEUS_PORT`、`PROMETHEUS_TOKEN`（随机，仅 Hub 持有）、`PROMETHEUS_TRUST_KEY`（`@<policy 目录>/hub-trust.pem`，Hub 公钥）、`PROMETHEUS_TRUST_ISSUER`、`PROMETHEUS_TRUST_AUDIENCE=prometheus`、`PROMETHEUS_POLICY`、`TEAM_HUB_URL`、`TEAM_TENANT_TOKEN`（`aud=prometheus-tenant`，30 天）。

`policy.json` 由 Hub 生成：`serverOwner`、`forbiddenModes=["bypassPermissions","auto"]`、`readOutsideProject="ask"`、`pluginAllowlist`（`team`、`git`、`memory`、`skills`、`todos`、`subagents`、`modes`、`mcp`、`knowledge-lancedb`、`terminal`）、指向 Hub 模型代理 `/llm/<format>` 的 `gateways`（密钥是该用户的 7 天 JWT，不含任何上游 API Key）、`managedBy`。

## 生命周期

- 按需启动：`/rt/*` 请求、`POST /api/runtime/start` 或其他模块调用 `runtime.manager.ensureRunning(userId)`。
- 健康检查：每 15 秒轮询 `/api/health`，连续 2 次失败按崩溃处理；进程或容器退出立即处理。崩溃自动重启，10 分钟内超过 3 次标记 `failed` 并通过通知服务发送 `tenant.failed`。下一次显式请求会重新开始计数。
- 闲置停止：没有代理中的请求和 WebSocket，持续 `HUB_TENANT_IDLE_MINUTES` 后停止，数据目录保留。
- 容量：同机超过 `HUB_TENANT_MAX` 或节点放不下时排队，每 30 秒重试，10 分钟后返回 `503 capacityExhausted`。
- Hub 重启：数据库里遗留的 running 状态被重置为 stopped；docker 容器按名称在下次启动时替换。

## 反向代理

`<base>/rt/*` 代理 HTTP 与 WebSocket 到调用者自己的租户实例，永远不会到别人的实例。认证三选一：`Authorization: Bearer <Hub 访问令牌>`、cookie `prometheus_hub_rt`、首次加载的 `?token=`（设置 cookie 后 302 去掉 token）。代理把 `Authorization` 换成 Hub 现签的 15 分钟 JWT（`aud=prometheus`、`sub=userId`），去掉所有 cookie 与 `X-Forwarded-*`，并丢弃租户的 `Set-Cookie`。租户的重定向 `Location` 会补上 `<base>/rt` 前缀。

## 管理接口

执行节点（仅 operator）：

- `GET/POST /api/admin/nodes`，`PUT/DELETE /api/admin/nodes/:id`，`POST /api/admin/nodes/:id/drain`，`POST /api/admin/nodes/:id/ping`
- 节点字段：`name`、`dockerUrl`、`tlsDir`、`cpuCapacity`、`memCapacityMb`、`status`（`active|draining|offline`）。远程 `tcp://` 节点必须提供 `tlsDir`。列表同时返回每节点已分配的 CPU、内存和租户。
- 调度：只在 `active` 节点里选剩余内存最多且放得下的；没有任何节点记录时用本机 Docker。

租户实例（operator 看全部，组织管理员看本组织）：

- `GET /api/admin/runtimes`（实例列表、当前模式、各驱动可用性）
- `POST /api/admin/runtimes/:userId/stop`
- `PUT /api/admin/runtimes/:userId/limits`，body `{cpuLimit?, memLimitMb?}`，`null` 清除覆盖。对运行中的实例在下次启动时生效（视图里 `restartRequired`）。

当前用户：`GET /api/runtime`，`POST /api/runtime/start`。
