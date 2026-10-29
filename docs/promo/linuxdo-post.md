<!--
发帖建议
- 分类：开发调优（自己的开源项目）；标签：开源、AI、Agent、自托管
- 配图按顺序上传 docs/promo/out/ 下的 PNG，替换正文里的 [图：xxx]
- 标题备选：
  1. 【开源】出门用手机接着电脑里的 Agent 干活，中途还能把 Claude Code 换成 Codex
  2. 【开源】Prometheus v0.16：一个会话，随时换 Agent，手机电脑无缝续上
  3. 自己写了个 AI Agent 工作台，PI / Claude Code / Codex / OpenCode 一个界面全管了
-->

# 【开源】出门用手机接着电脑里的 Agent 干活，中途还能把 Claude Code 换成 Codex

[图：hero-1920x1080.png]

佬友们好，分享一下自己一直在写的开源项目 **Prometheus**，一个可以自托管的 AI Agent 工作台。

起因很简单：我平时 Claude Code、Codex 换着用，经常遇到两件烦心事：

1. 任务在电脑上跑到一半，人要出门。回来之前什么都看不到，权限弹窗还卡在那等我点。
2. 一个 Agent 卡住了想换另一个试试，只能新开会话，把前面的来龙去脉再讲一遍。

所以干脆自己做了一个，把这两件事解决掉。

## 一个会话，随时换 Agent

[图：og-1200x630.png]

PI（默认内置）、Claude Code、Codex、OpenCode 共用同一套界面、工具和权限确认。对话进行到一半，在输入框下面切到另一个 Agent，会话原地继续，前面的记录会作为背景交给新 Agent，不会多出一个会话。

模型也是分开选的：选 Agent 自带登录的模型就走它自己的账号；选你在「AI 网关」里配的模型（OpenAI Chat / Responses、Anthropic、Gemini 协议都行，中转站直接填地址和 key），就经本机中继走网关。网关 key 只留在 Prometheus 里，不会交给命令行进程。

没装 Claude Code / Codex / OpenCode 也没关系，设置里一键安装。

## 出门了，手机接着干

[图：mobile-1080x1350.png]

TUI、桌面（Tauri）、Web、安卓用的是同一个服务端和协议，所以同一个会话在哪个设备上都能打开。

- 局域网直连，带登录密码和限速
- 没有域名也能用：设置 → 网络访问，一键开 Cloudflare 临时隧道，拿到一个 `https://xxx.trycloudflare.com` 地址
- 手机扫电脑上的二维码就能连上，审批、追问、看结果都在手机上完成
- 任务跑完有系统通知

## 先问，再做

[图：permission-1080x1350.png]

写文件、执行命令之前会把完整内容摆出来，点了允许才执行。嫌烦可以按命令「始终允许」。

另外有个**隐私面罩**（veil）：连接串、手机号、各种 key 在请求出网前换成化名，模型回答回来再换回去。脱敏失败就直接拦截，不会明文发出去。拿公司代码让 AI 改的时候心里踏实一点。

## 万物皆插件

[图：plugins-1080x1350.png]

网关、知识库、工具、命令、HTTP 路由、UI 面板都是通过 `definePlugin` 贡献的，内置功能本身也是插件，不想要的可以单独停用：

knowledge（向量知识库）· memory（长期记忆）· skills（兼容 SKILL.md）· mcp · connectors（GitHub / Jira / M365 / 数据库）· ssh · computer-use · subagents · 自动化 · git · voice · todos

想加功能可以直接让 AI 在应用里帮你写一个插件，确认后热加载，不用重启。

## 最近更新（v0.16）

- `/goal <目标>`：设定目标后 Agent 一轮接一轮自动推进，直到完成、受阻或用完轮数，中途可暂停 / 继续，四个 Agent 都能用
- 可以设置新会话的默认 Agent（比如默认就用 Claude Code）
- 切换会话秒开，长会话只加载最近几轮，弱网下手机明显流畅
- 文件上传 / 下载，侧边栏直接预览 Word、Excel、PPT、PDF

## 怎么用

```bash
git clone https://github.com/Mouseww/Prometheus.git
cd Prometheus
pnpm install
pnpm dev:desktop   # 桌面版；也可以 pnpm tui 或者起 Web 服务端
```

也有 Docker 和打好的安装包（Windows / macOS / Linux / 安卓），在 Releases 里下载。首次启动到「设置 → AI 网关」加一个模型端点就能开聊。

- GitHub：https://github.com/Mouseww/Prometheus
- 协议：AGPL-3.0

## 最后

项目还在快速迭代，坑肯定有。欢迎佬友们试用、提 issue、拍砖，有想要的功能直接在帖子里说，我会认真看。觉得有用的话给个 Star 就是对我最大的鼓励。

感谢 LINUX DO 社区，之前很多反馈都来自这里。
