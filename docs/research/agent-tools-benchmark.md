# AI 开发工具基准研究

研究日期：2026-07-23。

## 结论

Prometheus 不直接复制任一参考项目，而是组合五类经过验证的设计：

| 来源 | 借鉴点 | Prometheus 的处理 |
| --- | --- | --- |
| Grok Build | Rust 工具层、ACP、检查点、权限、长任务、MCP/Skills/Hook | 工具执行独立为 Execution Node；所有副作用进入可审计事件流 |
| LiveAgent | Tauri 2 + React、本地优先、Gateway/WebUI、断线序列补偿 | 保留本地执行优点；把跨端会话真相源提升为服务端 append-only log |
| Pi | provider 统一层、agent loop 与 UI 解耦、扩展机制、durable session | durable session 只持久化可序列化状态；运行时工具/provider 在恢复时按稳定 ID 重建 |
| Codex | CLI/IDE/Desktop/Web 多 surface、AGENTS/Skills/MCP/Automations、审批与沙箱 | 统一协议，不把任何单一 UI 当核心；权限决策属于执行节点和策略层 |
| Claude Code | terminal/IDE/desktop/browser/mobile 连续体验、session 管理、权限模式、远程控制 | 优先打造“换设备继续同一任务”，移动端定位为控制与审阅端 |

## 关键工程判断

### 1. 服务端不直接拥有所有本地权限

代码、SSH 私钥、Provider 密钥默认驻留 Execution Node。Control Plane 负责身份、任务、事件、调度和连接发现。这样既能实现 WebUI，又避免把开发机全部权限搬进中心服务器。

### 2. 会话是完整的 durable state

会话不仅是聊天记录，还包括任务状态、agent 拓扑、排队消息、工具调用边界、审批、产物引用和恢复标记。每个已接受的 mutation 必须先持久化，再向调用方确认。

### 3. 不恢复半截模型流

Provider 流本身不可可靠恢复。断线或进程崩溃后，从最后一个 durable boundary 恢复：未完成 provider request 标记 interrupted；非幂等工具绝不自动重试；幂等工具可由策略决定是否重试。

### 4. Web/移动端是完整控制面，不是文件系统宿主

移动系统不能安全、完整地提供桌面级 shell/filesystem。移动端负责查看、审批、交互、接续和远程控制；真正的代码执行发生在已连接的桌面、服务器或容器节点。

### 5. 协议优先于界面

Client、Control Plane、Execution Node 之间使用版本化事件协议。React/Tauri/WebUI 都消费同一协议，后续 CLI、IDE 插件或第三方客户端无需复制 agent runtime。

## Phase 2B 源码复核：工具运行时

本节不是根据产品宣传推断，而是基于 2026-07-23 各项目当前源码和官方文档确定下一实现切片。

| 项目 | 源码中的稳定模式 | 对 2B 的约束 |
| --- | --- | --- |
| Pi | `agent-loop.ts` 将 provider 响应、tool call 执行、tool result 回灌和下一轮 provider 请求组成独立循环；每个调用发出 `tool_execution_start/end`。工具以名称、描述、输入 schema 和 `execute` 组成。 | Provider adapter 只负责协议映射；Prometheus 的循环和 Tool Registry 必须独立，不能把文件系统逻辑写进 Provider。 |
| Codex | `tools/registry.rs`、`context.rs`、`lifecycle.rs` 和 `orchestrator.rs` 分别负责注册、调用上下文、生命周期与审批/沙箱。审批发生在 runtime 外层，不由单个工具自行弹窗。 | 2B1 先落只读 registry/lifecycle；写入和 Shell 在后续切片接入统一 Approval Orchestrator，避免每个工具重复权限逻辑。 |
| Grok Build | Agent 持有 `ToolBridge`，由 bridge 统一拥有 Tool Registry、Tool State 和 Session Context；权限模式是独立配置，工具定义使用稳定名称。 | durable event 只保存稳定 tool name/call id/arguments/result，不序列化函数对象；恢复时由 registry 重建。 |
| LiveAgent | conversation stream 使用会话级单调序列，事件 append 后冻结；run terminal 保证 exactly-once。 | `tool.call.started/completed` 必须写入现有 session sequence 并通过同一 WebSocket 重放，不能增加 UI 私有状态通道。 |
| Claude Code | 官方权限文档将工作区内 Read/Grep 列为默认无需审批的只读工具，Bash 与文件修改进入独立权限规则；Hooks 在每次工具调用前后触发。 | 第一切片只开放 `list_directory`、`read_file`、`search_text`；不把 Shell/Write 伪装为可用，后续再加入 Pre/Post Tool Hook 与审批。 |

### 2B1 选择

下一纵向切片是“真实只读工作区工具闭环”：模型收到三项工具 schema，返回 tool call，Tool Registry 校验并在工作区边界内执行，durable log 记录 start/completed，tool result 回灌模型，最终 assistant reply 再持久化。该切片不包含写文件、Shell、MCP 或 SubAgent。

### Phase 2B2 源码复核：审批与写入

2B2 继续只采用参考项目中已经稳定存在的边界：

- Codex 的 `tools/orchestrator.rs` 把审批放在 runtime 执行之前，并由 `tools/approvals.rs` 统一路由用户、hook 或自动 reviewer 的决定；具体工具不直接依赖 UI。
- Grok Build 的 `PermissionRule` 将 `Allow`、`Deny`、`Ask` 与 `ToolFilter` 分开，且缺省 action 是 `Deny`，避免配置遗漏形成隐式放行。
- Pi 的 `confirm-destructive.ts` 使用 before-event 在副作用之前等待 UI 决定，拒绝通过取消结果返回调用链。
- Claude Code 官方权限模型继续把 Read/Grep 与文件修改、Bash 分级；因此 Prometheus 先开放审批写文件，不在同一切片顺带开放 Shell。

Prometheus 的实现结论是：`AgentTool` 只声明 `approval` 和安全参数摘要，Agent Loop 只调用 provider-neutral authorization callback，Control Plane 的 `ApprovalCoordinator` 才拥有 pending resolver 与 durable approval events。任意同 session 客户端通过 `POST /api/sessions/{sessionId}/approvals/{approvalId}/resolution` 解决审批；拒绝作为 error tool result 回灌模型。当前 resolver 是进程内能力，服务重启恢复留给后续 scheduler，不伪装为已支持。

### Phase 2B3 源码复核：一次性 Shell

2B3 针对 Shell 再次核对参考实现，没有直接把“终端”理解为一个无边界的字符串执行器：

- Codex 的 `shell_command` 明确区分 command、workdir、timeout 与登录 shell；更复杂的 PTY/持续进程使用独立 `exec_command`/`write_stdin` 协议。命令执行仍经过 runtime 外层审批与 sandbox policy。
- Pi 的 bash tool 将 stdout/stderr 按到达顺序合并，支持 AbortSignal 和 timeout；超量输出只把尾部交给模型，并把完整输出放到独立文件。非零退出码、超时与取消都保留已产生的输出。
- Claude Code 将 Bash 默认列为需审批能力，规则按 deny、ask、allow 优先级求值，并把复合命令作为完整命令匹配，说明规则引擎不能靠简单首词判断伪装安全。
- Grok Build 的权限请求队列把 allow once、allow always、reject 与全局 always-approve 分开；批准 UI 和真实执行 resolver 解耦。

因此 Prometheus 2B3 只实现一次性、非交互 Shell：cwd 必须 canonicalize 到当前工作区真实目录；默认十秒、最长两分钟；合并输出并保留有限尾部；超时/取消终止进程；每次执行都通过现有跨端审批。PTY、后台 session、stdin 续写、sandbox escalation 和持久 command-prefix 规则不塞入本切片。尤其是在 Execution Node 尚未拆出、OS sandbox 尚未存在时，不把任何命令自动标记为“只读安全”。

### Phase 2B4 源码复核：持久权限规则

2B4 采用参考工具中共同且可验证的策略边界：

- Claude Code 的规则求值顺序固定为 deny、ask、allow，规则具体程度不会覆盖该优先级；因此 broad deny 不能被 narrow allow 绕过。
- Claude Code 对 Bash 复合命令逐子命令匹配。`safe-cmd *` 不会放行 `safe-cmd && other-cmd`，审批后保存的也是需要授权的独立子命令规则。
- Codex 将 exec policy 独立为 `Policy`/`Decision`/`RuleMatch`，审批 runtime 消费求值结果；规则不是 Shell handler 内的条件分支。
- Grok Build 把 allow once、allow always、reject 与全局模式作为权限响应层处理，具体工具只提供稳定调用信息。

Prometheus 因此把规则存储、求值和审批协调拆成三个模块。Shell 分隔符扫描识别引号之外的 `&&`、`||`、`;`、`|`、`|&`、`&` 和换行；只有所有非空子命令分别命中 allow 才自动执行。命令替换、反引号或未闭合引号不能可靠静态判定时回退 ask。`write_file` 使用规范化的 workspace-relative path 作为匹配目标。规则命中写入 `permission.rule.matched` durable event，保证多端看到同一审计事实。

### Phase 2C 源码复核：Provider streaming 与跨端草稿

2C 没有把 token delta 直接追加到 durable session log，而是采用成熟项目共同呈现出的“两层状态”边界：

- Pi 的 agent loop 将 partial assistant message 作为可更新的运行中状态；工具执行基于完整 assistant message，而不是基于尚未闭合的参数片段。
- Codex 的 Responses transport 分发流式 item/delta，但会话恢复以 completed response item 等持久边界为准，避免把每个 UI delta 当作可恢复事实。
- LiveAgent 的 conversation stream 使用单调 sequence 补偿 durable log，同时 active snapshot 是面向晚加入连接的当前状态，不占用日志 sequence。
- OpenAI 官方 Responses streaming 明确以 `stream: true` 返回语义事件，文本来自 `response.output_text.delta`，终态来自 `response.completed`。
- Anthropic SDK 的 `messages.stream()` 提供文本事件和 `finalMessage()`；Gemini SDK 的 `generateContentStream()` 提供逐 chunk 内容与最终聚合所需数据。两者都支持“delta 只展示、完成结构才驱动工具”的适配方式。

因此 Prometheus 将 SDK 差异收敛为 `text.delta | response.completed`，并把跨端 active draft 放入独立 `RunStreamHub`。每个 turn 从 revision 0 snapshot 开始，后续 delta 单调递增；最终 `message.agent` 只落库一次。Control Plane 重启会丢失 active snapshot，并中断当前 Provider request，这一限制被明确保留，不通过伪恢复或拼接半截文本掩盖。

### Phase 3A 源码复核：隔离上下文与有界并行团队

3A 依然只选取成熟项目已证明的最小共同边界：

- Pi 的 coding-agent subagent extension 把子任务放入隔离 context，明确支持 single、parallel 和 chain，并对 task 数与并发度设上限；并行模式保留每个 task 的独立输出和失败。
- LiveAgent 的 subagent 模块使用 parent-scoped roster 和 durable status，同时将 direct/shared/decision/question 消息作为单独通信层；这说明 roster 与 message bus 不应在一个切片中混成大模块。
- Codex 将 collaboration item 与 durable thread/agent status 分开，状态显式区分 pending、running、interrupted、completed、errored 和 shutdown，而不从 UI 卡片是否存在反推运行真相。
- Claude Code 官方 sub-agent 文档将 isolated context、parallel execution、resume 和 permission 视为独立能力；隔离 context 不等于自动获得更高权限。

Prometheus 3A 因此只交付可验收的手动团队：GUI 选择 1-8 个已配置 Agent，以 1-4 有界并发度执行；child 不读父会话历史；roster/status 持久化；多个 Provider stream 可跨端同时观察；单 task 失败不取消其他 task。模型自主 spawn、message bus、DAG、worktree 隔离和自动合并留在 3B/3C，不用“已有 SubAgent 类名称”冒充已实现。

### Phase 3B 源码复核：模型委派工具与 durable message bus

3B 实现前重新 shallow clone 并复核了当日源码：

- Pi `65ff8e7` 的 subagent extension 把 single/parallel/chain 做成模型工具，调用前严格校验模式互斥、Agent 发现结果、数量与并发上限，工具结果再回灌父 Agent。
- LiveAgent `a22bd6f` 的 Agent tool 将 roster 写入工具描述，明确“父上下文不自动复制”和“child 不能递归调用 Agent”。`SendMessage` 校验 `parent`/`*`/稳定 Agent id，并把 `direct/shared/decision/question` 作为独立 channel。
- LiveAgent 的 bus snapshot 是有界、按 sequence 排序的拉取式交付，优先展示 direct inbox、shared decisions 和 open questions，不用工作区文件充当消息队列。
- Codex `34b935e` 将 `spawn_agent`、`send_input`、status 和 agent communication telemetry 分层；spawn 有深度上限，send 显式指定 receiver，通信记录 send/receive 边界。

Prometheus 3B 不复制它们的 UI 或进程模型，只采用稳定边界：`delegate_team` 是 primary-only 动态工具；child 只有 send/read；Agent 收件人必须来自 durable roster；message 先入 SQLite 再入 session log；工具结果是父 Agent 继续推理的唯一返回通道。worktree/apply 仍单独留给 3C。

### Phase 3C 源码复核：worktree、patch 与冲突保留

3C 对照固定源码后，没有把“独立上下文”继续宣称为写隔离：

- LiveAgent `a22bd6f` 为 subagent 创建独立 branch/worktree，使用 binary patch，在 apply 前执行检查；冲突时保留 worktree，并在 cleanup 前校验其归属。它还包含 3-way 与文件复制 fallback，但这些更激进路径不适合作为 Prometheus 的无人值守默认值。
- Pi `65ff8e7` 在 patch 合并冲突时保留工作树，并把冲突块作为 Agent 可见结果，而不是静默覆盖目标文件。
- Grok Build `a5727c5` 将 worktree 生命周期与 session/recovery 分层，说明创建、恢复、审计和清理不应散落在团队调度器中。
- Codex `9e1f43d` 对 patch apply status 与 merge strategy 使用显式状态；Prometheus 因此把 `manual/auto` 和 `isolated/pending/applied/conflicted/rejected/discarded/no_changes` 放入协议与 SQLite，而不是从文件是否存在反推。
- Claude Code agent teams 默认共享目录，官方明确警告并行 Agent 编辑同一文件会互相覆盖；worktree 是独立的手动并行方式。因此 Prometheus 默认团队保持 readonly，只有显式 worktree + 非重叠路径所有权才开放写工具。

Prometheus 采用更保守的自动路径：只生成 staged binary patch，恢复 index 后执行 direct `git apply --check --binary`；通过才 apply。不会自动使用 `--3way`、文件复制 fallback、commit、merge 或 push。冲突、越界和 Provider 失败都保留 worktree；只有 applied、no_changes 或显式 discard 才清理。worktree 不是 OS sandbox，Shell 仍通过既有 approval/policy。

### 固定源码版本

- [Grok Build agent / permission sources](https://github.com/Mouseww/grok-build/tree/a5727c5960452e7527a154b25cb5bf00cda0545e/crates/codegen)
- [LiveAgent conversation stream](https://github.com/Stack-Cairn/LiveAgent/blob/61b7bccaeca79e667aff0369eff07295438b3696/crates/agent-gateway/internal/session/conversation_stream.go)
- [Pi agent loop](https://github.com/earendil-works/pi/blob/9b3a2059171bcc74ad9d2cadeea6d186776cf2db/packages/agent/src/agent-loop.ts)
- [Codex tool runtime](https://github.com/openai/codex/tree/4462b9deef211723b781b426f5e5d36a5777115f/codex-rs/core/src/tools)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [OpenAI Responses streaming](https://platform.openai.com/docs/guides/streaming-responses)
- [Anthropic TypeScript SDK streaming](https://github.com/anthropics/anthropic-sdk-typescript#streaming-responses)
- [Google Gen AI SDK](https://github.com/googleapis/js-genai)
- [Pi coding-agent subagent extension](https://github.com/earendil-works/pi/tree/65ff8e7f6db447dcddb1a9c8fd05f081c5cda76a/packages/coding-agent/examples/extensions/subagent)
- [LiveAgent subagent runtime](https://github.com/Stack-Cairn/LiveAgent/tree/a22bd6f49956b36417e6cbfce046a0803c58776a/crates/agent-gui/src/lib/subagents)
- [Codex multi-agent handlers](https://github.com/openai/codex/tree/34b935e3e57f5071917fae20471024fee4190c82/codex-rs/core/src/tools/handlers/multi_agents)
- [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents)
- [LiveAgent worktree implementation](https://github.com/Stack-Cairn/LiveAgent/tree/a22bd6f49956b36417e6cbfce046a0803c58776a)
- [Grok Build worktree baseline](https://github.com/Mouseww/grok-build/tree/a5727c5960452e7527a154b25cb5bf00cda0545e)
- [Codex patch baseline](https://github.com/openai/codex/tree/9e1f43d)
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)

## 参考资料

- [Grok Build](https://github.com/Mouseww/grok-build)
- [LiveAgent](https://github.com/Stack-Cairn/LiveAgent)
- [Pi](https://github.com/earendil-works/pi)
- [OpenAI Codex](https://github.com/openai/codex)
- [Claude Code Overview](https://code.claude.com/docs/en/overview)
