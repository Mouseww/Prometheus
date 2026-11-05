# 子项目 1：核心接口改造（设计）

日期：2026-11-05 · 分支：`feat/team-mode` · 上级文档：`2026-11-05-team-mode-architecture.md`

## 目标

在 Prometheus 核心加入少量通用接口，让团队插件与 Hub（子项目 2+）可以挂上来。**硬约束**：未配置任何新东西时（无 `policy.json`、无信任密钥、无 `PROMETHEUS_ROLE`），所有行为与现在逐字节一致；现有测试全部保持原状态。

## 非目标

- 不在核心引入用户表、组织、团队。
- 不按 owner 过滤会话列表（团队模式下一个 server 只属于一个人，靠 `serverOwner` 保证）。
- 不改 UI 的整体结构；只让设置页能显示「已被策略锁定」。

## 基线

`pnpm test` 在本分支起点：926 个测试中 3 个失败（`packages/core/test/host-cc.test.ts` 三个用例需本机 Claude Code）、5 个文件失败（含 `apps/server/test/network.e2e.test.ts`、`apps/web/test/{download,draftAgent,earlier}.test.ts`，本机 Node 22.17 低于要求的 22.19）。改动后不得新增失败。

---

## S1. 身份与可插拔认证

### 类型（`packages/protocol/src/index.ts`）

```ts
/** Who is calling, when a trusted issuer (the team Hub) vouched for them. Absent in personal use. */
export interface Identity { userId: string; name?: string; orgId?: string; /** Users this identity may act for (delegation from the Hub). */ actsFor?: string[] }
```

### JWT（`packages/core/src/identity/jwt.ts`，新文件）

- 只用 `node:crypto`，Ed25519（`alg: "EdDSA"`），不新增依赖。
- 导出：
  - `signJwt(claims: JwtClaims, privateKey: KeyObject | string): string`
  - `verifyJwt(token: string, opts: { publicKey: KeyObject | string; issuer?: string; audience?: string; now?: number; clockSkewSec?: number }): JwtClaims | undefined`（任何不合法一律返回 `undefined`，不抛）
  - `identityFromClaims(c: JwtClaims): Identity`
  - `generateKeyPair(): { publicKey: string; privateKey: string }`（PEM）
- `JwtClaims { sub: string; name?: string; org?: string; acts_for?: string[]; iss?: string; aud?: string; exp: number; iat: number; nbf?: number; jti?: string }`。`exp` 必填。
- 校验：header `alg` 必须是 `EdDSA`、`typ` 若存在必须 `JWT`；签名；`exp`、`nbf`（默认 60 秒容差）；配置了 `issuer`/`audience` 时必须相等。
- 从 `packages/core/src/index.ts` 导出（Hub 签发、server 校验共用）。

### AuthProvider（`apps/server/src/auth.ts`，新文件）

```ts
export interface AuthProvider { verify(secret: string): Identity | undefined }
export function hubTrustFromEnv(env: NodeJS.ProcessEnv): AuthProvider | undefined
```

- 环境变量：`PROMETHEUS_TRUST_KEY`（Ed25519 公钥 PEM 文本，或以 `@` 开头的文件路径）、`PROMETHEUS_TRUST_ISSUER`、`PROMETHEUS_TRUST_AUDIENCE`。未设置 `PROMETHEUS_TRUST_KEY` 时返回 `undefined`，一切照旧。
- `main.ts` 接入：
  - `Client` 增加 `identity?: Identity`。
  - `validCredential` 保持同步；原有令牌/密码校验失败后，若存在 provider 且 `access.mode !== "deny"`，再试 `provider.verify(secret)`，成功即视为通过并记录身份。实现上把它改为返回 `{ ok: boolean; identity?: Identity }` 的内部函数 `checkCredential`，`validCredential` 作为布尔包装保留。
  - WebSocket `{type:"auth", token}` 走同一函数，成功时写 `client.identity`。
  - HTTP：新增 `httpIdentity(req, kind): { ok: boolean; identity?: Identity }`，`httpAuthorized` 改为包装它。
- **单人 server 约束**：若策略 `serverOwner` 已设置（见 S4），凭 JWT 登录的身份必须满足 `userId === serverOwner` 或 `actsFor` 包含 `serverOwner`，否则拒绝（WS 以 `4003 unauthorized` 关闭，HTTP 401）。用令牌/密码/回环免认证进入的客户端视为机器主人本人，不受此限。

### 调用者透传

- `PrometheusHost.call(method, params, caller?: Caller)`，`export interface Caller { identity?: Identity }`（`packages/core/src/host.ts`）。现有调用点不传 `caller`，行为不变。
- `main.ts` RPC 分发处传 `{ identity: client.identity }`。
- 插件 RPC：`RpcHandler = (params, caller?: Caller) => unknown`，`plugin.call` 时透传。

## S2. 插件路由自带认证

- SDK：`route(method, path, handler, opts?: { auth?: "host" | "public" })`，默认 `"host"`（现状）。
- `RouteHandler = (req, res, ctx: { identity?: Identity }) => void | Promise<void>`；第三参数新增，旧插件忽略即可。
- `PluginRoute` 增加 `auth`。`main.ts` 先按 method+path 找路由，再决定是否认证：`public` 跳过认证；`host` 维持现有「面板票据或 `httpAuthorized`」逻辑，并把 `httpIdentity` 的身份传给 handler。
- 找不到路由时，未认证请求仍然返回 401（不泄露路由是否存在），已认证返回 404。

## S3. 会话所有者与权限请求定向

### 存储

- 新文件 `packages/core/src/agent/session-owners.ts`：`OwnerStore`，JSON 文件 `<dataDir>/sessions/owners.json`，`{ version: 1, owners: Record<sessionId, userId> }`。方法：`get(id)`、`set(id, userId)`、`delete(id)`。写入方式与 `PermissionStore` 一致（排队、临时文件 + rename）。
- 覆盖 PI 与非 PI 运行时（不依赖 `session-index`）。

### 写入时机

- `session.create`、`message.fork`（`forkMessage`）、`session.switchRuntime`：当 `caller.identity` 存在时，`owner = caller.identity.userId`；fork 与切换运行时，若调用者无身份，则继承原会话 owner。
- `session.delete` 时删除。

### 暴露

- `SessionSummary.owner?: string`、`SessionSnapshot.owner?: string`。

### 谁能「操作」会话

`canAct(identity: Identity | undefined, owner: string | undefined): boolean`（`packages/core/src/session-access.ts`，纯函数）：

- 会话无 owner → `true`（现状）。
- 调用者无身份（令牌/密码/回环进入，即机器主人）→ `true`。
- `identity.userId === owner` 或 `identity.actsFor?.includes(owner)` → `true`。
- 其余 → `false`。

### 权限请求只发给能操作的人

- `main.ts` 的 `uiRequest`：对 `method === "permission"` 的请求，从「广播给所有已认证客户端」改为「发给所有 `canAct(client.identity, owner)` 为真的已认证客户端」。会话无 owner 时与现状一致。
- `uiResolved` 同样只发给上述客户端。

### 写操作拦截

- 在 `host.call` 入口（有 `caller` 时）对以下方法检查 `canAct`，否则抛 `AppError("sessionForbidden")`：
  `chat.prompt`、`ui.respond`、`session.abort`、`session.delete`、`session.rename`、`session.switchRuntime`、`permission.set`、`message.fork` **不在列表内**（fork 是只读来源，新会话归 fork 者）。实现者按 `RpcMethods` 中实际存在的、带 `sessionId` 且会改变会话状态的方法补全列表，并在测试里枚举。
- 只读方法（订阅、获取快照、列表）不拦截：旁观是允许的。

## S4. 管理员策略锁定层

### 来源

- `<dataDir>/policy.json`，或环境变量 `PROMETHEUS_POLICY` 指向的文件（优先）。文件不存在 = 无策略。
- 由 `ConfigStore.load()` 一并读取；解析失败时**拒绝启动**（`console.error` 中文日志 + 抛错），避免静默失效。

### 形状（`packages/protocol/src/index.ts`）

```ts
export interface AdminPolicy {
	/** Only this user (or identities acting for them) may connect with a Hub token. */
	serverOwner?: string;
	/** Permission modes nobody may switch to (e.g. ["bypassPermissions", "auto"]). */
	forbiddenModes?: PermissionMode[];
	/** Forced default permission mode. */
	defaultPermission?: PermissionMode;
	/** "ask": reading outside the session's working folder needs the owner's confirmation. */
	readOutsideProject?: "allow" | "ask";
	/** When set, only these plugins load and only these can be installed or enabled. */
	pluginAllowlist?: string[];
	/** Gateways supplied by the administrator; when present, users cannot add, edit or delete gateways. */
	gateways?: GatewayConfig[];
	/** Free text shown to users explaining who manages this install. */
	managedBy?: string;
}
```

（`GatewayConfig` 用 `config.ts` 中现有的网关配置类型；如果它不在 protocol 中，就在 protocol 定义一个等价类型或从 core 引用，实现者择一并保持类型单一来源。）

### 生效与执行

- `ConfigStore.policy(): Readonly<AdminPolicy> | undefined`。
- `defaultPermission`：加载后覆盖配置值；`setDefaultPermission` 时若策略指定则抛 `AppError("policyLocked", { field: "defaultPermission" })`；若目标值在 `forbiddenModes` 中也抛。
- `forbiddenModes`：`PermissionGate.setMode` 拒绝（抛 `AppError("policyLocked", { field: "permissionMode" })`）；从 `PermissionStore` 恢复出的被禁模式降级为策略默认或 `"default"`；无人值守运行（`ACCESS_MODE` 映射）若映射到被禁模式，降级为 `"default"` 并在 run 日志中记录。
- `gateways`：存在时，`gateways()` 返回策略网关（与本地网关合并时策略优先、同 id 以策略为准）；`saveGateway` / `deleteGateway` 抛 `policyLocked`。
- `pluginAllowlist`：`bootstrap` 只加载名单内插件（内置插件同样受限）；`plugin.install` / `plugin.setEnabled(true)` 对名单外插件抛 `policyLocked`。
- `readOutsideProject`：见 S5。
- 客户端可见：`settings.get`（或现有返回设置的 RPC）结果中增加 `policy?: AdminPolicy`（去掉网关密钥，只保留 id/name/format/baseUrl），供 UI 禁用对应控件。UI 层只做最小改动：被锁定的设置项显示禁用状态与 `managedBy` 提示。

## S5. 按路径的读取确认

- `decide(mode, call, env)` 的 `env` 增加 `policy?: { readOutsideProject?: "allow" | "ask" }`。
- 当 `readOutsideProject === "ask"` 且模式不是 `bypassPermissions`/`auto`：
  - 读类工具（`read`、`grep`、`find`、`ls`）：取 `input.path`（无则视为 cwd）；不在 `isProjectPath` 内 → `ask`（plan 模式下也是 `ask`，不是 `block`）。注意 `isProjectPath` 会把 `.git` / `.pi` 判为非项目路径，读取策略应使用一个只判断「是否在 cwd 内」的新函数 `isInside(path, cwd)`，不要误伤 `.git`。
  - 只读 shell 命令（原本自动放行的那类）：若任一参数看起来是路径且不在 cwd 内（绝对路径、以 `~` 开头、含 `..` 段、Windows 盘符、`$HOME`/`%USERPROFILE%`），→ `ask`；否则维持放行。
  - 声明 `readOnly` 的「other」类工具（如 MCP）：不按路径判断（无法得知路径），维持现状。
  - 「始终允许」不记住项目外读取（读类工具本就没有 rule key，保持）。
- `PermissionGate` 增加 `policy` 字段，由 host 在 `attach` 时从 `ConfigStore.policy()` 填入；`evaluate` 传给 `decide`。
- 个人用户也可以开启：`PrometheusConfig` 增加可选 `readOutsideProject?: "allow" | "ask"`（默认 `"allow"`），策略存在时以策略为准。

## S6. Hub 角色

- 环境变量 `PROMETHEUS_ROLE=hub`。`packages/core` 导出 `serverRole(): "server" | "hub"`。
- Hub 角色下：
  - 拒绝创建或驱动 Agent 的 RPC（`session.create`、`chat.prompt`、`message.fork`、`session.switchRuntime` 以及终端/SSH 类插件的创建方法），抛 `AppError("agentDisabled")`。
  - 若未配置 `pluginAllowlist`，默认不加载 `terminal`、`ssh`、`computer-use`、`browser`、`workbench`、`folder` 插件。
  - 自动化与 flows 插件不加载（Hub 的定时任务由团队插件自己调度）。
- 未设置时行为不变。

## S7. 插件可用的会话事件与会话信息

- SDK `PluginContext` 增加：
  ```ts
  events: {
  	/** Every session event after it is emitted to clients. Listener errors are logged and swallowed. */
  	onSession(listener: (sessionId: string, event: SessionEvent, info: { owner?: string; cwd: string }) => void): () => void;
  	onSessionsChanged(listener: () => void): () => void;
  };
  sessions: {
  	info(sessionId: string): Promise<SessionSummary | undefined>;
  };
  ```
- 由 `PluginHost` 新增 `emitSession` / `emitSessionsChanged`，在 host 把事件交给 `HostListener` 的同一位置调用。监听器异常不得影响主流程。
- 插件卸载/重载时自动解除监听（走 `onDispose`）。

## 测试要求

每节一个测试文件或在已有测试文件中新增 `describe`，至少覆盖：

- S1：JWT 签发/校验往返；过期、`nbf`、签名错误、`alg` 非 EdDSA、issuer/audience 不符均返回 `undefined`；`hubTrustFromEnv` 未设置时返回 `undefined`；`serverOwner` 约束（在 `apps/server/test` 以纯函数方式测，或在 e2e 中测）。
- S2：`public` 路由无需认证；`host` 路由维持 401；未知路径未认证仍 401。
- S3：`canAct` 真值表；`OwnerStore` 持久化；create/fork 写 owner、fork 继承；非 owner 调用 `chat.prompt` 被拒；权限请求只发给能操作的客户端（`main.ts` 若难以单测，把过滤逻辑提成纯函数测试）。
- S4：策略加载与解析失败；各锁定项的拒绝路径；`pluginAllowlist` 过滤；被禁模式恢复降级。
- S5：`decide` 在 `ask` 策略下对项目内外读取、`.git` 内读取（应放行）、只读命令带外部路径的判定；未设置策略时与旧行为一致（对现有 `permissions.test.ts` 用例零影响）。
- S6：hub 角色下 `session.create` 抛 `agentDisabled`；默认插件排除。
- S7：插件能收到事件；监听器抛错不影响其他监听器与客户端。

## 留给实现者的判断

- `RpcMethods` 中需拦截的写方法的完整清单（按 S3 原则补全）。
- `GatewayConfig` 类型放置位置。
- UI 显示「已锁定」的具体样式（沿用现有设置页组件）。
