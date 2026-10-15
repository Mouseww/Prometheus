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
