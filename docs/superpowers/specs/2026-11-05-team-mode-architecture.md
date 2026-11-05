# Prometheus 团队模式：总体架构

日期：2026-11-05 · 分支：`feat/team-mode` · 状态：已确认方向，按子项目推进

本文是总纲：定下四个子项目的边界、共享的数据模型、部署形态与安全模型。每个子项目另有详细设计文档（`2026-11-05-team-mode-sp1-core-seams-design.md` 等）。

## 1. 意图与核心原则

Prometheus 目前是单用户、全信任的 Agent 工作台。目标是让它同时成为团队协作工具，并最终能作为在线服务对外提供，帮助团队共享工作进度、互不干扰、及时获得最新信息。

**核心原则（不可违背）**：Prometheus 不能变成只适合团队的产品。个人本地安装、不连任何服务、不需要账号的用法必须保持现状。团队能力以「团队插件 + Hub」的形式挂在外面，核心只增加少量在个人模式下有合理默认值、可回馈上游的通用接口。

## 2. 用法全景

| 用法 | 说明 |
|---|---|
| 个人本地安装 | 与现在一致，无账号，不连 Hub |
| 在线服务个人用户 | 在运营方部署的 Hub 注册，个人空间跑在服务端隔离容器里，不属于任何企业 |
| 个人自建团队 | 在线服务的个人用户建团队并邀请他人，创建者为团队管理员，团队归该用户所有 |
| 企业 | 企业管理员管理成员、团队、模型、额度、注册策略；企业内团队归企业所有 |
| 私有部署（企业模式） | Hub 在虚拟机上，PostgreSQL 独立运行，执行节点按需启动容器 |
| 小团队模式 | Hub 跑在某个成员电脑上（独立进程、不跑主人自己的 Agent），PostgreSQL 内嵌，不强制 Docker |

私有部署 = 只有一个企业的平台；小团队模式 = 一个企业只有一个团队。三种部署是同一套代码。

## 3. 四个子项目

| # | 子项目 | 交付物 | 依赖 |
|---|---|---|---|
| 1 | 核心接口改造 | 可插拔认证、插件路由自带认证、会话所有者与权限请求定向、管理员策略锁定层、按路径的读取确认、会话事件钩子 | 无 |
| 2 | 团队协作（私有部署） | `plugins/team`（成员角色 + Hub 角色）、Hub 数据层、账号与注册策略、企业/团队/成员与角色、团队工作区与 git 主副本、会话镜像与旁观、授权、fork、合并请求与审核、日报与看板、后台管理 | 1 |
| 3 | 混合执行 | 「一个大脑，两只手」、本机 server 与团队 server 的副本同步、团队优先/本机优先两种模式与会话移交、租户隔离运行时（容器 / 系统沙箱 / 受限模式） | 1, 2 |
| 4 | 在线服务 | 企业管理界面、公开注册与邮箱验证与防滥用、计费（免费额度、充值、套餐、企业额度池）、支付适配器、自带模型的安全处理、gVisor 等加固运行时配置 | 2, 3 |

数据模型与隔离要求在子项目 1、2 就按最终形态（企业 > 团队 > 个人）设计，后续子项目只增不改。

## 4. 组件与进程

```
客户端（桌面 / 网页 / 安卓）
   │  WebSocket（现有协议）
   ▼
本机 server（每人一个，只属于本人）──团队插件·成员角色──┐
                                                       │ HTTPS + WebSocket（Hub API，JWT）
                                                       ▼
                                   Hub（Prometheus 实例，PROMETHEUS_ROLE=hub，不跑主人 Agent）
                                     ├─ 团队插件·Hub 角色：账号、组织、团队、工作区、审核、日报、计费、后台
                                     ├─ 模型代理（公司/运营方模型、按人限额、用量记账）
                                     ├─ git 主副本（每个团队工作区一个 bare 仓库）
                                     ├─ 租户运行时管理（子项目 3：容器 / 沙箱 / 受限）
                                     └─ PostgreSQL（外部实例或内嵌 PGlite）
```

- Hub 是一个以 `PROMETHEUS_ROLE=hub` 启动的 Prometheus 实例，加载团队插件的 Hub 角色。Hub 角色模块保持自包含，日后可以单独拆出运行。
- Hub 进程本身禁用会话、终端等 Agent 能力；需要在服务端跑 Agent 时（团队优先模式），由租户运行时为每个用户拉起**独立的、隔离的** Prometheus 实例。

## 5. 共享数据模型（PostgreSQL）

所有表带 `created_at`、`updated_at`。ID 为字符串（ULID 风格）。`org_id` 可空：为空表示个人所有。

| 表 | 关键字段 |
|---|---|
| `users` | `id, email(unique), display_name, password_hash, status(pending/active/disabled), email_verified_at, platform_role(operator/null)` |
| `organizations` | `id, name, slug(unique), status, settings jsonb` |
| `org_members` | `org_id, user_id, role(owner/admin/member), status` |
| `teams` | `id, org_id(null=个人所有), owner_user_id(个人所有时), name` |
| `team_members` | `team_id, user_id, role(admin/reviewer/member)` |
| `workspaces` | `id, team_id, name, repo_dir, default_branch` |
| `sessions` | `id, workspace_id, owner_user_id, title, exec_location, status, forked_from_session_id, base_commit, branch` |
| `session_events` | `session_id, seq, kind, payload jsonb`（会话镜像，供旁观与 fork） |
| `session_grants` | `session_id, user_id, granted_by` |
| `merge_requests` | `id, workspace_id, session_id, author_id, branch, base_commit, head_commit, status(open/approved/merged/rejected/conflict), reviewer_id, skipped_review` |
| `notifications` | `id, user_id, kind, payload, read_at` |
| `registration_policies` | `scope(platform/org), scope_id, mode(open/domain/approval/invite/closed 组合), allowed_domains, require_approval` |
| `invitations` | `id, scope, scope_id, email, token_hash, expires_at` |
| `model_gateways` | `id, scope(platform/org/user), scope_id, config(加密)` |
| `quotas` | `subject(user/org/team), period, limit_tokens` |
| `usage_ledger` | `id, user_id, org_id, gateway_id, model, input_tokens, output_tokens, cost, source(platform/byok)` |
| `wallets` / `plans` / `subscriptions` / `orders` | 子项目 4 |
| `daily_reports` | `workspace_id, date, content` |
| `audit_log` | `id, actor_id, org_id, action, target, detail jsonb` |
| `executor_nodes` / `tenant_runtimes` | 子项目 3 |

**企业隔离**：企业边界由 PostgreSQL 行级安全（RLS）保证。Hub 的数据访问层在每个事务开头 `SET LOCAL app.user_id = ...`，策略只放行该用户作为成员可见的企业与个人行。代码里的权限判断是第二道防线，不是唯一防线。

## 6. 身份与权限

- **身份**：Hub 签发短期 JWT（Ed25519）。本机 server 与租户实例通过子项目 1 的「可插拔认证」信任 Hub 公钥。
- **角色层级**：平台运营方 > 企业所有者/管理员 > 团队管理员/审核人 > 成员。个人所有的团队，创建者为团队管理员。
- **会话规则**：团队会话默认团队成员可见、只读；所有者可授权他人操作；任何成员可 fork（通知所有者）。fork 出的会话归 fork 者。
- **合并规则**：普通成员提交合并请求，管理员或审核人通过后合并；有审核权的人可跳过审核，必写审计日志。
- **凭证**：调用外部系统用会话所有者本人的凭证。
- **可见性原则**：进入团队工作区的内容默认团队可见。为了让用户能真正做判断，读取会话副本之外的文件必须本人确认（子项目 1 的读取策略，团队会话强制开启）。
- **一个 server 只属于一个人**：团队模式下禁止多人直接连同一个本机 server；他人通过 Hub 旁观或 fork。

## 7. 部署形态

| 形态 | Hub | 数据库 | 执行 |
|---|---|---|---|
| 小团队 | 某成员电脑上的独立 Hub 进程 | 内嵌 PGlite（WASM 版 PostgreSQL） | 本机优先为主；团队优先时用最强可用隔离：Docker > 系统沙箱 > 受限模式 |
| 企业私有部署 | 中心虚拟机 | 外部 PostgreSQL | 执行节点 Docker 容器，按需启动、闲置停止、资源配额 |
| 在线服务 | 运营方集群 | 外部 PostgreSQL | 只允许容器，推荐 gVisor 运行时、出站限制、配额 |

## 8. 安全底线

1. 企业之间：RLS + 每企业独立密钥与目录。
2. 用户之间：一个 server 一个人；服务端执行一律经租户隔离；应用层路径检查不算隔离。
3. Hub 主人与租户之间：Hub 进程不跑 Agent；租户看不到主人的个人目录。
4. 模型 Key：公司/运营方 Key 只存在 Hub，不进用户容器；用户自带的 base URL 必须拒绝内网与私有地址（防 SSRF）。
5. 跳过审核、授权、合并、管理员操作全部写审计日志。

## 9. 非目标

- 不把用户、租户概念塞进 Prometheus 核心的每个存储点。
- 子项目 1 不改变任何个人模式下的默认行为。
- 不做实时协同编辑（同一文件多人同时编辑）；协作单位是会话与副本。
- 不自研支付网关；支付走适配器。

## 10. 已做的决定（含我的判断）

| 决定 | 来源 |
|---|---|
| 团队能力 = 团队插件 + Hub，核心只加接口 | 用户原则，方案由我提出、用户认可 |
| 数据库用 PostgreSQL，小团队用内嵌 PGlite | 用户要求不用 SQLite；PGlite 是我的选择，因它是真 PostgreSQL 且不需安装 |
| JWT 用 Ed25519 | 我的选择 |
| Hub 为 `PROMETHEUS_ROLE=hub` 的 Prometheus 实例 | 用户希望 Hub 随团队插件一起安装；角色开关是我的设计 |
| 隔离三档：容器 > 系统沙箱 > 受限模式；Windows 首次需管理员授权 | 用户确认 |
| 注册策略可配置，默认「公司邮箱域名 + 审批」 | 默认值是我的建议 |
| 团队首页默认视图按角色区分 | 我的建议 |
| 计费：默认运营方模型 + 免费额度 + 充值 + 套餐 + 自带 base URL/Key | 用户确认 |
