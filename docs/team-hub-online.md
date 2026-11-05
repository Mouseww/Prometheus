# 团队 Hub 在线服务（公开模式）

相关文档：[团队 Hub](team-hub.md)（基础部署、环境变量、管理后台）、[租户运行时](team-hub-runtime.md)。设计背景见 `docs/superpowers/specs/2026-11-05-team-mode-sp4-online-service-design.md`。

在线服务是把 Hub 作为面向公众的服务运行：陌生人可以注册、建立企业、付费使用模型。它通过 `HUB_MODE=public` 启用。本文只讲与公开模式相关的部分，部署方式、数据目录与环境变量的通用说明见团队 Hub 文档。

## 与私有模式的区别

| 方面 | 私有模式（默认） | 公开模式（`HUB_MODE=public`） |
| --- | --- | --- |
| 自助注册 | 出厂默认关闭，运营方开放后即可注册 | 同样出厂默认关闭，开放后需验证邮箱 |
| 邮箱验证 | 不要求 | 自助注册必须验证 |
| 人机验证 | 无 | 设置 `HUB_TURNSTILE_SECRET` 后自助注册必须通过 |
| 一次性邮箱 | 无 | 内置一份常见临时邮箱列表，另可由运营方维护 |
| 限流 | 登录限流 | 另有注册与发信的限流 |
| 自助创建企业 | 不支持，只有运营方可以创建企业 | 已验证邮箱的账号可以（`allow_self_create_org`，默认开启） |
| 计费 | 默认关闭，`HUB_BILLING=on` 时开启 | 始终开启 |
| 用户自带模型（BYOK）的地址 | 允许 http 与内网地址、任意端口 | 只允许 https、端口 443 或白名单端口，禁止内网地址 |
| 个人团队 | 默认关闭（`allow_personal_teams`） | 同样默认关闭，需要运营方开启 |

请特别注意两项出厂默认值：**自助注册默认关闭**，**个人团队默认关闭**。运营方必须在管理后台手动开启，否则新用户只能通过邀请加入。

## 账号

### 注册与验证

1. 用户在注册页填写邮箱、密码、显示名，并完成人机验证（如已配置）。
2. 账号创建后处于待验证状态，系统发送验证邮件。链接形如 `<HUB_PUBLIC_URL>/verify-email?token=...`，24 小时内有效，只能使用一次。
3. 点击链接后邮箱被标记为已验证。如果注册策略要求审批，账号仍处于待审批状态，等待运营方或企业管理员批准；否则直接启用。
4. 未验证邮箱的账号登录时，只有密码正确后才会提示「请先验证邮箱」。密码错误时始终返回相同的错误，不会泄露账号是否存在。
5. 验证邮件可以重新发送（`POST /api/auth/resend-verification`）。

自助注册还必须通过注册策略：要么开启「开放注册」，要么邮箱域名在「允许的邮箱域名」中（见团队 Hub 文档的「注册策略」）。两者都不满足时，注册会以 `domainNotAllowed` 被拒绝。

通过邀请链接注册的账号不需要验证邮箱，也不需要审批，见下文「邀请注册的例外」。

### 找回密码

- `POST /api/auth/forgot-password` 发送重置邮件。链接形如 `<HUB_PUBLIC_URL>/reset-password?token=...`，1 小时内有效，只能使用一次。
- 为防止枚举账号，同一邮箱的发送次数超限时，邮件静默不发，接口的回复与正常情况相同。同一 IP 超限时返回 429。
- 重置成功后，该账号所有已签发的刷新令牌都会被吊销，所有设备都需要重新登录。

### 邮件

| 变量 | 说明 |
| --- | --- |
| `HUB_SMTP_URL` | SMTP 地址，如 `smtps://user:pass@smtp.example.com:465` |
| `HUB_MAIL_FROM` | 发件人，默认 `Prometheus <no-reply@localhost>`，生产中应改为你的域名 |

- 未配置 `HUB_SMTP_URL` 时，邮件内容（包括验证与重置链接）只写入日志，Hub 启动时会给出警告。这只适合开发环境。
- 邮件发送是异步的。发送失败只记录日志，不会导致注册或找回密码请求失败。

### 人机验证（Cloudflare Turnstile）

1. 在 Cloudflare 中创建 Turnstile 站点，取得站点密钥（site key）与服务端密钥（secret）。
2. `HUB_TURNSTILE_SECRET`：服务端密钥。设置后，自助注册请求必须带上 Turnstile 令牌，Hub 向 Cloudflare 的 siteverify 接口校验。校验不通过、校验服务返回错误或无法连接，都视为失败（fail closed）。
3. `HUB_TURNSTILE_SITE_KEY`：站点密钥，通过 `GET /api/meta` 下发给前端（字段 `turnstileSiteKey`）。
4. 以下情况不需要人机验证：首个账号（首次设置）、凭邀请注册、登录、找回密码。
5. `HUB_TURNSTILE_VERIFY_URL` 仅用于测试时替换校验地址。

### 限流与滥用防护

| 对象 | 限制 | 超出后 |
| --- | --- | --- |
| 注册，按 IP | 每小时 5 次 | 429 |
| 注册，按子网（IPv4 按 /24，IPv6 按 /48） | 每天 50 次 | 429 |
| 验证或重置邮件，按 IP | 每小时 10 次 | 429 |
| 验证或重置邮件，按邮箱 | 每小时 3 次 | 静默不发 |
| 验证链接接口，按 IP | 每分钟 20 次 | 429 |
| 登录，按 IP | 每分钟 10 次 | 429 |
| 登录，按账号 | 每分钟 5 次 | 429 |

注意：当前版本的 Hub 没有信任 `X-Forwarded-For`。经反向代理部署时，上表中「按 IP」的限制会被所有用户共享，详见团队 Hub 文档的「已知限制」。

### 一次性邮箱

- 内置一份常见临时邮箱域名列表。命中时自助注册返回 `disposableEmail`。
- 运营方可以在管理后台的「一次性邮箱域名」页面增删域名，也可以调用接口：`POST /api/admin/disposable-domains`（body 为 `{ "domain": "example.com" }`）与 `DELETE /api/admin/disposable-domains/:domain`。
- 匹配是按完整域名进行的，不包括子域名。若要屏蔽子域名，需要逐个添加。

### 邀请注册的例外

公开模式下，邀请注册有几处与自助注册不同的地方，运营方需要知道：

- 不做人机验证，也不做一次性邮箱检查。
- 账号直接启用，并视为邮箱已验证。
- 邀请与邮箱绑定，因此不会有「陌生人凭邀请注册」的情况。

这些例外是设计选择，但意味着：**只应向可信的人发放邀请**。

### 封禁与禁用

- **禁用 / 启用**：运营方或企业管理员可以在「用户」页面操作。禁用后账号不能登录，已有的令牌在下一次请求时被拒绝。
- **封禁**：仅运营方可以执行（`POST /api/admin/users/:id/ban`）。封禁会禁用账号，并立即停止该用户的租户实例。要解封，使用「启用」。

## 企业与团队

### 自助创建企业

- 条件：账号处于启用状态，邮箱已验证，并且运营方没有关闭「允许自助创建企业」（`allow_self_create_org`，默认开启）。
- 创建者自动成为企业的 `owner`。
- 管理员创建的账号不记录邮箱验证时间，因此不能自助创建企业。
- 接口：`POST /api/orgs`。

### 个人团队与转入企业

- 个人团队需要运营方在「平台设置」中开启「允许个人团队」（`allow_personal_teams`），默认关闭。
- 个人团队转入企业的流程与私有模式相同，见团队 Hub 文档的「企业与团队」。

## 计费

计费在公开模式下始终开启。私有模式下可以通过 `HUB_BILLING=on` 开启同样的机制。

### 积分

- 每个用户和每个企业都有一个积分钱包。
- 调用模型时，默认使用个人钱包。若要使用企业钱包付费，请求需带上 `X-Prometheus-Org: <企业 ID>` 头，且调用者必须是该企业的成员。
- **只有平台网关消耗积分**。成员自己的 BYOK 网关（使用自己的 API Key）不计费。
- 费用按模型单价计算，输入与输出分别定价，单价以每 100 万 token 为单位。单价查找顺序为：指定模型加指定网关、指定模型、通配符 `*`。未设置单价的模型不扣积分。
- 调用前按估算的最大输出做预检，余额不足时返回 402 `insufficientCredits`。

### 免费套餐

- 每个活跃用户与每个企业，每个自然月（UTC）自动获得免费套餐的积分，出厂为 10000 积分。
- 免费套餐不能下架、不能修改价格或周期，也不能删除。
- 免费套餐的 `features` 字段目前只保存，不强制执行。例如，其中写明的每日运行时长上限并不会生效。

### 套餐、充值与订阅

- 运营方可以创建套餐：名称、周期（`month` 或 `year`）、价格（分）、币种、每月积分、特性。
- 用户可以：
  - 订阅套餐（`POST /api/billing/checkout`，`kind` 为 `subscription`，指定 `planId`）；
  - 充值积分（`kind` 为 `topup`，指定 `credits`）。
- 充值的价格由 `topupCreditsPerCent` 决定。默认值为 10，即 1 分钱兑换 10 积分。
- 充值积分的有效期由 `topupExpiryDays` 决定，默认不过期。
- 计费设置接口：`GET` 与 `PUT /api/admin/billing/settings`，可设置 `topupCreditsPerCent`、`currency`、`topupExpiryDays`。
- 模型单价接口：`/api/admin/prices`，字段为 `model`（可用 `*` 表示默认）、可选的 `gatewayId`、`inputPrice`、`outputPrice`。

### 支付方式

目前有两种支付方式：

**线下支付（manual）**：默认可用。创建订单后状态为待支付，由运营方确认：

- 确认收款：`POST /api/admin/orders/:id/mark-paid`
- 退款记录：`POST /api/admin/orders/:id/mark-refunded`

**Stripe**：同时设置 `HUB_STRIPE_SECRET` 与 `HUB_STRIPE_WEBHOOK_SECRET` 后启用。使用 Stripe 托管的 Checkout 页面。

- 在 Stripe 控制台添加 webhook 端点：`<HUB_PUBLIC_URL>/plugins/team/billing/webhook/stripe`。
- 将该端点的签名密钥填入 `HUB_STRIPE_WEBHOOK_SECRET`。
- Hub 用原始请求体与 `Stripe-Signature` 头校验 webhook，校验失败的请求被拒绝。
- 结账时可以传入 `successUrl` 与 `cancelUrl`。
- `HUB_STRIPE_API_BASE` 仅用于测试或本地模拟。

仓库中的 `packages/hub/src/billing/providers/cn-adapters.ts` 尚未接入，目前只有线下支付与 Stripe 两种方式。

### 兑换码

- 运营方在管理后台创建兑换码（`POST /api/admin/redeem-codes`）。
- 用户在「个人设置」中兑换（`POST /api/billing/redeem`，可指定 `orgId` 把积分计入企业钱包）。
- 兑换接口有限速：每个用户每小时的兑换尝试次数有上限，超出后被拒绝。

### 相关用户接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/billing/plans` | 列出可购买的套餐 |
| `GET /api/billing/summary` | 查看余额与用量摘要，可用 `orgId` 指定企业 |
| `POST /api/billing/checkout` | 订阅套餐或充值 |
| `POST /api/billing/redeem` | 兑换码 |

## 用户自带模型（BYOK）

### 使用

- 用户可以在「个人设置」中添加自己的模型网关（`POST /api/me/gateways`），填写格式、Base URL、API Key 与模型列表。
- 与平台及企业网关相同，API Key 只写入、加密保存，接口只返回掩码。
- 选择网关的顺序：成员自己的 BYOK 网关优先，其次企业网关，最后平台网关。BYOK 网关不计费。

### 是否允许

- 平台设置项 `allow_byok` 默认允许。
- 企业可以关闭本企业成员的 BYOK：只要企业设置里显式为 `false`，本企业成员就不能使用 BYOK。
- 企业显式为 `true` 时，本企业成员可以使用，即使平台关闭。
- 企业未设置时，跟随平台设置。

### 地址限制（SSRF 防护）

实现位于 `packages/hub/src/net/safe-url.ts`。

公开模式：

- 只允许 `https://`。
- 端口只能是 443，或 `HUB_BYOK_ALLOWED_PORTS` 中列出的端口，如 `8443,9443`。
- URL 中不能带用户名或密码。
- 域名解析后的地址必须是公网地址。回环地址、内网地址、链路本地地址（包括云服务的元数据地址）与保留地址一律拒绝。
- 连接时使用已校验过的 IP，防止 DNS 重绑定。

私有模式：

- 允许 `http://` 与 `https://`，端口不限。
- 回环地址与内网地址允许，用于访问内网模型。链路本地与保留地址仍然拒绝。
- 设置 `HUB_BYOK_BLOCK_PRIVATE=1` 后，地址规则与公开模式相同。

## 运营清单

按顺序完成以下事项。

1. **域名与 HTTPS**：准备域名与证书，反向代理转发到 `127.0.0.1:7421`，并转发 WebSocket。见团队 Hub 文档的「反向代理与 HTTPS」。
2. **基础环境变量**：
   - `HUB_MODE=public`
   - `HUB_PUBLIC_URL=https://<你的域名>`
   - `HUB_DATABASE_URL`（推荐 PostgreSQL）
   - `HUB_SECRET_KEY`，或妥善保护自动生成的 `secret.key`
3. **邮件**：设置 `HUB_SMTP_URL` 与 `HUB_MAIL_FROM`。不要在生产环境依赖日志中的邮件内容。
4. **人机验证**：设置 `HUB_TURNSTILE_SECRET` 与 `HUB_TURNSTILE_SITE_KEY`。
5. **支付**：选择线下支付，或配置 Stripe 与 webhook。
6. **首次设置**：用启动日志中的设置码注册运营方账号。
7. **开放注册**：在管理后台的「注册策略」中开启「开放注册」，或填写允许的邮箱域名。是否需要审批默认开启，已验证的用户仍然要等待审批。按需要关闭。
8. **个人团队**：在「平台设置」中开启「允许个人团队」，默认关闭。
9. **自助创建企业**：「允许自助创建企业」默认开启，不需要时关闭。
10. **模型**：至少配置一个平台模型网关。若要收费，还要配置模型单价与套餐，并确认免费套餐的积分数。
11. **一次性邮箱**：检查内置列表，按需补充域名。
12. **租户运行时**：建议使用 docker 驱动，并启用 gVisor（`HUB_DOCKER_RUNTIME=runsc`）。见[租户运行时](team-hub-runtime.md)。
13. **备份**：定期备份数据库，以及 `repos/`、`secret.key` 与 `jwt.key`。见团队 Hub 文档的「备份」。

## 已知问题与注意事项

- 经反向代理部署时，按 IP 的限流会被所有用户共享。这是当前版本的已知问题，详见团队 Hub 文档。
- 邀请注册跳过人机验证与一次性邮箱检查，且视为邮箱已验证。只应向可信的人发放邀请。
- 免费套餐的 `features` 字段不会强制执行。
- `cn-adapters.ts` 尚未接入。
- 真实 PostgreSQL、Docker 与 Windows 沙箱运行时尚未在真实环境端到端验证，见团队 Hub 文档的「已知限制」。
