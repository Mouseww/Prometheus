# 运行与部署

> English: [docs/en/deployment.md](en/deployment.md)

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
| 桌面打包 | `pnpm --filter @prometheus/desktop build` | 生成安装包（内置服务端与 Node 运行时，用户无需安装 Node） |

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

多人共用一个服务（团队模式）的部署见 [团队 Hub](team-hub.md)，面向公众的在线服务（`HUB_MODE=public`）见 [团队 Hub 在线服务](team-hub-online.md)。

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

### 一键公网地址（Cloudflare 临时隧道）

不想配域名、反向代理和 DDNS 时，在「设置 → 网络访问」打开「一键公网地址」：服务端启动 `cloudflared tunnel`（Cloudflare 的免费 quick tunnel），获得随机的 `https://xxxx.trycloudflare.com`，转发到本机服务。

- **必须先设置登录密码**，否则无法开启；经隧道进来的请求按「代理请求」处理，需要密码，隧道域名只在开启期间自动加入白名单。
- 首次使用会下载 cloudflared 到数据目录的 `bin/`（已装在 `PATH` 里则直接用）。下载使用 `curl`，并读取 `HTTPS_PROXY` / `ALL_PROXY` 等环境变量，Windows 上还会读系统代理。
- 地址是临时的：关闭开关或重启服务后会变，开关不持久化；这是免费隧道，不保证稳定，不适合长期生产。
- 下载失败、启动退出或等不到地址时界面会提示是网络问题，网络（或代理的全局 / TUN 模式）恢复后再点开关重试。
- 同一页会为局域网地址和公网地址显示二维码，手机端连接页点「扫码」即可填入；安卓会申请相机权限（`CAMERA`）。普通网页扫码需要 HTTPS 页面。

### 内置 Node 运行时

桌面安装包**不再自带 Node 和 PI Agent**，体积更小。Node 是后端运行必需的，首次使用时在应用里一键安装（连接页点“本机”后出现安装向导，之后也可以在 设置 → 运行环境 里管理或卸载），来自官方发行版（固定 22.x 版本并校验 SHA-256，含 npm 与 npx）。**PI Agent 与 Claude Code、Codex 等并列，是可选的智能体引擎**：只要有任意一个能用，就不会要求安装 PI；一个都没有时，应用会让你从受支持的智能体里选一个安装，默认选中 PI（`@earendil-works/pi-*`，通过 npm 装进应用数据目录 `runtimes/pi-agent`，不碰系统环境），装好后自动重启后端。LanceDB（向量检索，约 320 MB）和 Claude Agent SDK（约 30 MB）同样不再放进安装包：服务端用 npm 把它们装进数据目录的 `packages/<名称>`（知识库页面和 Claude Code 的“安装”按钮会触发，`package.optionalInstall` RPC），启动器里的解析钩子让它们装好即用、无需重启；没装 LanceDB 时知识库仍能建库，只是不能向量检索（页面顶部有安装提示）。服务端包因此只有约 20 MB。没有 PI 时服务端照常启动，PI 专属功能（PI 扩展包、技能库、MCP 客户端、网关连通性测试）暂不可用，其余智能体不受影响。Node 的查找顺序：`PROMETHEUS_NODE` → 应用里装的 Node → `PATH` 与常见安装位置（Homebrew、nvm、volta、asdf、fnm；版本需 ≥ 22.19，太旧的会被忽略）。服务端包里的 `main.js` 只是一个启动器：发现 `PROMETHEUS_PI_DIR`（桌面端自动设置）下装有 PI Agent 就让服务端从那里导入，服务端本体是 `app.js`；清单见 `apps/desktop/src-tauri/runtimes.json`，PI 版本必须与工作区依赖一致（`apps/desktop/test/runtimesManifest.test.ts` 会检查）。自带运行环境的包不受影响：Android 与 macOS 10.15 的 Electron 版仍把 Node 和 PI Agent 打在包里（`SERVER_BUNDLE_PI=1` 也可强制）。发布时 macOS 同时构建 Apple Silicon（`macos-latest`）与 Intel（`macos-15-intel`）两个包；Intel 包没有 LanceDB 原生库，知识库向量检索不可用，其余功能不受影响。

### 安卓

安卓版与桌面版一样有两种方式：**连接服务器**（填写服务器地址与密码/令牌）和 **本机模式**（APK 内置 Node 与服务端，首次启动时解压到应用私有目录，数据留在手机上）。发布时由 CI 构建 arm64 的 APK 并上传到 Release。

本机模式的命令行工具：APK 内置 `node`、`npm`、`npx`、`git`、`bash`、`rg`（来自 Termux，版本固定在 `apps/desktop/scripts/android-termux.lock.json`，升级时运行 `node apps/desktop/scripts/android-runtime.ts --update-lock` 并提交）。安卓只允许执行原生库目录里的文件，所以这些程序都以 `lib*.so` 的名字放在 APK 里，启动时在应用目录建同名符号链接并加入 `PATH`。`npx` 是自带的精简版（系统没有 `/usr/bin/env`，原版无法启动包里的命令）。工作区默认放在 `/storage/emulated/0/Prometheus`，需要在系统设置里授予「所有文件访问」（首次启动会跳转）；未授权时回退到应用私有目录。应用会常驻一条前台服务通知，防止切到后台后本机服务被系统杀掉。限制：需要编译原生扩展的 npm 包装不了；Android 12+ 的「幽灵进程」限制可能杀掉子进程，可在开发者选项里关闭，或用 `adb shell device_config put activity_manager max_phantom_processes 2147483647`。

本机模式的限制：知识库的向量检索（LanceDB）在安卓上不可用；其余功能不受影响。未配置发布签名密钥时，CI 会用临时密钥签名，文件名带 `-unofficial`，不能覆盖安装正式签名的版本；配置 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 三个仓库 Secret 后即为正式签名。本地调试需要 JDK 17、Android SDK 与 NDK，执行 `pnpm --filter @prometheus/desktop tauri android init`，再依次运行 `bundle-server:android` 与 `android-runtime`（需 Linux），最后 `tauri android dev`。

