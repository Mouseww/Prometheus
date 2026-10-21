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

安卓版与桌面版一样有两种方式：**连接服务器**（填写服务器地址与密码/令牌）和 **本机模式**（APK 内置 Node 与服务端，首次启动时解压到应用私有目录，数据留在手机上）。发布时由 CI 构建 arm64 的 APK 并上传到 Release。

本机模式的命令行工具：APK 内置 `node`、`npm`、`npx`、`git`、`bash`、`rg`（来自 Termux，版本固定在 `apps/desktop/scripts/android-termux.lock.json`，升级时运行 `node apps/desktop/scripts/android-runtime.ts --update-lock` 并提交）。安卓只允许执行原生库目录里的文件，所以这些程序都以 `lib*.so` 的名字放在 APK 里，启动时在应用目录建同名符号链接并加入 `PATH`。`npx` 是自带的精简版（系统没有 `/usr/bin/env`，原版无法启动包里的命令）。工作区默认放在 `/storage/emulated/0/Prometheus`，需要在系统设置里授予「所有文件访问」（首次启动会跳转）；未授权时回退到应用私有目录。应用会常驻一条前台服务通知，防止切到后台后本机服务被系统杀掉。限制：需要编译原生扩展的 npm 包装不了；Android 12+ 的「幽灵进程」限制可能杀掉子进程，可在开发者选项里关闭，或用 `adb shell device_config put activity_manager max_phantom_processes 2147483647`。

本机模式的限制：知识库的向量检索（LanceDB）在安卓上不可用；其余功能不受影响。未配置发布签名密钥时，CI 会用临时密钥签名，文件名带 `-unofficial`，不能覆盖安装正式签名的版本；配置 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 三个仓库 Secret 后即为正式签名。本地调试需要 JDK 17、Android SDK 与 NDK，执行 `pnpm --filter @prometheus/desktop tauri android init`，再依次运行 `bundle-server:android` 与 `android-runtime`（需 Linux），最后 `tauri android dev`。

