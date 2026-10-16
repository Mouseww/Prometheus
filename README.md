# Prometheus

基于 [PI Agent](https://github.com/earendil-works/pi) 的高性能、可二次开发的 Agent 框架：同一个运行时，TUI / 桌面 GUI / Web 三种使用方式，网关、知识库、插件全部可扩展。设计详见 [docs/architecture.md](docs/architecture.md)。

## 环境

- Node ≥ 22.19（推荐 24），pnpm 10
- 桌面版额外需要 Rust ≥ 1.77 与 [Tauri 2 依赖](https://tauri.app/start/prerequisites/)

```bash
pnpm install
```

## 运行

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| TUI 终端 | `pnpm tui` | PI 原生交互界面，自动加载网关与插件 |
| Web 服务 | `pnpm --filter @prometheus/web build && pnpm dev:server` | 访问 http://127.0.0.1:7420 |
| Web 开发 | `pnpm dev:server` + `pnpm dev:web` | Vite 热更新，代理到 7420 |
| 桌面 GUI | `pnpm dev:desktop` | Tauri 窗口，自动拉起本地服务端 |
| 桌面打包 | `pnpm --filter @prometheus/desktop build` | 生成安装包（内置服务端，需本机 Node） |

### 服务器部署

非回环地址监听必须设置令牌：

```bash
docker build -t prometheus .
docker run -p 7420:7420 -e PROMETHEUS_TOKEN=<至少16位随机串> \
  -v prometheus-data:/data -v $PWD:/workspace prometheus
```

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PROMETHEUS_HOST` | `127.0.0.1` | 监听地址 |
| `PROMETHEUS_PORT` | `7420` | 端口，`0` 为随机 |
| `PROMETHEUS_TOKEN` | — | 访问令牌，非本机监听时必填 |
| `PROMETHEUS_HOME` | `~/.prometheus` | 配置、知识库、插件数据目录 |
| `PROMETHEUS_CWD` | 当前目录 | Agent 工作目录 |
| `PROMETHEUS_ALLOWED_ORIGINS` | — | 额外允许的浏览器 Origin，逗号分隔 |

公网部署请置于 HTTPS 反向代理之后。

### 局域网与域名访问（桌面 / 本机模式）

默认只监听本机。在「设置 → 网络访问」里可以：

- 设置登录密码（至少 8 个字符），并开启「允许局域网访问」。**没有密码时无法开启。**
- 填写域名白名单（`agent.example.com` 或 `*.example.com`），之后可以用 nginx 等反向代理把域名转到「局域网端口」（默认 7421）。用 IP 访问不受域名白名单限制。

访问规则：

| 来源 | 是否需要密码 |
| --- | --- |
| 本机直接访问（本机端口，无代理） | 不需要 |
| 局域网 IP、域名、经反向代理转来的请求 | 需要，登录一次后保持 30 天 |

只有本机上的客户端能修改这些设置；通过局域网或域名登录的设备只能查看。修改密码或点「登出所有设备」会让已登录的设备全部失效。密码连续输错会被限速。若通过环境变量 `PROMETHEUS_HOST` 绑定了非回环地址部署，则沿用上面的令牌方式，这些设置不生效（桌面端内置服务只绑定本机并使用令牌，设置仍可修改）。

反向代理要保留 `Upgrade` 头并建议用 HTTPS，示例见设置页。若本机浏览器也经由同一反向代理访问，会被当作外部访问而要求密码。

### 安卓

安卓端为瘦客户端：`pnpm --filter @prometheus/desktop tauri android init` 后 `tauri android dev`，在连接页填写服务器地址与令牌。

## 目录

```
packages/protocol     线协议类型
packages/plugin-sdk   插件开发 SDK（definePlugin）
packages/gateway      AI 网关：OpenAI Chat/Responses、Anthropic、Gemini
packages/knowledge    知识库服务与 knowledge_search 工具
packages/core         运行时宿主（会话、插件、UI 桥）
plugins/*             内置插件：LanceDB 向量存储、MCP 管理、Skills 管理、记忆管理（builtin 聚合）
apps/server           HTTP + WebSocket 服务端
apps/web              React Web UI（桌面/安卓共用）
apps/desktop          Tauri 桌面壳
apps/cli              TUI 入口
```

## 写一个插件

```ts
import { definePlugin } from "@prometheus/plugin-sdk";

export default definePlugin({
	name: "hello",
	version: "0.1.0",
	setup(ctx) {
		ctx.extension((pi) => {
			pi.registerCommand("hello", { description: "打招呼", handler: async (_args, c) => c.ui.notify("你好", "info") });
		});
	},
});
```

放入 `~/.prometheus/plugins/` 或在配置中声明包名即可加载，详见架构文档 §11。

## 验证

```bash
pnpm typecheck
pnpm test
```
