# 子项目 4：在线服务设计

日期：2026-11-05 · 分支：`feat/team-mode` · 依赖：子项目 1、2、3 · 上级文档：`2026-11-05-team-mode-architecture.md`

## 1. 目标

让运营方（项目作者）把 Hub 部署成面向外部的在线服务：

- 任何人可以注册成为**个人用户**（不属于任何企业），获得个人空间（服务端隔离容器）与免费模型额度；
- 个人用户可以**自建团队**并邀请他人；
- 可以创建**企业**，企业管理员管理成员、团队、模型、额度、注册策略；企业可以把个人团队转入企业名下；
- 计费：默认使用运营方模型，免费额度按周期重置，可**充值购买额度**或**订阅套餐**；企业整体购买额度池并分配；用户可**自带 base URL + Key**；
- 安全：公开注册防滥用、只允许容器隔离（推荐 gVisor）、自带模型地址防 SSRF。

## 2. 部署模式开关

- `HUB_MODE=private`（默认，子项目 2 行为）或 `HUB_MODE=public`。
- `public` 下：
  - 运行时驱动强制 `docker`（`sandbox`/`restricted` 不可用，启动时校验，不满足拒绝启动）；
  - 注册不自动加入任何企业；
  - 启用邮箱验证、防滥用、计费模块；
  - 后台管理出现「运营」分区（仅 operator）。

## 3. 账号与组织

### 3.1 个人用户

- 注册：邮箱 + 密码 + 显示名 + 人机验证（可选 Cloudflare Turnstile：`HUB_TURNSTILE_SECRET` 存在时启用，服务端校验 `https://challenges.cloudflare.com/turnstile/v0/siteverify`）。
- 邮箱验证：注册后 `status='pending'`、`email_verified_at=null`，发送验证邮件（链接含一次性令牌，24 小时有效，库中存哈希）。验证后 `active`。未验证账号只能登录到「请验证邮箱」页面。
- 邮件发送：接口 `Mailer { send(to, subject, html, text) }`。实现：SMTP（`HUB_SMTP_URL`，如 `smtps://user:pass@host:465`），用 `nodemailer@10.1.7`；未配置时使用 `LogMailer`（把邮件内容写日志，便于本地测试），并在后台显示警告。
- 平台注册策略（operator 在后台配置）：开放 / 关闭 / 仅邀请 / 域名白名单 / 需审批，组合同子项目 2。

### 3.2 企业

- 任何已验证的个人用户可以创建企业（operator 可在平台设置中关闭「自助创建企业」）；创建者为企业 `owner`。
- 企业设置：名称、slug、企业注册策略（新成员加入企业的方式：邀请 / 域名自动加入 / 申请审批）、企业模型网关、额度池分配、成员与角色、团队。
- 用户可属于多个企业；`GET /api/me` 返回全部，UI 顶部有「个人 / 企业 A / 企业 B」上下文切换器，切换决定新建团队的归属与模型计费主体。
- **团队转移**：个人团队的 owner（团队 admin 且 `teams.owner_user_id` 为本人）可以发起「转入企业」，企业 admin 接受后：`teams.org_id = 企业`、`owner_user_id = null`，团队下的工作区、会话、合并请求、日报等表的 `org_id` 同步更新（一个事务内，system 作用域），写审计日志。

### 3.3 角色与后台

| 角色 | 后台可见 |
|---|---|
| operator | 运营：全部用户与企业、平台注册策略、平台模型网关、套餐与价格、订单、兑换码、执行节点、全局用量、审计 |
| 企业 owner/admin | 企业：成员、团队、企业注册策略、企业网关、额度池分配、企业用量、企业账单、审计（本企业） |
| 团队 admin | 团队：成员与角色、工作区 |
| 个人 | 个人设置：个人模型（BYOK）、我的额度与账单、我的团队 |

## 4. 计费

### 4.1 概念

- **额度单位**：`credits`（整数，1 credit = 运营方定义的价值，例如 0.001 元）。每个模型在平台价目表中有 `input_price` / `output_price`（credits / 百万 token）。用量记账时计算 `cost_credits`。
- **钱包**：每个计费主体（个人用户或企业）一个钱包 `wallets(subject_type, subject_id, balance_credits, updated_at)`。
- **额度来源**（扣减顺序）：
  1. 周期免费额度（`free_grants`，每个周期开始时按套餐发放，周期结束清零）；
  2. 套餐周期额度（同上，随订阅发放）；
  3. 钱包余额（充值所得，不过期；或运营方设置有效期）。
- **BYOK**：请求走用户自己的网关时不扣 credits，`usage_ledger.source='byok'`，只记 token。

### 4.2 表（迁移 `006_billing.sql`）

- `plans(id, name, period check in ('month','year'), price_cents, currency, monthly_credits, features jsonb, active)`
- 内置免费套餐 `free`（`price_cents=0`），所有新个人用户与新企业默认拥有。
- `subscriptions(id, subject_type, subject_id, plan_id, status check in ('active','past_due','canceled'), current_period_start, current_period_end, provider, provider_ref)`
- `credit_grants(id, subject_type, subject_id, source check in ('free','plan','topup','redeem','admin'), amount, remaining, expires_at)`
- `orders(id, subject_type, subject_id, kind check in ('topup','subscription'), amount_cents, currency, credits, plan_id null, status check in ('pending','paid','failed','refunded','canceled'), provider, provider_ref, created_by)`
- `redeem_codes(id, code_hash, credits, max_uses, used_count, expires_at, created_by)`
- `model_prices(model, gateway_id null, input_price, output_price, currency_note)`
- `usage_ledger` 增加 `cost_credits bigint default 0`、`subject_type`、`subject_id`。

钱包余额 = 未过期 `credit_grants.remaining` 之和；扣减在一个事务内按「最早过期优先」消耗 `remaining`（`SELECT ... FOR UPDATE`）。

### 4.3 扣减与限额

- 模型代理在转发前做**预检**：主体可用 credits ≥ 预估（按 `max_tokens` 或默认 4k 输出估算）且未超过个人限额（企业为成员设置的周期上限）；否则 402 `insufficientCredits` / 429 `quotaExceeded`。
- 响应结束后按实际用量记账扣减；若实际超出余额，余额扣到 0 并记录 `overdraft`（下一次请求即被拒）。
- 企业额度池：企业钱包为主体；企业 admin 可为成员设置周期上限（复用子项目 2 的 `quotas` 表，主体为 user）。成员在企业上下文中发起的请求从企业钱包扣。

### 4.4 支付

- 接口 `PaymentProvider`（`packages/hub/src/billing/providers/provider.ts`）：
  ```ts
  export interface PaymentProvider {
  	readonly id: string;
  	createCheckout(order: Order, opts: { successUrl: string; cancelUrl: string; customerEmail: string }): Promise<{ redirectUrl: string; providerRef: string }>;
  	/** Verifies and parses a webhook; returns undefined when the signature is invalid. */
  	parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent | undefined;
  }
  export type PaymentEvent = { type: "paid" | "failed" | "refunded" | "subscriptionRenewed" | "subscriptionCanceled"; providerRef: string; amountCents?: number; periodEnd?: string };
  ```
- 实现：
  - `stripe`：直接调用 Stripe REST API（`https://api.stripe.com/v1/checkout/sessions`，表单编码，`Authorization: Bearer HUB_STRIPE_SECRET`），Webhook 用 `Stripe-Signature` 头的 HMAC-SHA256（`HUB_STRIPE_WEBHOOK_SECRET`）校验，容差 5 分钟。不引入 Stripe SDK。
  - `manual`：不在线支付。订单创建为 `pending`，operator 在后台确认收款后标记 `paid`（适合对公转账、企业采购）。
  - 兑换码：operator 批量生成，用户输入兑换。
  - 国内支付（支付宝、微信支付）：只定义适配器位置与配置项（`HUB_ALIPAY_*`），不在本版本实现；文档中说明接入方法。
- 路由：`POST /api/billing/checkout {kind, planId?, credits?}`、`POST /plugins/team/billing/webhook/:provider`（public，原始请求体）、`POST /api/billing/redeem {code}`、`GET /api/billing/summary`（余额、本周期用量、订阅、最近订单）、operator：`/api/admin/plans`、`/api/admin/orders`、`/api/admin/redeem-codes`、`/api/admin/prices`。
- Webhook 幂等：按 `provider_ref` + 事件类型去重；`paid` 时在事务内把订单置 `paid` 并写 `credit_grants` 或激活订阅。

### 4.5 周期发放

调度器每小时检查：对每个主体，若当前周期的免费/套餐 grant 不存在则发放（幂等键：`subject + source + period_start`）；过期 grant 的 `remaining` 不再计入。

## 5. 自带模型（BYOK）安全

- 用户在个人设置添加网关：`format`、`baseUrl`、`apiKey`、模型列表。Key 用 Hub 主密钥加密存储，返回时脱敏。
- **SSRF 防护**（`packages/hub/src/net/safe-url.ts`）：
  - 只允许 `https:`（`HUB_MODE=private` 下额外允许 `http:`，因为企业内网模型常见）；
  - 解析主机名得到全部 IP（`dns.lookup(all:true)`），任一为回环、私有（10/8、172.16/12、192.168/16、100.64/10、169.254/16、fc00::/7、fe80::/10、::1、0.0.0.0/8）则拒绝（`public` 模式）；
  - 发起请求时**固定使用校验过的 IP**（自定义 `lookup` 回调），防 DNS 重绑定；禁止重定向跟随到其他主机；
  - 端口限制在 443 与 `HUB_BYOK_ALLOWED_PORTS`。
- BYOK 请求同样经 Hub 模型代理转发（用户容器不直连外网时也能用），不扣 credits。

## 6. 防滥用

- 注册：每 IP 每小时 5 个、每 /24（IPv4）或 /48（IPv6）每天 50 个；一次性邮箱域名黑名单（内置小列表 + 可在后台追加）。
- 登录：子项目 2 的限流。
- 租户资源：`public` 下默认 `HUB_TENANT_CPU=0.5`、`HUB_TENANT_MEM_MB=1024`，免费套餐每日运行时长上限（`plans.features.max_runtime_minutes_per_day`，默认 120），超出后租户实例停止并提示升级。
- 出站网络：`HUB_TENANT_NETWORK` 推荐配置为仅允许访问 Hub 与公网（禁止访问运营方内网段），文档给出 Docker 网络与 iptables 示例。
- 运营方可在后台封禁用户（`disabled`）并立即停止其租户实例、作废刷新令牌。

## 7. Web UI

- 公共页：登录、注册（含 Turnstile 组件，配置时显示）、邮箱验证结果、忘记密码（发送重置链接，同样走 Mailer）。
- 上下文切换器（个人 / 企业）。
- 个人设置：资料、密码、我的模型（BYOK）、额度与账单（余额、本周期用量图、订阅、充值、兑换码、订单列表）。
- 企业后台：概览（成员数、本月用量、余额）、成员与邀请、团队（含待接受的团队转入）、注册策略、模型网关、额度分配、账单（充值/订阅/订单/manual 待确认）、审计。
- 运营后台：用户、企业、套餐、价目表、订单（含 manual 确认）、兑换码生成与导出、执行节点、平台网关、平台注册策略、全局用量、审计。
- 所有文案中英双语。

## 8. 测试

- 邮箱验证与重置令牌（生成、哈希、过期、一次性）；LogMailer。
- Turnstile 校验调用（假 HTTP）。
- 计费：grant 消耗顺序、并发扣减（两个事务同时扣，余额不为负）、周期发放幂等、预检拒绝、BYOK 不扣费、企业额度池与成员上限。
- 支付：Stripe 请求构造与 Webhook 签名校验（正确/错误/过期时间戳）、Webhook 幂等、manual 确认、兑换码（次数、过期）。
- SSRF：各私有段、IPv6、DNS 解析到私有 IP、重绑定（lookup 固定）、重定向拒绝。
- 团队转入企业：`org_id` 全量更新、RLS 下转入后对非企业成员不可见。
- `HUB_MODE=public` 启动校验（无 docker 拒绝启动）。

## 9. 开发拆分

| 块 | 内容 | 文件所有权 |
|---|---|---|
| 4A | 账号扩展：public 模式开关、邮箱验证、忘记密码、Mailer、Turnstile、防滥用、自助建企业、团队转入企业、上下文 | `packages/hub/src/services/{accounts-public,orgs-public,mailer}.ts`、`src/net/**`（除 safe-url） |
| 4B | 计费：`006_billing.sql`、钱包与 grant、价目、预检与扣减（接入模型代理）、周期发放、支付提供方（stripe/manual）、兑换码、Webhook | `packages/hub/src/billing/**`、`src/routes/billing.ts`、模型代理的计费钩子 |
| 4C | BYOK 与 SSRF：`safe-url.ts`、个人网关 CRUD、代理接入 | `packages/hub/src/net/safe-url.ts`、`src/services/byok.ts` |
| 4D | UI：§7 全部页面 | `apps/web/**` |
