# 内置浏览器（browser）

Agent 和用户共用的浏览器。浏览器跑在 Prometheus 服务端旁边（Chrome / Edge / Chromium，headless），画面推流到右侧面板的 `<canvas>`，用户的键鼠和输入法再发回去；Agent 通过 `browser_*` 工具读无障碍树、按 ref 操作。因为页面只是 DOM 里的一个画布，应用的菜单、弹窗、提示都能正常盖在上面，没有 Tauri 子 webview 的层级问题；Web、远程和手机客户端也能用；手机连电脑时网页按手机版显示并接收真实触摸，手机本机模式则把 Chromium 装进应用的 Linux 环境里运行（见 `docs/browser.md` 第 8 节）。

设计、协议和取舍见 [docs/browser.md](../../docs/browser.md)。

- 浏览数据独立：`<home>/plugin-data/browser/profile`，不碰你日常的浏览器
- 没有浏览器的机器可以在面板里一键下载 Chrome for Testing
- 工具：`browser_navigate`、`browser_tabs`、`browser_snapshot`、`browser_act`、`browser_keys`、`browser_screenshot`、`browser_wait`、`browser_eval`
- 用户随时可以「接管」，Agent 会等到「交还」后再继续

界面在 `apps/web/src/components/browser/`，通过 `plugin.call` 和 `ctx.stream`（`plugin.watch` / 二进制 `plugin.event` 帧）与插件通信。

```bash
npx vitest run plugins/browser/test
```
