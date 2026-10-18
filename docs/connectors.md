# Connectors 连接器插件设计

让 Agent 通过「连接器」安全地使用第三方服务（GitHub、Jira/Confluence、Bitbucket、Microsoft 365 的 Outlook/Teams/OneDrive、数据库等）。用户在 **设置 → 连接器** 中完成授权，Agent 通过少量通用工具调用已授权的服务。

## 1. 目标与非目标

目标
- 统一的「提供方（Provider）」抽象：声明认证方式 + 一组带读/写标记的操作（Operation）。
- 多种授权：OAuth2 授权码 + PKCE（本机回调）、OAuth2 设备码（无浏览器/远程服务器场景）、个人访问令牌/API Token/Basic、连接串。
- 凭据静态加密，永不进入模型上下文、日志与 RPC 返回值。
- 写操作默认受控：每个连接可设为「只读 / 写前确认 / 允许写」。
- 增加新服务只需新增一个 Provider 文件，不改工具与 UI。

非目标
- 不重新实现 MCP。已有 MCP 服务器的服务继续走 MCP；连接器面向「需要统一授权管理、无现成 MCP」的场景。
- 首版不做 Webhook/事件订阅。

## 2. 架构

```
Settings → 连接器 (ConnectorsView)
        │ plugin.call(connectors.*)
        ▼
plugins/connectors
  registry  ── Provider 目录（github / atlassian / bitbucket / microsoft / database）
  vault     ── AES-256-GCM 加密的连接记录（<dataDir>/vault.json + vault.key，均 0600）
  oauth     ── PKCE 授权码、设备码、refresh、并发安全的 token 刷新
  tools     ── connector_list / connector_describe / connector_call
  routes    ── GET /plugins/connectors/oauth/callback
```

### Agent 工具（刻意保持 3 个，避免撑爆上下文）
| 工具 | 作用 |
|---|---|
| `connector_list` | 列出已连接账户（id、provider、权限模式），不含任何凭据 |
| `connector_describe` | 查看某 provider 的操作清单与参数 schema |
| `connector_call` | `{ connection, operation, params }` 执行操作，结果截断到上限 |

提示词中仅注入一行「已连接：github(work), jira(acme)」，详细 schema 按需通过 describe 获取。

### 权限模型
每个 Operation 带 `access: "read" | "write"`。每个连接有 `policy`：
- `read-only`：写操作直接拒绝；
- `confirm`（默认）：写操作经 `ctx.ui.confirm` 向用户确认；无 UI（自动化无人值守）时拒绝；
- `allow`：直接执行。

数据库提供方额外对 SQL 做只读校验（read-only 策略下只允许单条 SELECT/WITH/EXPLAIN/SHOW/PRAGMA 读语句）。

### 凭据安全
- 凭据仅在 vault 中以密文存放；RPC `list` 返回脱敏视图（`hasSecret`、过期时间）。
- 主密钥为随机 32 字节文件，0600。这能防止备份/误提交泄露明文，但**不能**防御同机同用户的恶意进程；若需要更强保证应接入系统钥匙串（见 §6）。
- 发往第三方的 HTTP 只使用 https（数据库除外），并强制超时与响应大小上限。
- OAuth `state` 一次性、10 分钟过期；回调只在本机监听时可用。

### OAuth 策略
- 首选设备码（GitHub、Microsoft）：不需要回调地址，对 Web/Android/远程服务器都适用。
- 授权码 + PKCE（Atlassian、Bitbucket、Microsoft 可选）：回调到 `/plugins/connectors/oauth/callback`。
- Client ID/Secret 由用户在连接器设置里填写（各平台需要用户自行注册 OAuth 应用），不内置。

## 3. 数据模型

```ts
interface ConnectionRecord {
  id: string; provider: string; label: string;
  policy: "read-only" | "confirm" | "allow";
  config: Record<string, string>;        // 非机密：站点域名、workspace、host 等
  secret: string;                        // 密文(JSON)：token / refresh / client secret / 密码
  expiresAt?: number; createdAt: string;
}
```

## 4. 扩展新 Provider
实现 `ConnectorProvider`（`src/types.ts`），在 `src/providers/index.ts` 注册：声明 `auth`、`fields`、`operations`，并实现 `test()`。

## 5. 首版内置
- GitHub：仓库/Issue/PR/代码搜索/创建 Issue/评论
- Atlassian：Jira 搜索/查看/创建/评论/流转；Confluence 搜索/读页
- Bitbucket：仓库/PR/Issue 列表、PR 评论
- Microsoft 365：Outlook 邮件列表/读取/发送、日历、Teams 团队/频道/发消息、OneDrive 搜索
- Database：PostgreSQL（可选依赖 `pg`）、SQLite（`node:sqlite`），schema 查看与查询

## 6. 后续
系统钥匙串、webhook、MySQL/MSSQL、连接健康检查与到期提醒、按操作粒度的允许列表。
