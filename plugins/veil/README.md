# 隐私面罩（veil）插件

把 [veil](https://github.com/Mouseww/veil) 的隐私保护设计搬进 Prometheus：出网前把机密换成化名，回答回来再换回原文。不改 Prometheus 上游代码，全部通过插件扩展点实现。

## 两个独立开关

侧栏「隐私面罩」面板里分三页：**隐私保护**、**出口代理**、**规则**。

| 开关 | 作用 | 实现 |
|---|---|---|
| 隐私保护 | 请求正文里的密钥、手机号、连接串换成 `{{类型_ULID}}`；回复里的化名换回原文 | PI 扩展事件 `before_provider_request` |
| 区域中立化 | `Accept-Language` 换成指定值，并禁用压缩以免化名被压掉 | PI 扩展事件 `before_provider_headers` |
| 出口代理 | 请求从你指定的代理 IP 出去 | 本机转发端口 + 网关 baseUrl 重定向 |

## 隐私保护怎么工作

```
你输入：查一下 mysql://root:Pass123@10.1.2.3:3306/app，电话打 13800138000
模型收到：查一下 {{CONNSTR_01ARZ...}}，电话打 {{PHONE_01ARZ...}}
你看到：  查一下 mysql://root:Pass123@10.1.2.3:3306/app，电话打 13800138000
```

同一段机密永远对应同一个化名。映射表存在插件数据目录（`~/.prometheus/plugin-data/veil/mappings.json`，权限 0600），键是明文的 SHA-256 前缀，所以文件里读不出明文键。

脱敏失败时**直接拦截请求**，绝不把未脱敏的内容发出去。

## 出口代理怎么工作

开启后：

1. 插件在本机 `127.0.0.1:18787`（可改）起一个转发端口；
2. 记录每个已启用网关的真实上游地址；
3. 用 `pi.registerProvider(id, { baseUrl })` 把网关指向本机端口；
4. 转发端口按路由表找到真实上游，经你配置的代理出网，同时完成脱敏与还原。

支持 `http://`、`https://`、`socks5://`，可带用户名密码。隧道用 `node:net` 手写 CONNECT / SOCKS5 握手，**不依赖任何 npm 包**（插件只能引 Node 内置模块）。

关掉开关后立即恢复直连。

## 规则

出厂规则照搬 veil，分两包：

- **密钥包**：`PEM`、`APIKEY`、`TOKEN`、`CONNSTR`、`PASSWORD`、`IDCARD`、`PHONE`、`IP`、`EMAIL`（默认关）
- **区域包**：`TZ`（Asia/Shanghai 等）、`LOCALE`（zh-CN、zh-Hans）

优先级高的先匹配，先匹配到的占住位置——所以 `mysql://root:pw@10.0.0.5/db` 整个变成一条 `CONNSTR`，而不是再拆出一个 `IP`。

可以自己加词表规则（项目代号、内部人名）或正则规则。白名单里的词永远不替换（`127.0.0.1`、`localhost`、`0.0.0.0`、`::1` 默认在内）。

## 目录

```
src/
  engine/        规则引擎（移植自 veil-engine）
    rules.ts       有序不重叠匹配
    placeholder.ts {{TYPE_ULID}}
    store.ts       明文哈希为键的映射表
    walk.ts        只改 JSON 字符串值
    sliding.ts     流式还原（跨 chunk 拆分）
    ip.ts binary.ts
  proxy/
    transport.ts   HTTP CONNECT / SOCKS5 隧道
    relay.ts       转发 + 脱敏 + 还原 + SSE
  index.ts       插件主体
  panel.ts       面板页面
```

## 测试

```bash
npx vitest run plugins/veil/test
```

47 个用例覆盖规则优先级、脱敏还原往返、跨 chunk 占位符、SSE 流式还原、代理 URL 解析、转发与路由匹配。HTTP 与 SOCKS5 两条出网链路各有真实 socket 的端到端验证。
