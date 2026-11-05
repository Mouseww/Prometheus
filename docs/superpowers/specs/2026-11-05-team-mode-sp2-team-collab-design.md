# 子项目 2：团队协作（私有部署）设计

日期：2026-11-05 · 分支：`feat/team-mode` · 依赖：子项目 1（核心接口）· 上级文档：`2026-11-05-team-mode-architecture.md`

## 1. 范围

交付一个可以在公司内部（企业模式）或某成员电脑上（小团队模式）运行的 Hub，以及装在每个人 Prometheus 上的团队插件，使一个项目组能够：

- 注册登录（注册策略、审批、邀请），管理企业、团队、成员与角色；
- 建立团队工作区（git 主副本），每个会话在自己的 worktree 副本里工作；
- 旁观同事的会话与文件，被授权后操作，或 fork 后自己操作（提醒所有者）；
- 提交合并请求，管理员或审核人审核，有权者可跳过审核；
- 每天自动生成团队日报，在「日报 / 看板」两个视图查看；
- 后台管理：用户、审批、注册策略、企业与团队、模型网关与按人限额、用量、审计日志。

不在本子项目：团队优先执行与本机/团队双向同步（子项目 3）、公开注册防滥用、计费与支付（子项目 4）。本子项目的「同步」只到：本机副本快照单向上传到 Hub，供他人旁观与 fork。

## 2. 代码布局

| 位置 | 内容 |
|---|---|
| `packages/hub`（新，`@prometheus/hub`） | Hub 的全部服务端逻辑，自包含、与 Prometheus host 解耦：数据库、迁移、服务、HTTP 路由、git、调度、模型代理。导出 `createHub(options): Promise<Hub>` |
| `plugins/team`（新，`@prometheus/plugin-team`） | 两种角色。Hub 角色：`serverRole()==="hub"` 时 `createHub` 并把路由挂到 `/plugins/team/*`。成员角色：其余情况，连接 Hub、管理团队 worktree、上传会话快照、执行 Hub 转发的操作、给前端提供 RPC |
| `apps/web/src/team/`（新） | 团队相关 React 组件：Hub 模式页面（登录注册、后台管理、团队页）与成员模式的「团队」视图共用 |
| `packages/core` | 子项目 2 需要的少量新增接口（见 §9） |

`packages/hub` 不依赖 `packages/core` 的 host，只用其中的 `jwt` 工具（子项目 1 的 `packages/core/src/identity/jwt.ts`）。若引用 core 造成循环或过重，可把 `jwt.ts` 复制为 `packages/hub/src/jwt.ts` 并在两处测试中各自覆盖；优先直接引用。

## 3. 数据库

### 3.1 驱动

- 接口 `Db`（`packages/hub/src/db/db.ts`）：
  ```ts
  export interface Db {
  	query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  	/** Runs fn in a transaction scoped to a user (RLS) or as the system (no user; bypasses org filtering). */
  	tx<T>(scope: DbScope, fn: (q: Queryable) => Promise<T>): Promise<T>;
  	close(): Promise<void>;
  }
  export type DbScope = { system: true } | { userId: string; operator?: boolean };
  export interface Queryable { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> }
  ```
- 两个实现：
  - `openPglite(dir | "memory")`：`@electric-sql/pglite@0.5.10`。小团队模式与测试用。
  - `openPostgres(url)`：`postgres@3.4.9`（postgres.js），`max` 连接数默认 10。企业模式用。
- 选择：`HUB_DATABASE_URL` 存在用 postgres，否则 PGlite，数据目录 `<hubDataDir>/pgdata`。

### 3.2 迁移

- `packages/hub/src/db/migrations/NNN_name.sql`，按序执行，记录在 `schema_migrations(version text primary key, applied_at timestamptz)`。启动时自动迁移。
- 文件编号分配（避免并行开发冲突）：`001_core.sql`（账号、组织、团队、策略、审计）、`002_git.sql`（工作区、合并请求）、`003_sessions.sql`（会话镜像、授权、通知、日报）、`004_models.sql`（网关、配额、用量）。

### 3.3 行级安全

- 迁移创建角色 `prometheus_app`（`NOLOGIN`），授予全部业务表的 `SELECT, INSERT, UPDATE, DELETE`；`GRANT prometheus_app TO CURRENT_USER`（PGlite 下 current_user 为 `postgres`）。
- 带 `org_id` 的表全部 `ENABLE ROW LEVEL SECURITY` 并建策略：
  ```sql
  USING (
    org_id IS NULL
    OR current_setting('app.operator', true) = '1'
    OR org_id IN (SELECT org_id FROM org_members WHERE user_id = current_setting('app.user_id', true) AND status = 'active')
  )
  ```
  `org_members` 自身的策略：`user_id = current_setting('app.user_id', true) OR org_id IN (...同上...)`，注意避免策略递归（用 `SECURITY DEFINER` 函数 `app_user_orgs()` 返回当前用户所属 org 列表）。
- `tx({userId})`：`BEGIN; SET LOCAL ROLE prometheus_app; SELECT set_config('app.user_id', $1, true); SELECT set_config('app.operator', $2, true); ...; COMMIT`。
- `tx({system:true})`：不切角色（以表所有者身份运行，绕过 RLS），只用于迁移、调度器、注册、登录、git 鉴权等系统流程。
- 个人所有的数据（`org_id IS NULL`）的细粒度权限（团队成员关系、会话授权）在服务层判断。RLS 只负责企业边界。

### 3.4 表（摘要，DDL 由实现者按此写）

所有表：`id text primary key`（ULID，`packages/hub/src/ids.ts` 实现，无依赖），`created_at timestamptz default now()`，需要时 `updated_at`。

`001_core.sql`
- `users(id, email citext-like lower unique, display_name, password_hash, status check in ('pending','active','disabled'), email_verified_at, platform_role check in ('operator') null)`
- `organizations(id, name, slug unique, status, settings jsonb default '{}')`
- `org_members(org_id, user_id, role check in ('owner','admin','member'), status check in ('active','pending'), primary key(org_id,user_id))`
- `teams(id, org_id null, owner_user_id null, name, check ((org_id is null) <> (owner_user_id is null)))`
- `team_members(team_id, user_id, role check in ('admin','reviewer','member'), org_id null, primary key(team_id,user_id))`
- `registration_policies(scope check in ('platform','org'), scope_id text, allow_open bool, allowed_domains text[], require_approval bool, allow_invite bool, closed bool, primary key(scope, scope_id))`（平台级 `scope_id = 'platform'`）
- `invitations(id, scope, scope_id, email, role, token_hash, expires_at, accepted_at, created_by)`
- `refresh_tokens(id, user_id, token_hash, expires_at, revoked_at, user_agent)`
- `audit_log(id, actor_id, org_id null, action, target_type, target_id, detail jsonb)`

`002_git.sql`
- `workspaces(id, team_id, org_id null, name, repo_dir, default_branch default 'main', daily_report_time text default '09:00', daily_report_tz text default 'Asia/Shanghai', daily_report_enabled bool default true)`
- `merge_requests(id, workspace_id, org_id null, session_id null, author_id, title, description, branch, base_commit, head_commit, status check in ('open','approved','merged','rejected','conflict','closed'), reviewer_id null, skipped_review bool default false, conflict_files jsonb, merged_commit null, decided_at)`

`003_sessions.sql`
- `sessions(id, workspace_id, org_id null, owner_user_id, title, status check in ('running','waiting','idle','offline'), branch, base_commit, forked_from_session_id null, exec_location text, last_activity_at, snapshot_commit null)`（`id` 为 Hub 侧 id；另存 `local_session_id` 与 `server_id` 映射回所有者机器上的会话）
- `session_events(session_id, seq bigint, kind, payload jsonb, org_id null, primary key(session_id, seq))`
- `session_transcripts(session_id primary key, org_id null, format text, content text, updated_at)`（PI JSONL 全文快照，供 fork）
- `session_grants(session_id, user_id, granted_by, org_id null, primary key(session_id,user_id))`
- `notifications(id, user_id, org_id null, kind, payload jsonb, read_at)`
- `daily_reports(id, workspace_id, org_id null, report_date date, content jsonb, generated_by check in ('model','digest'), unique(workspace_id, report_date))`

`004_models.sql`
- `model_gateways(id, scope check in ('platform','org','user'), scope_id, name, format, base_url, api_key_enc, models jsonb, enabled bool)`
- `quotas(id, subject_type check in ('user','org','team'), subject_id, period check in ('day','month'), limit_tokens bigint, org_id null)`
- `usage_ledger(id, user_id, org_id null, gateway_id, model, input_tokens, output_tokens, source check in ('platform','org','byok'), at timestamptz default now())`

密钥加密：`api_key_enc` 用 AES-256-GCM，主密钥来自 `HUB_SECRET_KEY`（32 字节 base64）或首次启动生成在 `<hubDataDir>/secret.key`（0600）。私钥（JWT 签名）同理存 `<hubDataDir>/jwt.key`，公钥可通过 `GET /api/meta` 取得。

## 4. 账号、注册与令牌

- 密码：`node:crypto` scrypt（N=16384, r=8, p=1, 64 字节），存 `scrypt$N$r$p$salt$hash`。
- **首个账号引导**：Hub 首次启动且 `users` 为空时，生成一次性设置码打印到日志（中文，`[prometheus-hub]` 前缀）并写 `<hubDataDir>/setup-code.txt`。带正确设置码注册的第一个用户成为 `platform_role='operator'`，并自动创建默认企业（名称取 `HUB_ORG_NAME` 或「我的团队」）成为其 `owner`。
- **注册策略**（平台级与企业级）：
  - `closed`：拒绝自助注册，只能邀请或管理员创建。
  - `allow_open`：任何邮箱可注册。
  - `allowed_domains`：仅这些域名。
  - `require_approval`：注册后 `status='pending'`，管理员批准后 `active`。
  - `allow_invite`：持邀请链接注册直接 `active` 并加入邀请所指企业/团队。
  - 私有部署默认：平台策略 `allowed_domains=[]`、`allow_open=false`、`require_approval=true`、`allow_invite=true`，引导完成后提示管理员设置公司域名。
  - 注册加入哪个企业：私有部署只有默认企业，注册通过即加入默认企业为 `member`（企业级策略生效）。在线服务的多企业行为留给子项目 4。
- **令牌**：
  - 访问令牌：Ed25519 JWT，`iss = HUB_PUBLIC_URL || "prometheus-hub"`，`aud = "prometheus"`，`exp` 15 分钟，`sub=userId`，`name`，`org`（默认企业 id，可空）。
  - 刷新令牌：随机 32 字节，库中存 SHA-256，30 天，轮换（每次刷新作废旧的）。
  - 委托令牌（转发操作用，见 §6.5）：`acts_for=[ownerUserId]`，`exp` 5 分钟，只由 Hub 内部签发给成员插件转发通道使用。
- 限流：登录与注册每 IP 每分钟 10 次、每账号每分钟 5 次（内存计数，单实例）。

## 5. 团队工作区与 git

### 5.1 主副本

- 每个工作区一个 bare 仓库：`<hubDataDir>/repos/<workspaceId>.git`，创建时 `git init --bare -b main`，可选从已有远程地址导入（`git clone --bare <url>`，URL 由团队管理员提供；只允许 `https://` 与 `ssh://`/`git@`，拒绝 `file://` 与内网地址以防 SSRF）。
- 对外暴露 **git smart HTTP**：路由 `/plugins/team/git/<workspaceId>.git/*`（public 路由，自行鉴权），实现为调用 `git http-backend`（CGI）：
  - 设置 `GIT_PROJECT_ROOT=<hubDataDir>/repos`、`GIT_HTTP_EXPORT_ALL=1`、`PATH_INFO`、`REMOTE_USER`、`QUERY_STRING`、`REQUEST_METHOD`、`CONTENT_TYPE`，把请求体管道进去，解析 CGI 响应头后写回。
  - 鉴权：HTTP Basic，用户名任意，密码为访问令牌；或 `Authorization: Bearer`。团队成员可读；推送只允许推到 `refs/heads/session/<userId>/*` 与 `refs/prometheus/snapshots/<userId>/*`。**禁止直接推默认分支**：只有合并流程能更新默认分支。推送权限检查在调用 http-backend 前解析 `receive-pack` 请求体中的 ref 更新命令（pkt-line 格式）完成；不合规则返回 403。
- 分支与 ref 约定：
  - 会话分支：`session/<userId>/<hubSessionId>`
  - 会话快照：`refs/prometheus/snapshots/<userId>/<hubSessionId>`（每轮结束由成员插件推送，含未提交改动）

### 5.2 合并请求

- 创建：成员插件先把会话 worktree 的改动正式提交到会话分支并推送，然后 `POST /api/workspaces/:id/merge-requests {sessionId, title, description, branch, baseCommit, headCommit, skipReview?}`。
- 冲突检测：`git merge-tree --write-tree --name-only --messages <default> <head>`（要求 git ≥ 2.38；启动时检查版本，不满足则日志报错并禁用合并功能）。
  - 无冲突 → `open`（或直接合并，见跳过审核）。
  - 有冲突 → `conflict`，`conflict_files` 记录文件名，并标注哪些是二进制文件（`git diff --numstat` 中 `-\t-` 的条目）以及「最近一次修改它们的合并请求作者」，供 UI 显示「这个文件已被某某修改」。
- 审核：团队 `admin`/`reviewer` 可 `approve` / `reject`。`approve` 时再次 merge-tree；无冲突则用得到的 tree 生成合并提交（`git commit-tree <tree> -p <default> -p <head> -m ...`，作者为 MR 作者、提交者为审核人），`git update-ref refs/heads/<default> <new> <old>`（CAS，失败重试一次后转 `conflict`）。状态 `merged`，写审计日志，给作者与团队成员发通知。
- 跳过审核：创建时 `skipReview=true` 且作者在该团队是 `admin` 或 `reviewer` → 直接执行合并，`skipped_review=true`，审计日志 `mr.merge.skipReview`。
- 冲突解决：作者在本机 worktree 中 `git fetch` 后合并/变基默认分支（可让 Agent 帮忙），推送后 `POST /api/merge-requests/:id/refresh` 重新检测。二进制冲突由 UI 提供「保留我的 / 保留团队的」两个按钮，成员插件据此 `git checkout --ours/--theirs` 并提交。
- 差异查看：`GET /api/merge-requests/:id/diff` 返回 `git diff <base>...<head>` 的统一 diff（文本）与文件列表（含二进制标记）；`GET /api/workspaces/:id/files?ref=&path=` 返回某 ref 下的文件或目录列表（供旁观者浏览快照与审核人对比二进制文件的两个版本下载）。

## 6. 会话镜像、旁观、授权、fork

### 6.1 什么会话会被镜像

成员插件只镜像 **cwd 位于团队 worktree 根目录之下** 的会话（团队会话）。个人会话永不上传。

### 6.2 上传内容

- 会话开始：`POST /api/workspaces/:id/sessions {localSessionId, serverId, title, branch, baseCommit, forkedFrom?}` → Hub 会话 id。
- 事件：成员插件通过 `ctx.events.onSession` 拿到事件，**过滤并精简**后批量上传 `POST /api/sessions/:id/events {events:[{seq, kind, payload}]}`（每 500ms 或 50 条一批）。保留：`agent_start/end`、`message_end`（完整消息）、`tool_execution_start/end`（工具名、参数、结果文本截断到 20KB）、`session_info_changed`、权限请求出现/解决（自定义 kind `permission_request` / `permission_resolved`，只含工具名与摘要）。丢弃 `message_update` 等流式增量。
- 状态：`running`（agent_start 到 agent_end 之间）、`waiting`（有待处理的权限请求）、`idle`、`offline`（成员连接断开超过 60 秒由 Hub 标记）。
- 转写快照：每次 `agent_end` 后上传 PI JSONL 全文 `PUT /api/sessions/:id/transcript`（gzip+base64，上限 20MB，超出则只保留最近的事件并在 UI 提示无法 fork 完整历史）。
- 文件快照：每次 `agent_end` 后，用临时索引（`GIT_INDEX_FILE` 指向临时文件，`git add -A` 遵循 `.gitignore`，`git write-tree`，`git commit-tree -p HEAD`）生成快照提交，推送到快照 ref，再 `PATCH /api/sessions/:id {snapshotCommit}`。不触碰用户自己的暂存区。默认额外排除：`node_modules/`、`dist/`、`build/`、`target/`、`bin/`、`obj/`、`.venv/`、`__pycache__/`、`*.log`（写入临时的 `info/exclude` 等价规则：通过 `-c core.excludesFile=<临时文件>` 传入）。

### 6.3 旁观

- `GET /api/workspaces/:id/sessions`：列表（所有者、标题、状态、最后活动、分支）。
- `GET /api/sessions/:id/events?after=<seq>`：分页拉取；实时：成员客户端通过 Hub WebSocket 订阅（§8）。
- `GET /api/sessions/:id/files?path=`：读快照提交下的文件/目录。
- 权限：团队成员（任意角色）可旁观团队内全部会话。

### 6.4 授权

- `POST /api/sessions/:id/grants {userId}` / `DELETE /api/sessions/:id/grants/:userId`：仅所有者。写审计日志，通知被授权人。

### 6.5 被授权人操作（转发）

- 被授权人在 UI 中对他人的会话发消息、处理权限请求、中断：`POST /api/sessions/:id/actions {type: "prompt"|"respond"|"abort", text?, requestId?, response?}`。
- Hub 校验授权后，通过所有者成员插件的 Hub WebSocket 下发 `{type:"relay", relayId, sessionId(local), action, actor:{userId,name}}`；成员插件用 §9 的 `ctx.sessions.prompt/respond/abort` 执行，回 `{type:"relayResult", relayId, ok, error?}`。所有者离线 → 返回 `409 ownerOffline`。
- 转发的 prompt 在会话里以 `[来自 <name>]` 前缀标注，写审计日志。

### 6.6 fork

- `POST /api/sessions/:id/fork` → Hub 创建新会话记录（`forked_from_session_id`，所有者为 fork 者，状态 `idle`，`base_commit` = 原会话快照提交或分支头），返回 `{session, transcript, snapshotCommit, branch}`；通知原所有者「X fork 了你的会话 Y」。
- fork 者的成员插件：在本地团队仓库 `git fetch` 快照 ref，基于快照提交新建 worktree 与分支 `session/<forkerId>/<newId>`，用 §9 的 `ctx.sessions.importTranscript` 以该 worktree 为 cwd 导入转写，得到本地会话，回填 `localSessionId`。

## 7. 日报与看板

- **看板**：`GET /api/workspaces/:id/board` → 每位成员 `{user, role, sessions:[{id,title,status,lastActivityAt}], lastActivityAt}`，加上 `openMergeRequests` 与 `recentMerges`。
- **日报**：
  - Hub 内部调度器（`packages/hub/src/scheduler.ts`，每分钟检查一次）在各工作区配置的时间与时区生成「前一天」的日报。也可 `POST /api/workspaces/:id/reports/generate {date?}` 手动触发（团队管理员）。
  - 素材：前一天各会话的标题、首条消息、`message_end` 中助手消息的最后一段、工具调用计数、合并请求的创建/合并/拒绝、冲突。按成员分组。
  - 若 Hub 配置了可用的平台/企业模型网关，用它生成结构化总结（JSON：`overall:string[]`、`risks:string[]`、`members:[{userId, items:string[]}]`），`generated_by='model'`，用量记入 `usage_ledger`（user_id 记为系统用户 `system`）。否则生成规则化摘要，`generated_by='digest'`。
  - `GET /api/workspaces/:id/reports?date=`。

## 8. Hub HTTP / WebSocket API

所有 API 在 `/plugins/team/api/*`（插件 public 路由；Hub 自己鉴权）。JSON 统一信封：成功 `{ok:true, data}`，失败 `{ok:false, error:{code, message}}`，HTTP 状态码同步。所有输入用 TypeBox（仓库已有依赖 `typebox`）校验。

账号
- `GET /api/meta` → `{version, publicKey, needsSetup, registration:{open, domains, approval, invite}}`
- `POST /api/auth/register {email, password, displayName, setupCode?, inviteToken?}`
- `POST /api/auth/login {email, password}` → `{accessToken, refreshToken, user}`
- `POST /api/auth/refresh {refreshToken}`、`POST /api/auth/logout {refreshToken}`
- `GET /api/me` → `{user, orgs:[{id,name,role}], teams:[{id,name,role,orgId}]}`

后台（企业 owner/admin 管本企业；operator 管全部）
- `GET /api/admin/users?status=&q=`、`POST /api/admin/users/:id/approve`、`POST /api/admin/users/:id/disable`、`POST /api/admin/users/:id/enable`、`POST /api/admin/users {email, displayName, password}`（管理员创建）
- `GET|PUT /api/admin/registration`（平台策略，仅 operator）、`GET|PUT /api/orgs/:id/registration`
- `POST /api/invitations {scope, scopeId, email, role}` → `{link}`；`GET /api/invitations/:token`
- `GET /api/orgs`、`POST /api/orgs`（operator）、`GET /api/orgs/:id/members`、`PUT /api/orgs/:id/members/:userId {role}`、`DELETE ...`
- `GET /api/admin/audit?orgId=&actor=&action=&before=`
- `GET|POST|PUT|DELETE /api/admin/gateways`（scope platform/org）、`GET|PUT /api/admin/quotas`、`GET /api/admin/usage?groupBy=user|team|day&from=&to=`

团队与工作区
- `GET /api/teams`、`POST /api/teams {name, orgId?}`（orgId 为空 = 个人所有；私有部署 UI 默认传默认企业）
- `GET /api/teams/:id/members`、`POST /api/teams/:id/members {userId|email, role}`、`PUT /api/teams/:id/members/:userId {role}`、`DELETE ...`
- `GET /api/teams/:id/workspaces`、`POST /api/teams/:id/workspaces {name, importUrl?}`、`PATCH /api/workspaces/:id {name, dailyReportTime, dailyReportTz, dailyReportEnabled}`
- 会话、合并请求、日报、看板：见 §5、§6、§7。
- `GET /api/notifications?unread=1`、`POST /api/notifications/read {ids}`

模型代理
- `POST /plugins/team/llm/:format/*`：`format` ∈ `openai`（Chat Completions 与 Responses）、`anthropic`（Messages）、`gemini`。Bearer 访问令牌。Hub 选择该用户可用的网关（用户所属企业的网关优先，其次平台网关），检查配额（按 `quotas` 的 user/team/org 中最严者，按自然日或自然月累计 `usage_ledger`），转发请求（流式透传），从响应（含 SSE 的最后用量块）提取 token 用量记账。超额返回 429 `quotaExceeded`。
- `GET /api/models` → 当前用户可用的模型列表（供成员插件注册提供方）。

WebSocket
- `GET /plugins/team/ws?token=<accessToken>`（public 路由处理 upgrade；若插件路由无法处理 upgrade，在子项目 2 的 core 补充中加入「插件 WebSocket 路由」能力，见 §9）。
- 客户端 → Hub：`{type:"subscribe", topic:"workspace:<id>"|"session:<id>"|"user"}`、`{type:"relayResult",...}`、`{type:"ping"}`。
- Hub → 客户端：`{type:"event", topic, data}`（会话新事件、状态变化、合并请求变化、通知、日报生成），`{type:"relay",...}`。
- 成员插件保持一条长连接（指数退避重连，最多 30 秒），用于转发与在线状态。

## 9. 子项目 2 需要的 core 补充

- `PluginContext.sessions` 增加：
  - `prompt(sessionId, text, opts?: {actor?: string}): Promise<void>`
  - `respond(sessionId, requestId, response): Promise<void>`
  - `abort(sessionId): Promise<void>`
  - `exportTranscript(sessionId): Promise<{format: "pi-jsonl"; content: string} | undefined>`（非 PI 运行时返回 undefined）
  - `importTranscript(opts: {cwd: string; content: string; name?: string; owner?: string}): Promise<{sessionId: string}>`（写入新的 PI 会话文件并让 host 识别）
- `PluginContext.wsRoute(path, handler: (ws: WebSocket, req: IncomingMessage) => void, opts?: {auth?: "host"|"public"})`：在 `main.ts` 的 upgrade 处理中分发 `/plugins/<name><path>`。
- `GET /api/health` 返回中增加 `role: "server" | "hub"`（web 用来进入 Hub 模式）。

## 10. 团队插件

### 10.1 Hub 角色

- `createHub({dataDir: join(ctx.dataDir, "hub"), databaseUrl: env.HUB_DATABASE_URL, publicUrl: env.HUB_PUBLIC_URL, log})`。
- 用 `ctx.route(..., {auth:"public"})` 挂载 `GET|POST|PUT|PATCH|DELETE /api/*`、`/git/*`、`/llm/*`（由于插件路由是精确匹配，需要在子项目 2 core 补充中让 `route` 支持前缀匹配：路径以 `/*` 结尾表示前缀）。
- `ctx.wsRoute("/ws", ..., {auth:"public"})`。
- 启动方式：`PROMETHEUS_ROLE=hub PROMETHEUS_HOST=0.0.0.0 PROMETHEUS_TOKEN=<随机> node apps/server/src/main.ts`；在 `apps/server/package.json` 增加脚本 `hub`，并新增 `docs/team-hub.md`（中文）说明企业模式与小团队模式的部署（含 PostgreSQL 外部实例配置示例、反向代理与 TLS 建议）。小团队模式下 `PROMETHEUS_HOME` 默认指向 `~/.prometheus-hub`，与本人个人实例的数据目录分开。

### 10.2 成员角色

- 设置（`ctx.settings` / 插件自己的 `team.json`，0600）：`hubUrl`、`refreshToken`、`userId`、`teamRoot`（默认 `<workspaceRoot 或 home>/PrometheusTeams`）。
- RPC（`plugin.call` 的 `team` 插件方法）：
  - `status` → `{connected, hubUrl, user?}`
  - `login {hubUrl, email, password}`、`register {...}`、`logout`
  - `hub.request {method, path, body?}`：带当前访问令牌转发到 Hub `/plugins/team/api/*` 并返回信封（前端复用一套 API 客户端）。访问令牌过期自动刷新。
  - `workspace.checkout {workspaceId}`：在 `teamRoot/<team>/<workspace>/main` clone（若已存在则 fetch），并把该目录注册为 Prometheus 工作区（`workspace.add`）。
  - `session.start {workspaceId, title?}`：fetch、在 `.../sessions/<shortId>` 创建 worktree 与会话分支，注册 Hub 会话，用 `ctx.openSession`（或现有创建会话方式）以 worktree 为 cwd 创建本地会话，返回本地 sessionId。
  - `session.fork {hubSessionId}`：见 §6.6。
  - `session.submit {sessionId, title, description, skipReview?}`：提交、推送、创建合并请求。
  - `session.resolveBinary {mergeRequestId, path, keep: "mine"|"team"}`
- 转写、快照、事件上传、转发执行见 §6。
- 模型：若 Hub 提供模型（`GET /api/models` 非空），用 `ctx.extension` 注册一个名为 `team` 的 PI 提供方，baseUrl 指向 `<hubUrl>/plugins/team/llm/<format>`，key 为访问令牌（每次请求前确保未过期；若 PI 提供方 API 不支持动态 key，则用 `hooks.gatewayTraffic` 在请求发出前替换 Authorization 头）。

## 11. Web UI

### 11.1 两种挂载

- **Hub 模式**：web 启动时请求 `/api/health`，`role === "hub"` 则渲染 `HubApp`（不加载聊天界面）。API 客户端直接 `fetch('/plugins/team/api/...')`，令牌存 `sessionStorage`（刷新令牌存 `localStorage`，用户勾选「记住我」时）。
- **成员模式**：普通 Prometheus 界面中新增顶层视图 `"team"`（侧栏入口「团队」），API 客户端走 `pluginCall("team", "hub.request", ...)`。
- 共用：`apps/web/src/team/api.ts` 定义 `TeamApi` 接口与两种实现；页面组件只依赖接口。

### 11.2 页面

- 登录 / 注册（含设置码、邀请链接）、待审批提示。
- 团队首页：顶部「日报 | 看板」切换（默认：团队角色为 admin 的项目经理类用户默认日报，其余默认看板；用户切换后记在 `localStorage`）。
  - 日报：整体进展、风险、按成员分段，可选日期。
  - 看板：成员卡片（状态色块：运行中/等待确认/空闲/离线），右栏「待审核合并」「最近合并」。
- 会话旁观：只读转写（复用现有消息渲染组件，若耦合过重则写精简渲染：用户消息、助手消息 markdown、工具调用折叠块）、文件快照浏览、按钮：「Fork 到我这里」、所有者可见「授权…」、被授权人可见输入框与权限请求处理按钮。
- 合并请求：列表、详情（统一 diff 渲染、文件列表、二进制文件「下载两个版本」、对应会话链接）、审核人「通过 / 拒绝」、作者「刷新冲突检测」与二进制冲突的「保留我的 / 保留团队的」。
- 通知：顶栏铃铛 + 列表。
- 后台管理（仅 owner/admin/operator 可见）：用户（审批、禁用、创建）、注册策略、邀请、企业与成员、团队与成员角色、工作区（日报时间）、模型网关、配额、用量统计（按人/团队/日表格）、审计日志。
- 所有文案 `defineMessages({zh, en})`，与现有 i18n 机制一致。样式沿用 Tailwind 与现有组件风格。

## 12. 测试

- `packages/hub/test/`：全部用 PGlite 内存库。
  - 迁移幂等；RLS：A 企业用户看不到 B 企业的团队/工作区/会话（直接用 `tx({userId})` 查询验证）。
  - 注册策略各组合、设置码引导、审批、邀请；登录、刷新轮换、注销；限流。
  - 团队/成员/角色权限矩阵（谁能建工作区、授权、审核、跳过审核）。
  - git：创建工作区、http-backend 克隆与推送（用本机 `git` 对 Hub 路由做端到端：起一个仅含 Hub 路由的 `node:http` 测试服务器）、禁止推默认分支、合并无冲突/有冲突/二进制冲突/跳过审核/CAS 竞争。
  - 会话镜像：事件分页、状态迁移、fork 返回数据、授权与转发鉴权（转发通道用假的成员 WebSocket）。
  - 日报：digest 生成；model 路径用假网关（本地 HTTP 服务器回固定 JSON）。
  - 模型代理：配额累计与 429、用量从 OpenAI/Anthropic 响应（含 SSE）中提取。
- `plugins/team/test/`：成员角色对假 Hub（真 `createHub` + PGlite + 测试 HTTP 服务器）完成：登录、checkout、开始会话、快照推送不影响用户暂存区、提交合并请求、fork 导入。
- `apps/web/test/`：`TeamApi` 两种实现的请求构造；日报/看板默认视图选择逻辑。
- 把 `packages/hub/test/**/*.test.ts` 加进根 `vitest.config.ts` 的 include（`packages/*/test` 已覆盖则无需改）。

## 12.5 审阅后补充的决定（优先于前文冲突之处）

以下为实现者审阅后提出、由设计者决定的事项。与前文冲突时以本节为准。

1. **权限请求等 UI 请求**：§9 增加 `ctx.events.onUiRequest((sessionId, request: UIRequest) => void)` 与 `ctx.events.onUiResolved((sessionId, requestId) => void)`，转发全部 UI 请求类型（permission/select/confirm/input 等）。镜像时 kind 为 `ui_request` / `ui_resolved`，payload 含 `requestId`、`method`、摘要；有未解决的请求即会话状态 `waiting`。转发 `respond` 用原 `requestId`。
2. **子项目 1 是硬前置**：2A 可与子项目 1 剩余部分并行（`packages/hub` 不依赖 host），2D 必须在子项目 1 全部合入后开始。
3. **上游远程**：Hub 主副本是团队工作区的唯一真源。工作区可选配置 `upstream_url` 与 `upstream_token`（加密存储，仅 HTTPS）。配置后：每次合并成功后把默认分支推送到上游（失败记录并通知团队管理员，不回滚合并）；每 5 分钟拉取上游，若上游默认分支是 Hub 默认分支的快进则快进更新，若分叉则标记工作区 `upstream_diverged` 并通知管理员，不自动处理。`002_git.sql` 中 `workspaces` 增加 `upstream_url`、`upstream_token_enc`、`upstream_status`、`upstream_checked_at`。
4. **权限矩阵**：
   - operator：所有企业、团队的全部权限。
   - 企业 owner/admin：对本企业所有团队隐式拥有团队 admin 权限（含审核、跳过审核、旁观、管理成员、建工作区）。
   - 建团队：企业团队由企业 owner/admin 创建；个人团队（`org_id` 为空）由任何 active 用户创建，但企业设置 `allow_personal_teams`（私有部署默认 `false`，在线服务默认 `true`）为假时，私有部署不允许创建个人团队（私有部署以平台设置 `allow_personal_teams` 控制）。
   - 企业团队的成员必须是该企业的 active 成员。
   - 建工作区、改工作区设置、管理团队成员与角色：团队 admin。
   - 审核、跳过审核：团队 admin、reviewer。
   - 旁观、fork、开会话、提交合并请求：团队任意成员。
   - 授权：仅会话所有者。
   - 测试按此矩阵逐项覆盖。
5. **配额主体**：v1 只支持 `user` 与 `org` 两种配额主体，删除 `team`；用量统计 `groupBy` 支持 `user|org|day|model`。`quotas.subject_type` 的 check 改为 `('user','org')`。
6. **运行时**：团队会话固定使用 PI 运行时（`session.start` / fork 时指定），UI 在团队会话中隐藏切换运行时。团队模型提供方用 PI `ProviderConfig.apiKey` 的 `!command` 形式读取团队插件维护的令牌文件（插件负责在过期前刷新该文件，0600）；若扩展 API 支持函数式 key 则优先用函数。删除 §10.2 中 `gatewayTraffic` 的兜底方案。
7. **委托令牌**：子项目 2 不使用 `acts_for` 委托令牌（转发经成员插件自己发起到 Hub 的已认证 WebSocket 进入，进程内调用 `ctx.sessions.*`）。§4 中「委托令牌」一项删除；`acts_for` 留给子项目 3 的租户反向代理。成员插件必须校验转发消息来自其当前 Hub 连接（不接受其他来源），并在执行前再次确认该本地会话属于团队会话映射。
8. **团队会话的来源**：只有经 `session.start` 或 fork 创建、记录在插件映射表（`team.json` 的 `sessions`）中的本地会话才是团队会话并被镜像。`main` 克隆**不**注册为 Prometheus 工作区（仅作 fetch 与 worktree 的来源，放在 `.../<workspace>/.repo`）。映射表之外、cwd 位于团队目录下的会话不镜像。每个 worktree 目录注册为 Prometheus 工作区，名称为 `<团队>/<工作区>: <会话标题>`，以便侧栏分组。
9. **成员模式实时推送**：成员插件订阅 Hub WebSocket，并把事件转成 `ctx.stream.publish("hub:<topic>", data)`；前端 `TeamApi.subscribe(topic, cb)` 在成员模式用 `plugin.watch`，在 Hub 模式直接连 `/plugins/team/ws`。浏览器不持有长期令牌直连他人 Hub。
10. **分发与启动**：`plugins/team` 进入内置插件，但 `@prometheus/hub`（含 PGlite、postgres.js）只在 Hub 角色时动态 `import()`；成员角色不加载。`apps/server` 支持命令行参数 `--role hub`（等价 `PROMETHEUS_ROLE=hub`），Hub 角色默认端口 `7421`、默认数据目录 `~/.prometheus-hub`。成员插件提供 RPC `localHub.status/start/stop`：用 `process.execPath` 与当前 server 入口（`process.argv[1]`）以 `--role hub` 启动子进程（独立数据目录、独立随机 `PROMETHEUS_TOKEN`、绑定 `0.0.0.0` 需用户在 UI 中确认），用于小团队模式「我来当 Hub」。
11. **外部 PostgreSQL 权限**：应用角色名可配置 `HUB_DB_APP_ROLE`（默认 `prometheus_app`）。迁移尝试 `CREATE ROLE`（不存在时）与 `GRANT ... TO CURRENT_USER`；若因权限不足失败，启动报错并打印 DBA 需要预先执行的 SQL（`docs/team-hub.md` 同样给出），不静默关闭 RLS。

## 13. 开发拆分（供并行）

| 块 | 内容 | 依赖 | 文件所有权 |
|---|---|---|---|
| 2A | `packages/hub` 骨架：Db（PGlite/postgres）、迁移框架、`001_core.sql`、RLS、ids、加密、JWT 签发、账号/注册/邀请/审批/令牌、企业/团队/成员/角色、审计、HTTP 路由框架与信封、TypeBox 校验、`createHub` | 子项目 1 | `packages/hub/**`（除 2B/2C 的服务文件与迁移） |
| 2B | 工作区与 git：`002_git.sql`、bare 仓库、http-backend 与推送鉴权、合并请求与 merge-tree、diff/files API | 2A | `packages/hub/src/git/**`、`src/services/workspaces.ts`、`src/services/merge-requests.ts`、对应路由文件与测试 |
| 2C | 会话与协作：`003_sessions.sql`、`004_models.sql`、会话镜像/授权/转发/fork、通知、WebSocket、日报调度、看板、模型代理与配额 | 2A | `packages/hub/src/services/{sessions,notifications,reports,board,models}.ts`、`src/ws.ts`、`src/scheduler.ts`、`src/llm/**`、对应路由与测试 |
| 2D | core 补充（§9）+ `plugins/team`（两种角色） | 2A（API 形状），子项目 1 | `packages/core/**`、`packages/plugin-sdk/**`、`apps/server/**`、`plugins/team/**`、`plugins/builtin/**` |
| 2E | Web UI（§11） | 2A 的 API 形状 | `apps/web/**` |

路由注册：2A 提供 `Router` 与 `registerRoutes(router, services)` 的组合点，2B/2C 各自在 `src/routes/<area>.ts` 导出 `register<Area>Routes(router, deps)`，在 `src/hub.ts` 中由 2A 预留调用（2A 先放空实现的占位文件，2B/2C 覆盖）。
