# 多 Agent Runtime 设计（PI / Claude Code / Codex / OpenCode / ACP）

状态：设计稿，未实现。目标：同一个 Prometheus 会话界面、同一套插件和工具，可以选择由 PI、Claude Code 或 Codex 驱动，并且网关可以用 runtime 自带的，也可以用 Prometheus 的。

## 0. "无缝"的定义（验收标准）

在任意 runtime 下，下面这些都必须成立。做不到的，必须由能力声明显式降级（UI 置灰并给出原因），不能静默失效：

1. 现有 Web UI / TUI 的消息流、工具卡片、diff、bash 输出、todo 面板、子智能体面板不需要为某个 runtime 写特判。
2. Prometheus 的所有插件工具（记忆、知识库、todo、SSH、connectors、subagent、open_file、插件安装……）在三个 runtime 里都能调用，并且行为一致。
3. 每轮的上下文注入（记忆、知识库、模式、权限提示、技能索引）在三个 runtime 里都生效。
4. 权限只有一套：同一个 `decide()`、同一个审批弹窗、同一个"总是允许"规则集，不会重复弹窗，也不会漏拦。
5. 面罩（veil）的脱敏和出口代理，在 Prometheus 网关模式下对所有 runtime 都生效。
6. 会话可以列出、改名、恢复、中止、统计用量，自动化（无人值守）运行也能用。
7. 有一套一致性测试，用同一组场景跑三个 runtime，靠它保证上面几条，而不是靠人工点。

## 1. 现状：和 PI 的耦合点

| 位置 | 耦合方式 |
|---|---|
| `core/src/host.ts` | `createAgentSession` / `AgentSession`，直接用于 prompt、abort、compact、模型、thinking、fork、树导航、用量统计 |
| `core/src/events.ts` | 把 PI 的 `AgentSessionEvent` 转成线上的 `SessionEvent`；`ChatMessage` 本身就是 PI 的消息形状 |
| `core/src/permission-gate.ts` | 通过 PI 的 `tool_call` hook 拦截；`exit_plan_mode` 是一个 PI 工具 |
| `core/src/ui-bridge.ts` | 实现 PI 的 `ExtensionUIContext` |
| 插件 | 全部通过 `ctx.extension((pi) => …)` 接入 |

插件实际用到的 PI API 很少（统计自 `plugins/*`、`packages/*`）：

| API | 次数 | 使用方 | 在外部 runtime 下的去处 |
|---|---|---|---|
| `registerTool` | 22 | 几乎所有插件 | 工具总线（§4） |
| `on("before_agent_start")` 写 sections/guidelines | 7 | memory、knowledge、connectors、workbench、permissions、modes | 上下文提供者（§5） |
| `before_agent_start` 返回 `systemPrompt` | 1 | modes（replace/strict） | 整段替换 system prompt（§5.3） |
| `on("session_start" / "session_shutdown")` | 3 | modes、permissions、subagents | 会话生命周期钩子 |
| `on("tool_call")` | 1 | permissions | 统一权限（§6） |
| `getAllTools` / `getActiveTools` / `setActiveTools` | 4 | modes、permissions | 工具白名单（§4.5） |
| `registerMcpServer` | 1 | mcp | 经工具总线转出，或直接传给 runtime（§4.6） |
| `registerProvider` | 2 | 网关、veil | 网关中继（§7） |
| `on("before_provider_request" / "before_provider_headers")` | 2 | veil | 网关中继的请求钩子（§7） |
| `on("resources_discover")` | 1 | skills | 技能索引注入（§5.4） |
| `sendMessage(triggerTurn, followUp)` | 1 | subagents（后台完成通知） | `runtime.enqueue(followUp)` |
| `registerCommand` | 2 | — | 由 Prometheus 宿主解析 `/命令`（§8.3） |
| 工具上下文里的 `ctx.ui.*`、`ctx.cwd`、`hasUI` | — | — | 总线把同一个 UIBridge 交给工具（§4.2） |

结论：难点不在工具调用本身，而在 **上下文注入、权限、工具白名单、provider 钩子** 这四类。下面逐个给出方案。

## 2. 总体架构

```
              Web UI / TUI  (协议不变：SessionEvent + ChatMessage + UIRequest)
                                   │
                          PrometheusHost（会话索引、RPC）
                                   │  AgentRuntime 接口
          ┌────────────────────────┼─────────────────────────┐
     PiRuntime               ClaudeCodeRuntime              CodexRuntime
  (进程内 AgentSession)   (Claude Agent SDK, 子进程)    (codex app-server, JSON-RPC/stdio)
          │                        │                          │
          │        ┌───────────────┴──────────────┬───────────┘
          │        │  Prometheus 工具总线         │  网关中继（可选）
          │        │  MCP Streamable HTTP          │  127.0.0.1，veil 钩子，鉴权注入
          │        │  /mcp/<session>  (token)      │  格式转换（后期）
          │        └──────────────┬───────────────┘
          └── 共享：插件工具注册表、上下文提供者、PermissionGate、UIBridge、ConfigStore
```

原则：

- **线上协议不变。** 适配器负责把各 runtime 的事件转成现有的 `SessionEvent` / `ChatMessage`。这样前端零改动，pi 的行为就是金标准。
- **Prometheus 自己的能力只实现一次。** 工具、上下文、权限、UI 弹窗都放在 runtime 之外，各 runtime 只是接入。
- **每个 runtime 用它最原生、最完整的接口。** Claude Code 用 Agent SDK（流式输入、canUseTool、hooks、resume/fork、interrupt、setPermissionMode）。Codex 用 `codex app-server`（JSON-RPC：thread/turn、审批请求、中断、事件流；TS 类型由 `codex app-server generate-ts` 生成，并锁定版本）。现有的 `cli-runner.ts`（`-p`/`exec --json` 一次性模式）只保留给子智能体。

## 3. AgentRuntime 接口

```ts
// packages/protocol: 线上可见的部分
export type RuntimeKind = "pi" | "claude-code" | "codex";

export interface RuntimeCapabilities {
  steering: boolean;          // 回合中插话
  followUpQueue: boolean;
  compaction: "manual+auto" | "auto" | "none";
  fork: boolean;
  treeNavigation: boolean;    // 仅 pi
  thinkingLevels: ThinkingLevel[];
  images: boolean;
  liveToolListChange: boolean; // 会话中途增减工具
  systemPromptReplace: "live" | "restart" | "none";
  contextBreakdown: boolean;  // 精确的上下文分项
  permissionModes: PermissionMode[];
  nativeTools: CanonicalToolKind[];
}

// packages/core: 宿主侧
export interface AgentRuntime {
  readonly kind: RuntimeKind;
  probe(): Promise<RuntimeHealth>;               // 已安装？版本？已登录？
  listModels(gw: GatewayChoice): Promise<ModelInfo[]>;
  create(opts: SessionInit): Promise<RuntimeSession>;
  resume(ref: SessionRef, opts: SessionInit): Promise<RuntimeSession>;
}

export interface RuntimeSession {
  readonly id: string;            // Prometheus 会话 id
  readonly nativeId: string;      // runtime 自己的会话/线程 id
  readonly capabilities: RuntimeCapabilities;
  prompt(input: UserInput, delivery: "send" | "steer" | "followUp"): Promise<Disposition>;
  abort(): Promise<void>;
  compact?(instructions?: string): Promise<void>;
  fork?(atMessage?: string): Promise<SessionRef>;
  setModel(m: ModelRef): Promise<void>;
  setThinking(l: ThinkingLevel): Promise<void>;
  setPermissionMode(m: PermissionMode): Promise<void>;
  refreshTools(): Promise<void>;  // 插件热装或模式切换后调用
  messages(): ChatMessage[];      // 规范化后的对话记录
  usage(): SessionUsage;
  subscribe(fn: (e: SessionEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface SessionInit {
  cwd: string;
  gateway: GatewayChoice;         // { mode: "native" } | { mode: "prometheus", gatewayId, model }
  permission: PermissionGate;     // 共享的同一套
  ui: UIBridge;
  tools: ToolBusSession;          // 本会话的总线端点
  context: ContextComposer;       // 上下文提供者的合成器
  unattended?: RunAccess;
}
```

`PiRuntime` 是第一个实现，由 `host.ts` 现有逻辑原样搬过去（纯重构）。`host.ts` 只保留会话索引、RPC 分发、工作区。

### 3.1 会话存储

- **原生记录是恢复的唯一依据。** PI 的 session 文件、Claude Code 的 `~/.claude/projects/*.jsonl`、Codex 的 rollout 文件，由各 runtime 自己负责。
- Prometheus 新增 **会话索引** `<data>/sessions/index.json`，记录 `{ id, runtime, nativeId, cwd, name, model, gateway, createdAt, modified }`。会话列表、改名、归档都只读写这个索引，不依赖各 runtime 的列表能力。
- 另外维护一份 **规范化的镜像记录**（`ChatMessage[]` 的 jsonl），用于界面首屏、搜索和用量统计（`usage.stats` 现在直接解析 PI 的 session 文件，以后改为读镜像）。镜像只追加，与原生记录不一致时，以原生记录为准重建。
- 不支持切换已有会话的 runtime。后期可以提供"在另一个 runtime 中继续"：把记录摘要后开一个新会话。

## 4. 工具总线（核心）

### 4.1 形态

Prometheus 在本机开一个 **MCP Streamable HTTP** 服务（`127.0.0.1:随机端口`），每个会话一个端点 `/mcp/<sessionId>`，用一次性 bearer token 鉴权（通过环境变量交给子进程，不写入磁盘配置）。

为什么选 HTTP，而不是 Claude Agent SDK 的进程内 `createSdkMcpServer`：

- 两个外部 runtime 共用一份实现。
- 插件工具的参数本来就是 JSON Schema，可以直接透传；进程内方式要求 zod。
- 端点按会话区分，工具执行时天然拿到正确的 `cwd`、`sessionId`、`UIBridge`、`signal`。

接入方式：

- **Claude Code**：`mcpServers: { prometheus: { type: "http", url, headers: { Authorization } } }`，并设置 `strictMcpConfig`，避免和用户自己的同名配置冲突。
- **Codex**：thread 启动时传 `-c mcp_servers.prometheus.url=…`，并配 `bearer_token_env_var=PROMETHEUS_MCP_TOKEN`。

### 4.2 语义映射

| PI 工具语义 | MCP 映射 |
|---|---|
| `execute(id, params, signal, onUpdate, ctx)` | `tools/call`；`signal` 对应 MCP 取消通知；`onUpdate` 对应 `notifications/progress` |
| 返回 `content[]`（text/image） | MCP `content`（text/image） |
| 返回 `details`（UI 用的结构化数据，比如 todo） | MCP `structuredContent`，并且总线自己发 `tool_execution_*` 事件（见 4.3） |
| `ctx.ui.confirm/select/input` | 总线把该会话的 `UIBridge` 交给工具，弹窗走原有的 `ui.request` 通道 |
| `ctx.cwd` / `hasUI` | 从会话上下文取；`hasUI = !unattended` |
| `annotations.readOnlyHint` | MCP tool annotations，原样透传 |
| `promptSnippet` / `promptGuidelines` | 不进 MCP description，进静态上下文（§5），保证三个 runtime 的提示一致 |

### 4.3 事件权威性

同一次 Prometheus 工具调用，runtime 会报一遍（CC 的 `tool_use`，Codex 的 `mcp_tool_call` item），总线也知道一遍。规则如下：

- **总线是 Prometheus 工具的权威来源。** `args`、`partialResult`、`result`、`details`、`durationMs` 以总线为准。适配器按 `toolCallId` 关联，runtime 侧的同一调用只用来定位它在消息里的位置。关联方式：CC 的 `tool_use_id` 会出现在 MCP 请求的 `_meta` 里吗？这个需要 spike；如果没有，就用"会话内按顺序加参数哈希"匹配。
- **工具名规范化。** CC 会把工具显示为 `mcp__prometheus__memory_search`，Codex 是 `{server, tool}`。适配器统一还原成 `memory_search`。权限规则、模式白名单、UI 渲染器都只认规范名。

### 4.4 原生工具的规范化

外部 runtime 的内置工具（CC 的 Bash/Read/Edit/Write/Grep/Glob/WebFetch/WebSearch/TodoWrite/Task/ExitPlanMode，Codex 的 command_execution/file_change/web_search/plan 更新）由适配器映射到 **规范工具类型**，让现有的 diff、bash 输出、todo 渲染器直接复用：

```ts
type CanonicalToolKind = "exec" | "read" | "edit" | "write" | "search" | "fetch" | "todo" | "task" | "plan_exit" | "mcp" | "other";
// 例：CC Edit{file_path, old_string, new_string} → name "edit", args { path, edits:[{oldText,newText}] }
//     Codex file_change{changes} → name "edit"/"write"，args 由 unified diff 还原
//     Codex command_execution{command, aggregated_output, exit_code} → name "bash"
```

映射表放在 `packages/runtimes/<kind>/tool-map.ts`，用录制的真实事件做快照测试。

**重叠工具的取舍：用 runtime 原生的，把结果映射进 Prometheus 的面板。** 模型对自家工具训练得最好，原生的效果更稳。

- todo：CC 的 `TodoWrite`、Codex 的 plan 更新，转成 todo 面板状态。Prometheus 的 `todo_write` 在这两个 runtime 下不导出。
- 计划模式：CC 的 `ExitPlanMode` 转成现有的计划审批弹窗。Codex 没有对应工具，就导出 Prometheus 的 `exit_plan_mode`。
- 子智能体：CC 的 `Task` 默认禁用（`disallowedTools`），统一用 Prometheus 的 `subagent`，这样子智能体面板、多 runtime 子智能体、后台运行都保持一致。在设置里可以切换。
- `codemode`、`tool_search`、`pi_settings` 是 PI 专属，不导出。CC 有自己的工具搜索；Codex 下工具数量多时，靠总线的 `deferred` 暴露（§4.6）。

### 4.5 工具白名单（modes 插件、计划模式）

- 模式里写的工具名一律用 **规范名**。每个适配器提供 `toNative(canonical[]) → { allow, deny }`：
  - CC：`allowedTools` / `disallowedTools`；运行中切换时，如果 SDK 不支持热改，就在下一回合以 resume 重启 query（`liveToolListChange=false`）。
  - Codex：Prometheus 工具在总线侧过滤 `tools/list`。原生工具只能通过 sandbox 和功能开关粗粒度控制（比如只读 = `sandbox read-only`），能力矩阵会如实标注"原生工具只能粗粒度限制"。
- 插件热装或模式切换后，总线发 `notifications/tools/list_changed`。runtime 不支持的话（需要 spike），就在下一回合开始前重启连接或 thread（用 resume 保留上下文）。

### 4.6 用户配置的 MCP 服务器

默认 **经总线转出**：Prometheus 仍是 MCP 客户端，再把这些工具通过总线导出。这样 `codemode/deferred/direct/hidden` 四种暴露方式、权限规则、veil 在三个 runtime 下一致。

- `deferred` 在总线上实现为一个 `mcp_search` + `mcp_call` 工具对，不把全部工具塞进上下文。
- 每个服务器可以单独选择"直连"，把配置原样传给 runtime。代价是失去统一权限和脱敏，UI 会提示。

## 5. 上下文注入

### 5.1 统一的提供者契约

把 `before_agent_start` 拆成两类，因为它们在外部 runtime 里的落点不同：

```ts
ctx.context.provide(async ({ prompt, cwd, sessionId, runtime, messageType, permissionMode, signal }) => ({
  static?:  { sections?: Record<string,string>; guidelines?: string[] },  // 会话级，稳定，可缓存
  turn?:    string,                                                       // 本回合，随用户消息变化
}));
```

`ContextRequest` 的字段：

- `prompt`：本回合用户消息；不是用户触发的回合为空串。
- `cwd`、`sessionId?`、`runtime`：工作目录、会话 id、当前 runtime。
- `messageType?`：PI 的触发类型（`user`、`custom` 等）；其他 runtime 不设。
- `permissionMode?: PermissionMode`：调用方知道会话权限模式时传入。PI 桥接拿不到它（模式由 PermissionGate 持有，它自己在插件之后写 `unattended` / `auto_mode` / `plan_mode` 段落），所以 PI 下为 `undefined`；外部 runtime 的宿主应当传。`PluginHost.collectContext` / `collectContextExternal` 原样转给提供者。
- `signal?: AbortSignal`：提供者超时（默认 4 秒，`PluginHostOptions.contextTimeoutMs` 可改）时被中止，提供者应据此停止 I/O；超时后的返回值会被忽略，并输出 `[plugin:<name>] 上下文提供者超时`。

宿主并发启动所有提供者，再按插件顺序合并（同名段落后者覆盖）。提供者可以返回任意东西，宿主会容错：

- 段落名必须匹配 `/^[a-z][a-z0-9_-]*$/`，否则 PI 在构造 system prompt 时会抛错，导致该会话每次 prompt 都失败；不合法的名字会被丢弃并警告。
- 保留名不可用：`preamble`、`tools`、`rules`、`docs`、`addendum`、`project_context`、`skills`、`cwd`（PI 自带），以及 `turn_context`、`unattended`、`auto_mode`、`plan_mode`（Prometheus 自己写；权限闸门的段落优先）。
- 空串、非字符串的段落值，非数组的 `guidelines`，非对象的返回值一律忽略。

- `static` 进 system prompt，内容变了才更新。这样提示缓存不会每轮失效。
- `turn` 跟随用户消息注入，比如记忆命中、知识库命中、权限模式提示。

内置插件这样迁移（P2-c 已完成前四项）：memory 的命中项和索引**全部放 `turn`**（`memory_save` 会在会话中途改变二者，放 `static` 会让提示缓存失效或内容过期）；knowledge 的知识库清单放 `static.sections.knowledge`、connectors 的服务清单放 `static.sections.connectors`、workbench 的用法说明放 `static.guidelines`；技能索引放 `static`；权限、计划、自动、无人值守放 `turn`（模式会中途变化）。knowledge 原先在 `before_agent_start` 里返回 `systemPrompt`，会冻结整段提示、使之后的段落丢失，迁移后改为静态段落，属有意修复。memory、knowledge、connectors、workbench、todos、ssh、automations 的工具都已改用 `ctx.tools.register`。modes、veil、mcp、技能的 `resources_discover`、子代理 runtime、权限闸门仍是 PI 扩展，留待后续阶段。

**顺序约束**：PI 桥接的 `before_agent_start` 处理器必须排在所有旧式（`ctx.extension`）处理器之前（`PluginHost.dynamicExtension()` 和 TUI 的 `extensions` 都先注册它）。modes 的 replace/strict 会把 `event.systemPrompt`（即此前所有处理器累加的结果）冻结为整段替换；若桥接在它之后才写入段落，桥接写入的段落（包括放进 `turn_context` 的 memory）就会在这两种模式下消失。

### 5.2 各 runtime 落点

| | static | turn |
|---|---|---|
| PI | `systemPromptOptions.sections/guidelines`（现状） | 同左（PI 每轮重建 prompt） |
| Claude Code | `systemPrompt: { type: "preset", preset: "claude_code", append }` | `UserPromptSubmit` hook 返回 `additionalContext` |
| Codex | thread 启动时的 `developer_instructions` | 本回合输入前插入一段 `<prometheus_context>` 文本项 |

PI 的 `turn` 不是跟在用户消息后面，而是作为 system prompt 段落 `turn_context` 交付：PI 每轮把变化的段落转成一条 system patch，历史里会保留旧的 patch；CC 和 Codex 则把 `turn` 放在用户消息旁边（hook 的 `additionalContext` / 前置文本项）。

static 内容变化时：PI 下一轮自动生效；CC 和 Codex 在下一回合以 resume 重启（成本是一次缓存未命中，只在内容变化时发生）。

### 5.3 modes 的整段替换

modes 的 replace/strict 会返回完整的 `systemPrompt`。

- CC：`systemPrompt: string`，不用 preset，`systemPromptReplace = "restart"`。
- Codex：`base_instructions`，同样是 restart。
- 由于会丢掉 runtime 自带的工具使用说明，UI 会提示："在 Claude Code/Codex 下替换系统提示可能降低工具调用质量"。

### 5.4 项目说明与技能

- AGENTS.md / CLAUDE.md 由各 runtime 自己加载，Prometheus 不重复注入，否则内容会出现两遍。PI 下仍按现状处理。
- Prometheus 技能：注入"名称、描述、SKILL.md 路径"索引（和 PI 现在的格式一样），由模型按需读取。三个 runtime 都有读文件能力，所以行为一致。不往 `.claude/skills` 里写文件，避免污染用户目录。

## 6. 权限（只有一套）

`decide(mode, call, env)`、"总是允许"集合、`UIBridge.askPermission` 三者保持不变。各 runtime 只负责"把待决定的调用交给 gate，再把结论交回去"。

| | 原生工具 | Prometheus 工具（总线） |
|---|---|---|
| PI | `tool_call` hook（现状） | 同左 |
| Claude Code | `canUseTool(name, input)` → 规范化 → `decide` → 必要时弹窗；返回 allow/deny，拒绝原因原样回传 | CC 侧配置 `allowedTools: ["mcp__prometheus__*"]` 免询问，由总线在 `tools/call` 内做 `decide`；**保证只问一次** |
| Codex | app-server 的命令/补丁审批请求 → 规范化 → `decide` → 回复 approved/denied | Codex 对该 MCP server 免审批，由总线决定 |

模式映射：

| Prometheus | Claude Code | Codex |
|---|---|---|
| default | `default` + canUseTool | `workspace-write` + `approval_policy=untrusted`（尽可能多问） |
| acceptEdits | `acceptEdits` | `workspace-write` + `on-request`，补丁审批由 gate 自动通过 |
| plan | `plan` | `read-only` + 导出 `exit_plan_mode` |
| auto / bypassPermissions | `bypassPermissions` | `danger-full-access` + `never`（auto 仍保留自动选择的 UI 行为） |

- 运行中切换模式：CC 用 `setPermissionMode()`；Codex 在下一回合以新的 sandbox/approval 参数发起 turn（app-server 的 turn 级覆盖参数，需要 spike）。
- **已知差异，不掩盖：** Codex 在 `workspace-write` 下，工作区内的写操作不会发审批请求，所以 default 模式下"每次编辑都询问"做不到。能力矩阵和 UI 会标注："Codex：工作区内编辑由沙箱约束，不逐次询问"。
- 无人值守：CC 用 `canUseTool` 直接按 `ACCESS_MODE` 判定，不弹窗；Codex 用对应的 sandbox 加 `never`，总线侧照常判定。

## 7. 网关

每个会话选一种 `GatewayChoice`：

1. **runtime 原生**：使用 CLI 自己的登录和配置，Prometheus 不注入任何东西。veil 在此模式下不可用，UI 会明示。
2. **Prometheus 网关**：一律 **经本地网关中继**，不把网关地址和 key 直接交给子进程。

网关中继（从 veil 的 `VeilRelay` 抽出来，作为核心服务）：

- 监听 `127.0.0.1`，按会话签发一次性 token。子进程只拿到 `base_url=中继` 和这个 token。真实 key 由中继注入上游请求，不会进入子进程环境，也不会出现在 CLI 的日志或配置里。
- 把 veil 的 `before_provider_request/headers` 变成中继的请求钩子 `ctx.hooks.providerRequest`，三个 runtime 都能脱敏。PI 也可以改走中继，这样脱敏只剩一条路径。
- 顺便统一用量统计（按会话记录 token 和费用），出口代理也自然复用。

接入方式：

- CC：`env: { ANTHROPIC_BASE_URL: 中继, ANTHROPIC_AUTH_TOKEN: 会话token, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL }`。同时要防止用户 `~/.claude/settings.json` 里的 `env` 覆盖这些值（spike：SDK 的 `settingSources` 和 env 的优先级）。
- Codex：`-c model_provider=prometheus -c model_providers.prometheus.base_url=中继/v1 -c model_providers.prometheus.env_key=PROMETHEUS_GW_TOKEN -c model_providers.prometheus.wire_api="responses"`。

格式兼容：

| runtime | 可用的网关格式（第一版） | 后期 |
|---|---|---|
| Claude Code | `anthropic-messages` | 中继做 openai → anthropic 转换 |
| Codex | `openai-responses` | 中继做 chat/anthropic → responses 转换 |
| PI | 全部 | — |

不兼容的网关和模型在选择器里置灰，并说明原因。

## 8. 宿主层的其他细节

### 8.1 模型与 thinking

- 原生模式：CC 用 SDK 的 `supportedModels()`，Codex 用 app-server 的模型列表接口。
- Prometheus 网关模式：用网关配置的模型，按格式过滤。
- thinking 档位映射：CC 用 effort / thinking token 预算；Codex 用 `model_reasoning_effort`。不支持的档位不显示。

### 8.2 中止、插话、压缩、分叉、用量

| | Claude Code | Codex |
|---|---|---|
| 中止 | `query.interrupt()` | `turn/interrupt` |
| 插话 | 流式输入里追加用户消息 | 不支持就退化为 followUp 队列（spike） |
| 压缩 | 发送 `/compact`，或依赖自动压缩；结束后 `messages_reset` | 对应的 compact 接口（spike） |
| 分叉 | `resume + forkSession` | thread fork（spike） |
| 树导航 | 不支持 | 不支持 |
| 用量 | `result.usage` 和每条消息的 usage | `turn.completed.usage` / token 计数事件 |

### 8.3 斜杠命令

- `/xxx` 先由宿主匹配 Prometheus 命令（插件 `registerCommand`、prompt 模板、`skill:` 技能）。
- 没命中就原样交给 runtime，这样 CC 和 Codex 自己的命令（`/compact` 等）照常可用。
- `commands.list` 合并两个来源，并标注来源。

### 8.4 进程管理

- 每个会话一个子进程（CC SDK 进程或 Codex app-server）。空闲 N 分钟后回收，下次发消息时 resume，保持进程数可控。
- Windows：复用 `resolveExecutable` 的 `.cmd` 垫片解析；中止时用 `taskkill /T` 杀掉整棵进程树。
- `probe()` 检查：是否安装、版本是否在支持范围内、是否已登录（仅原生模式需要）。结果显示在 runtime 选择器上。

### 8.5 移动端（Android）

- **runtime 是服务端能力。** 新增 RPC `runtime.list` 返回后端的 `probe()` 结果（可用性、版本、登录状态、不可用原因）。客户端只按这份结果渲染选项，不写任何平台判断。
- **瘦客户端（连接服务器）：** runtime 运行在服务器上，手机只走现有的 WS 协议，三个 runtime 都可用，体验与桌面一致。外部 runtime 的子进程在服务端，空闲回收后发消息时 resume，所以手机断线重连、切到后台再回来，会话都还能继续。
- **本机模式（内置 Termux Node）：** 默认只提供 PI。Claude Code、Codex 的发布二进制面向 glibc/musl Linux，在 Android（bionic）上不保证能运行，原生登录也需要浏览器 OAuth，所以 `probe()` 报告为不可用，原因写“需连接服务器”。如果日后验证 Codex 的静态 musl 版本能在 Android 上跑，再放开，但仍只允许 Prometheus 网关模式。
- **资源：** 本机模式不启动 MCP 工具总线（PI 在进程内直接调用工具）。网关中继按需启动：只有 veil 开启或有外部 runtime 会话时才开。
- **界面：**
  - runtime 和网关选择放在新建会话面板里，不放在顶栏。会话进行中只显示一个小标记，比如 `CC`、`Codex`。
  - 审批弹窗、计划审批、能力降级提示都要适配窄屏：用底部抽屉，diff 和命令详情默认折叠。
  - 能力置灰用一行说明，点开看原因，不用 hover 提示（触屏没有 hover）。

## 9. 插件 API 的演进（保证老插件不坏）

1. **新增与 runtime 无关的 API**（plugin-sdk）：`ctx.tools.register`、`ctx.context.provide`、`ctx.commands.register`、`ctx.hooks.session`、`ctx.hooks.toolCall`、`ctx.hooks.providerRequest`。内置插件全部迁移过去，插件安装器的 GUIDE 改为推荐新 API。
2. **老的 `ctx.extension((pi) => …)` 继续支持：**
   - PI 下照旧，传入真实的 pi。
   - 外部 runtime 下，把同一个工厂函数跑在一个 **PiFacade** 上。它记录 `registerTool` / `on(...)` / `registerCommand` / `registerMcpServer` / `registerProvider`，再按 §1 的表转接到总线、上下文、中继。
   - 无法转接的调用（比如自定义 `registerProvider` 的流式实现、`setActiveTools` 之外的会话操作）记录为警告，插件页面显示"在 Claude Code 下部分不可用：xxx"。
   - `before_agent_start` 的 facade 版本拿到的是一个可变的 `systemPromptOptions` 草稿，写进去的 sections 和 guidelines 默认算作 `static`，所以老插件也能工作。

## 10. 一致性测试（"完美"靠它保证）

`packages/runtimes/conformance/`：同一组场景，对每个适配器都跑一遍，断言 **规范化后的事件序列、ChatMessage 形状、UI 请求** 和 PI 的金标准一致。不支持的能力必须由 `capabilities` 显式跳过。

- **确定性模型：** 写一个假的 LLM 服务（脚本化的 anthropic-messages / openai-responses SSE），挂在网关中继后面。三个 runtime 都走"Prometheus 网关模式"连它，不消耗真实 API，结果可复现。这也顺带验证了中继和 veil。
- **场景清单：**
  - 纯文本流
  - thinking
  - Prometheus 工具往返（memory_search、带 `ctx.ui.confirm` 的工具、带 progress 的工具、返回图片的工具）
  - 原生 bash：允许、拒绝、"总是允许"
  - 原生编辑的 diff 渲染
  - 计划模式：提交计划 → 批准 → 切到 acceptEdits
  - 中途中止（工具运行中、流式输出中）
  - 插话和 followUp
  - 插件热装后工具出现
  - 模式切换后白名单生效
  - 记忆的 static 和 turn 注入都出现在上游请求里（在假模型端断言）
  - veil 脱敏往返
  - 进程重启后 resume
  - fork
  - 压缩后 `messages_reset`
  - 图片输入
  - 无人值守运行
  - 上游错误和重试
  - 用量上报
- **录制回放：** 适配器的事件解析用真实 CLI 录制的事件流做快照测试，CI 上跑。
- **版本守护：** 声明支持的 CLI 版本范围；Codex 的 TS 绑定从锁定版本生成；夜间任务用最新 CLI 跑一致性测试，提前发现上游协议变化。

## 11. 能力矩阵（P0 spike 后修订）

图例：✅ 已验证可行；⚠️ 可行但有差异或需要变通；❌ 不支持；🧪 依赖实验性接口。

| 能力 | PI | Claude Code（Agent SDK 0.3.x / CLI 2.1.27x+） | Codex（app-server，0.133+） |
|---|---|---|---|
| Prometheus 工具 | ✅ | ✅ HTTP MCP + headers | ✅ HTTP MCP + `bearer_token_env_var` |
| 调用关联（总线 ↔ runtime） | ✅ | ✅ `_meta["claudecode/toolUseId"]` | ⚠️ 只有 `turn_id`/`thread_id`，按回合内顺序 + 参数关联 |
| 工具列表热更新 | ✅ | ✅ 响应 `tools/list_changed` | ⚠️ 不响应；回合间调用 `config/mcpServer/reload` |
| 每轮上下文注入 | ✅ | ✅ `UserPromptSubmit.additionalContext` | ✅ 输入前置文本项 |
| 静态上下文更新 | ✅ 每轮 | ⚠️ 需要 resume 重启，并且 `systemPrompt.snapshot:false` | ⚠️ `thread/resume` 时传新的 `developerInstructions` |
| 统一权限 / 逐次询问 | ✅ | ✅ 以 `PreToolUse` hook 为准（`canUseTool` 对自动放行的只读调用不触发） | ⚠️ 只有沙箱外或策略要求时才发审批请求；工作区内编辑不逐次询问 |
| 运行中切换权限模式 | ✅ | ✅ `setPermissionMode()` | ✅ `turn/start` 时覆盖 `approvalPolicy`/`sandboxPolicy` |
| 计划模式 | ✅ | ✅ 原生 ExitPlanMode | ✅ 导出 exit_plan_mode + read-only 沙箱 |
| 工具白名单 | ✅ | ⚠️ `tools`/`disallowedTools` 只能在启动时设，切换要 resume 重启 | ⚠️ 原生工具粗粒度；Prometheus 工具在总线侧过滤 |
| 插话 | ✅ | ✅ 流式输入（并入当前回合） | ✅ `turn/steer`（需要 `expectedTurnId`） |
| 中止 | ✅ | ✅ `interrupt()`，会话可以继续使用 | ✅ `turn/interrupt` |
| 手动压缩 | ✅ | ⚠️ 发送 `/compact`（待验证） | ✅ `thread/compact/start` |
| 分叉 / 树导航 | ✅ / ✅ | ✅ `resume + forkSession` / ❌ | ✅ `thread/fork` / ⚠️ `thread/rollback`（只能按回合数回退） |
| 切换模型 | ✅ | ✅ `setModel()` | ✅ `turn/start.model` |
| 模型列表 | ✅ | ✅ `supportedModels()` | ✅ `model/list`（⚠️ 默认模型不一定可用于 ChatGPT 登录） |
| 流式文本 / 思考 | ✅ | ✅ `includePartialMessages` → 原始 Messages 流事件 | ✅ `item/agentMessage/delta`、`item/reasoning/*` |
| diff 渲染 | ✅ | ✅ 由 Edit/Write 参数构造 | ✅ `fileChange.changes[].diff`（统一 diff） |
| todo 面板 | ✅ | ✅ TodoWrite 映射 | ✅ `turn/plan/updated` 映射 |
| 用量 | ✅ | ✅ `result.modelUsage`（累计）、`usage`（单回合） | ✅ `thread/tokenUsage/updated`（含上下文窗口） |
| veil（Prometheus 网关） | ✅ | ✅ 中继 | ✅ 中继 |
| veil（原生网关） | — | ❌ | ❌ |
| 任意格式网关 | ✅ | ⚠️ 仅 anthropic（后期转换） | ⚠️ 仅 responses（后期转换） |
| 上下文分项 | ✅ | ⚠️ 估算 | ⚠️ 估算（有总量和窗口） |
| Android 连接服务器 | ✅ | ✅ | ✅ |
| Android 本机模式 | ✅ | ❌ 需连接服务器 | ❌ 需连接服务器（静态 musl 待验证） |
| 协议稳定性 | — | 正式 SDK | 🧪 整个 app-server 标注为 experimental；只用稳定子集，锁定版本范围 |

## 12. P0 spike 结论（2026-08，Claude Agent SDK 0.3.310 / CLI 2.1.310 和 2.1.273；codex-cli 0.133.0）

都用模拟的模型服务（Anthropic Messages SSE 和 OpenAI Responses）验证，runtime 和 MCP 一侧是真实代码。

### 12.1 Claude Code
- **接入：** `query({ prompt: AsyncIterable<SDKUserMessage>, options })`，用流式输入模式。`pathToClaudeCodeExecutable` 指定用户安装的 CLI（2.1.273 可用），默认使用 SDK 自带的二进制（依赖 optional dependency）。
- **插话：** 回合中追加的用户消息会并进当前回合的下一个请求，不会新开回合，也会触发 `UserPromptSubmit`。
- **权限：** `canUseTool(name, input, { toolUseID, signal, mcpServer, ... })` 只在需要询问时才调用，只读命令会被自动放行。**所以统一权限放在 `PreToolUse` hook**（返回 `permissionDecision: allow|deny|ask` 和 `updatedInput`），`canUseTool` 只用来兜底。
- **MCP：** http 类型的 headers 每个请求都会带上；会响应 `tools/list_changed`，约 6ms 后重新列出工具；`tools/call._meta["claudecode/toolUseId"]` 就是 tool_use id，可以直接关联。`alwaysLoad: true` 可以避免工具被放到 ToolSearch 后面延迟加载。
- **system prompt：** preset `claude_code` 加 `append`。默认 `snapshot:true` 会把第一次的提示固化下来，resume 时传新的 append 不生效，**必须设置 `snapshot:false`**。
- **⚠️ 网关注入陷阱：** 用户 `~/.claude/settings.json` 里的 `env` 会**覆盖** SDK 的 `env` 选项。本机实测：用户设置里的代理地址覆盖了我们注入的 `ANTHROPIC_BASE_URL`。对策：Prometheus 网关模式下使用 `settingSources: ["project", "local"]`，不加载 user 层，并在 `probe` 时校验 init 消息里的实际出口。`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` 也有效，但这是未公开的内部开关，只作备选。原生网关模式照常加载全部设置。
- **`env` 选项会整体替换子进程环境**，需要显式合并 `process.env`。
- **工具集：** 子智能体工具现在叫 `Agent`（`Task` 是旧名），两个都要禁用；默认工具还有 CronCreate、Workflow、ScheduleWakeup、Monitor 等，用显式的 `tools: [...]` 白名单控制。`strictMcpConfig: true` 生效。
- **会话：** 记录存放在 `~/.claude/projects/<cwd 规范化>/<id>.jsonl`（会跟随 `CLAUDE_CONFIG_DIR`）；SDK 提供 `listSessions/getSessionMessages/forkSession/deleteSession/renameSession`。`interrupt()` 后结果是 `error_during_execution/aborted_streaming`，之后会话还能继续用。
- **用量：** `result.usage` 只算单回合主循环；`modelUsage` 和 `total_cost_usd` 是累计值，统计时要取差值。

### 12.2 Codex（app-server）
- **传输：** stdio，每行一个 JSON，**消息里没有 `jsonrpc` 字段**。握手顺序是 `initialize` → 通知 `initialized`。TS 类型用 `codex app-server generate-ts --out` 生成（加不加 `--experimental` 各生成一份），只使用稳定那份里的方法。
- **生命周期（稳定）：** `thread/start|resume|fork|list|read|rollback|archive|name/set`、`turn/start|steer|interrupt`、`thread/compact/start`、`model/list`、`config/mcpServer/reload`、`mcpServerStatus/list`。
- **覆盖参数：** thread 级可以设 `model/cwd/approvalPolicy/sandbox/baseInstructions/developerInstructions/config`；turn 级可以设 `approvalPolicy/sandboxPolicy/model/effort/cwd`，设置后对之后的回合也生效。turn 级**不能**改 instructions。
- **审批：** `item/commandExecution/requestApproval` 和 `item/fileChange/requestApproval`，回复 `{ decision: "accept"|"acceptForSession"|"decline"|"cancel" }`。文件变更的审批请求里**不带 diff**，要按 `itemId` 和 `item/started` 里的 fileChange 关联。
- **事件：** `item/started|completed`（commandExecution、fileChange（带统一 diff）、mcpToolCall（server 和 tool 是分开的字段）、webSearch、plan、contextCompaction……）、`item/agentMessage/delta`、`item/reasoning/*`、`item/commandExecution/outputDelta`、`turn/plan/updated`、`turn/diff/updated`、`thread/tokenUsage/updated`、`turn/completed`（status 为 completed、interrupted 或 failed，加 error；没有单独的失败事件）、`error`（带 `willRetry`）。
- **MCP：** 需要配置 `mcp_servers.<id>.url`、`bearer_token_env_var`，以及 **`default_tools_approval_mode="approve"`**（不配的话调用会被自动取消）。`tools/call._meta` 只带 `x-codex-turn-metadata`（thread_id、turn_id），不带 call_id。**不响应 `list_changed`**。token 环境变量没设时，MCP 服务器会**静默消失**，所以 probe 必须先检查。Codex 会去掉 schema 里的 `minimum`、`default` 等关键字，所以 Prometheus 工具不能依赖这些关键字做校验，执行端要自己校验。
- **备选的工具通道：** 🧪 `thread/start.dynamicTools` 加 `item/tool/call` 可以在协议内直接提供工具，自带 call id，不需要 MCP。等它稳定后可以替换 Codex 下的 MCP 总线。
- **本机环境问题（和设计无关，需要用户处理）：** `~/.codex/config.toml` 第 1 行格式错误，codex 的所有命令都会失败。Prometheus 的 probe 要把配置解析错误展示给用户。

### 12.3 由此修订的设计决定
1. §4.3 关联：CC 用 `_meta` 精确关联；Codex 用 `(turn_id, 回合内第 n 次调用该工具, 参数哈希)` 关联，对不上时以总线数据为准，单独生成工具卡片。
2. §4.5 热更新：CC 依赖 `list_changed`；Codex 在每个回合开始前，如果工具集有变化，就调用 `config/mcpServer/reload`。
3. §6 权限：CC 的拦截点从 `canUseTool` 改为 `PreToolUse`；Codex 模式切换用 turn 级的 `approvalPolicy/sandboxPolicy` 覆盖。
4. §7 网关：CC 在 Prometheus 网关模式下排除 user 设置层；Codex 在 Prometheus 网关模式下使用 Prometheus 自己的 `CODEX_HOME`（`<data>/runtimes/codex-home`），不读用户的 config.toml 和 auth.json，原生模式才用用户的 `CODEX_HOME`。
5. §5.2 static 上下文：CC 设置 `snapshot:false`，内容变化后的下一回合 resume 重启；Codex 在 `thread/resume` 时更新 `developerInstructions`。
6. 仍待验证：CC 的 `/compact` 在流式输入模式下是否可用、2.1.273 的 `_meta` 和 `list_changed` 行为、Codex 跨回合的 `list_changed`、冷启动性能、Android 上的 musl。
7. Codex 原生登录模式：用户的 ChatGPT 令牌可能很久没刷新，首次以原生模式启动 Codex 可能触发令牌轮换，存在把用户本机 Codex 登出的风险。`probe()` 只检查登录文件是否存在，不发真实请求；首次使用原生模式前在界面上提示。
8. 会话列表只读 Prometheus 自己的会话索引（§3.1），不依赖 `thread/list`（默认只返回交互式会话）。
9. 模型选择：`model/list` 的默认模型不一定可用（实测 gpt-5.5 在 ChatGPT 登录下不被支持），所以不直接采用其默认值，由用户选择，并以第一次成功的回合为准记录。
10. 合规（未决）：在 Prometheus 里调用用户本机 CLI 的订阅登录是否符合 Anthropic / OpenAI 条款。在确认之前，“原生登录模式”默认关闭，由用户在设置里自行开启并看到提示；使用 API key 或 Prometheus 网关的路径不受影响。

### 12.4 P4 实施中发现（Claude Code 2.1.310，Prometheus 网关模式）

- **TodoWrite 已被禁用**（CLI 报 "TodoWrite is disabled for this session"，它换成了任务工具）。所以 todo 面板改由总线上的 Prometheus `todo_write` 驱动，不再用原生工具；§4.4 里"todo 用原生"的结论作废。
- **ExitPlanMode 只在 Claude Code 自己处于 plan 模式时可用**，否则报 "You are not in plan mode"。所以 Prometheus 切到计划模式时，要同步 `query.setPermissionMode("plan")`；批准后切回 `default`。其余权限判断仍然只在 `PreToolUse` 钩子里做。
- **ExitPlanMode 的 `plan` 字段到不了钩子**（输入里的 plan 被剥掉，Claude Code 把计划放在计划文件里）。批准弹窗退而使用模型在本回合写的文字作为计划；还没在真实模型下验证这种取舍是否够用。
- `tools/call._meta["claudecode/toolUseId"]` 确实带着 tool_use id，总线事件据此与模型的 `tool_use` 关联，前端看到的是同一个 `toolCallId`。
- `PreToolUse` 返回 `permissionDecision: "allow"` 后，Claude Code 不会再走自己的询问流程；`canUseTool` 只做兜底。
- 总线上的拒绝（权限门不放行）以 `isError` 结果返回给模型，不会卡住会话。
- 会话 resume 用 SDK 的 `resume: <id>`，新会话用 `sessionId: <uuid>`，Prometheus 的会话 id 直接等于 Claude Code 的会话 id。
- 网关流量钩子（`ctx.hooks.gatewayTraffic`）：veil 的脱敏和还原挂在核心中继上，对所有外部 runtime 生效；PI 仍走 veil 原来的路径。

### 12.5 OpenCode（`opencode serve`，1.19.x）

第四个运行时，位于 `packages/core/src/agent/opencode`。不引入新依赖：直接用 HTTP 加 SSE 调它的服务进程。

- **传输：** 每个会话一个 `opencode serve --hostname=127.0.0.1 --port=0` 子进程，从输出里的 `opencode server listening on <url>` 取地址。用随机的 `OPENCODE_SERVER_PASSWORD` 做 HTTP Basic 认证，本机其他进程不能驱动它。事件走 `GET /event`（SSE），断开后自动重连，并用 `GET /session/status` 补一次状态。
- **配置：** 通过环境变量 `OPENCODE_CONFIG_CONTENT` 叠加在用户自己的配置之上，不写文件：`mcp.prometheus` 指向工具总线（`type: "remote"`，令牌用 `{env:PROMETHEUS_MCP_TOKEN}` 引用），`permission` 里把 `edit / bash / webfetch / external_directory / doom_loop` 设为 `ask`，让所有会改东西的操作都到权限门，由 Prometheus 的权限模式决定。
- **网关：** Prometheus 网关作为自定义 provider `prometheus` 注册（`@ai-sdk/openai-compatible`、`@ai-sdk/openai` 或 `@ai-sdk/anthropic`，按网关支持的协议依次选），`baseURL` 是中继的 `/v1`，`apiKey` 是会话令牌；同时设置 `enabled_providers: ["prometheus"]`，这个会话不会走用户自己的 provider。模型决定路由：换到别的网关或回到自带登录时，换一个进程，按同一个 opencode 会话继续。
- **自带登录：** 不覆盖用户的配置和数据目录，`opencode auth login` 的结果直接可用，会话也存在用户自己的 opencode 里。模型列表来自 `opencode models`，另有一项“配置的默认模型”（不传 model，由 opencode 自己选）。
- **消息：** `POST /session/:id/prompt_async`。静态上下文放在 `system` 字段；本回合的上下文和切换运行时的交接内容作为 `synthetic` 文本片段发送，模型能看到，聊天记录里不显示。计划模式用 opencode 的 `plan` 智能体，其余用 `build`。
- **事件映射：** `message.updated` 先于它的片段到达，用来区分用户消息、助手消息和压缩产生的摘要（摘要不显示）；`message.part.delta` 的 `text` 字段是增量。text、reasoning、tool 三种片段各生成一条助手消息，工具的 `pending` 状态没有参数，等到 `running` 才生成工具卡片。`step-finish` 的 token 数用于上下文用量。`session.status: idle` 结束一轮。
- **工具名：** opencode 的 `bash/read/edit/write/grep/glob/list/webfetch/websearch/todowrite/task` 规范化成 `bash/read/edit/write/grep/find/ls/web_fetch/web_search/todo_write/subagent`；我们自己的工具显示为 `prometheus_<tool>`，还原成 `<tool>`。`edit` 的结果带 opencode 给出的统一 diff。opencode 不把调用 id 传给 MCP 服务，所以和 Codex 一样按（工具名，参数哈希）把总线调用和工具卡片对上。
- **权限：** `permission.asked` 交给权限门，回复 `POST /permission/:id/reply`（`once` 或 `reject`）。`question.asked`（opencode 的提问工具）：有人在线时用 `ui.select` 问用户，无人值守或 auto 模式取第一个选项。
- **压缩：** `POST /session/:id/summarize`；自动压缩产生的 `compaction` 片段和 `session.compacted` 事件转成 `compaction_start/end`。
- **会话：** 会话列表由 Prometheus 自己的索引维护（和 Codex 一样）；恢复时 `GET /session/:id/message` 重建聊天记录；删除调用 `opencode session delete`。
- **未做：** 思考档位（opencode 的 variant）、回退到某条消息、分叉、斜杠命令列表、作为子智能体的执行器。

#### 服务模式（`AgentProfile.server`）

opencode 本来就是“起一个服务、多个客户端连上来用”的形态，所以 OpenCode Agent 可以不再每个会话起一个进程：

- **连接已有服务**（`server.url`，可带 `username`/`password`，即对方的 `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`）：probe 调 `GET /global/health` 判断可用与版本；模型列表取该服务的 `GET /config/providers`。
- **固定端口的共享服务**（只填 `server.port`）：Prometheus 第一次用到时在 `127.0.0.1:<port>` 起一个 `opencode serve`，这个 Agent 的所有会话共用，宿主退出时停掉；端口上已经有一个凭据相同的 opencode 服务时直接用它。密码留空则用随机密码（外部客户端接不进来），填了就能用 `opencode attach http://127.0.0.1:<port>` 接入同一个服务，和 Prometheus 里的会话互相可见。
- **每个会话的隔离**：服务是共享的，所以不能再用 `OPENCODE_CONFIG_CONTENT`。工具总线用 `POST /mcp` 动态注册，名字是 `prometheus-<会话 id 前 12 位>`（工具名前缀随之变为 `prometheus-xxxx_`，映射器按会话的名字还原）；会话关闭时 `POST /mcp/<name>/disconnect`。opencode 会把所有 MCP 工具给所有会话，而它只认“精确工具 id + pattern `*` + deny”的会话规则来隐藏工具（通配符不行；`prompt_async` 的 `tools` 字段会整个替换会话规则，也不能用），所以每次发消息前 `PATCH /session/:id` 写入：`edit/bash/webfetch/external_directory/doom_loop` 为 `ask`，再逐个 deny 其它会话总线上的工具 id（从 `GET /mcp` 取服务名，工具名按本会话的工具列表推出）。
- **限制**：服务模式只用服务自己配置的模型和登录，不能选 Prometheus 网关（网关是按会话注入的 provider）；Prometheus 工具总线只监听 127.0.0.1，所以连接其它机器上的服务时没有 Prometheus 工具（会记录警告）。删除会话走 `DELETE /session/:id`。
- 测试：`packages/core/test/opencode-server-mode.test.ts`（真实 opencode + 假模型，覆盖两种模式、工具隔离和权限门）。

### 12.6 ACP Agent（Agent Client Protocol，`packages/core/src/agent/acp`）

第五种运行时 `acp`，一份适配器支持所有实现了 [ACP](https://agentclientprotocol.com) 的 Agent：内置 Qwen Code（`qwen --acp`），设置里另有 Goose（`goose acp`）、Kimi CLI、Auggie、Claude Code / Codex 的 ACP 适配器等预设，其它 Agent 选“ACP”填命令和参数即可。内置与预设定义在 `packages/protocol` 的 `BUILTIN_AGENTS` / `ACP_PRESETS`（含一键安装用的 npm 包）。

- **传输：** stdio 上的 JSON-RPC 2.0，一行一条，双向请求（`acp-connection.ts`）。Windows 上 npm 的 `.cmd` 垫片解析成真实脚本或二进制，避免 shell 改写参数。每个会话一个进程，崩溃后下一条消息重启并 `session/load`。
- **握手：** `initialize` 声明 `fs`、`terminal` 都不提供，Agent 用自己的工具读写和执行；probe 也是一次握手（拿 `agentInfo.version`），结果缓存 5 分钟，`runtime.list` 并行探测。
- **工具总线：** `session/new|load` 的 `mcpServers` 里放 `prometheus`：Agent 声明 `mcpCapabilities.http` 时用 HTTP（`Authorization` 头带令牌），否则用 stdio 桥（`mcp-bridge.ts` 写到 `<data>/runtimes/acp/mcp-bridge.cjs`，由本机 Node 运行，地址和令牌走环境变量）。ACP 不给 MCP 调用 id，按工具名关联：标题第一个词（`echo_tool (prometheus MCP Server)`）、`mcp__x__name` 形式、代理工具输入里的 `name`（Qwen Code 把 MCP 工具藏在 `tool_search`/`tool_call` 后面）或 `_meta.toolName`。
- **权限：** Agent 被切到它自己的 `default` 模式（凡改动都发 `session/request_permission`），由权限门按 Prometheus 的模式决定，回复 `allow_once` / `reject_once`；我们自己的工具直接放行（总线会再判定，不问两次）；中止时未决的请求回 `cancelled`。计划模式与其它运行时一样：导出 `exit_plan_mode`，写操作由权限门拒绝。
- **上下文：** ACP 没有 system prompt 字段：静态上下文随进程的第一条消息、每轮上下文和交接内容每条消息，都放在一个 `<prometheus-context>` 文本块里，聊天记录里不显示（回放时也会剥掉）。
- **事件映射（`acp-mapper.ts`）：** `agent_message_chunk` / `agent_thought_chunk` 流式成文字和思考；`tool_call` / `tool_call_update` 按 `kind` 规范化（execute→bash，read，edit 的 diff→edit 或 write，search→grep，fetch→web_fetch/web_search……），参数到齐（`rawInput` 非空、或有 diff/路径、或已开始执行）才画卡片；`plan` 喂 todo 面板；`available_commands_update` 进 `/` 菜单；`usage_update` 进上下文用量。
- **回合与队列：** 一次 `session/prompt` 就是一回合，返回的 `stopReason` 结束它（`cancelled` 为中止，`refusal` / `max_tokens` / `max_turn_requests` 报错）。ACP 不能往进行中的回合插话，所以回复中发送的消息排队，回合结束后自动发出（`followUpQueue`，可撤回）；中止会清空队列。
- **模型：** “Agent 配置的默认模型”加上 Agent 在 `session/new` 里报告的 `models.availableModels`；切换用 `session/set_model`，不支持时退到 `session/set_config_option`。
- **网关：** ACP 本身不能指定端点，所以按 Agent 适配（`acp-gateway.ts`）。目前 Qwen Code 支持 Prometheus 网关（openai-completions，经中继：`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`--auth-type openai --model`），其它 ACP Agent 只用自己的登录。
- **会话：** 会话列表由 Prometheus 索引维护；界面上的记录另存一份在 `<data>/sessions/acp/<id>.json`。恢复时优先 `session/load`（Agent 回放的内容静默重建，界面用存下的记录）；Agent 不支持或加载失败时开新会话，并把旧记录作为交接内容随第一条消息交给它。
- **未做：** 压缩、分叉、回退、思考档位、`fs`/`terminal` 客户端能力（让 Agent 通过 Prometheus 读写文件和跑命令）、作为子智能体的执行器。
- 测试：`acp-runtime.test.ts`（脚本化的假 ACP Agent，含 HTTP 与 stdio 桥两种总线接法、权限、队列、中止、崩溃重启、恢复）、`conformance-acp-qwen.test.ts`（真实 Qwen Code 经中继连假模型）。

## 13. 实施阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 做完 spike（§12），修订本文的能力矩阵 | 每个 ❓ 有结论 |
| P1 | 抽出 `AgentRuntime`，`PiRuntime` 实现，加会话索引；`host.ts` 只做分发 | 现有测试全过，行为零变化 |
| P2 | 新插件 API + PiFacade + 内置插件迁移；上下文分成 static/turn | PI 下行为不变；新 API 的单测 |
| P3 | 工具总线（MCP HTTP）+ 网关中继（含 veil 钩子），先让 PI 走中继验证 | 一致性测试框架和假模型可以跑通 PI |
| P4 | ClaudeCodeRuntime（Prometheus 网关模式优先，再做原生模式） | 一致性测试全绿，或只有显式声明的跳过 |
| P5 | CodexRuntime（app-server） | 同上 |
| P6 | UI：新建会话时选 runtime 和网关、健康检查、能力置灰、插件兼容性提示（含移动端窄屏适配，§8.5）；文档 | 桌面和 Android（连接服务器、本机模式）各一份手工验收清单 |
| P7（可选） | 中继里的格式转换；"在另一个 runtime 中继续" | — |

P1 到 P3 对现有用户不可见，但做完之后，每接一个 runtime 就只是写一个适配器加通过一致性测试。

## 14. 当前进度与手工验收清单

P0 到 P5 已完成。P6 已完成：新建会话时选运行时（`RuntimePicker`）、运行时自带登录或 Prometheus 网关（按格式过滤：Claude Code 只列 anthropic-messages，Codex 只列 openai-responses）、按运行时和网关取模型列表（`runtime.models`）、按 `capabilities` 置灰（不支持插话时回复中发送改为排队，不支持图片时禁用附件）、插件页的兼容性提示（`plugin.compatibility`）。

会话快照带有 `gateway`，打开已有的非 PI 会话时模型列表按它取。P7 未开始。

### 手工验收（桌面）

1. 设置页能看到 PI、Claude Code、Codex；未安装的置灰并显示原因。
2. 新建会话选 Claude Code + 自带登录：能对话，bash/编辑的卡片和 diff 正常，todo 面板随 `todo_write` 更新。
3. 同上选 Codex。
4. 选 Prometheus 网关：模型列表只含对应格式的网关；开启 veil 后上游请求里敏感串已被替换。
5. 回复中发送：Claude Code 和 Codex 可插话；中止后会话可继续。
6. 权限模式切换（默认、自动编辑、计划、完全放行）在三个运行时下都生效。
7. 插件页：有不兼容项的插件显示"在 Claude Code / Codex 下部分不可用"。
8. 重启后会话仍在侧栏，打开后能续聊。

### 手工验收（Android）

1. 连接服务器模式：重复上面 1 到 8，新建会话页的选择器在窄屏下不溢出，弹层贴边显示。
2. 本机模式：Claude Code 与 Codex 不可用，选择器里置灰并提示"Android 本机模式不可用，请连接服务器"。

### 14.1 多协议网关与运行时切换

- **多协议网关**：`GatewayConfig.alternates` 记录同一密钥和模型可走的其它协议及各自的 Base URL，`format`/`baseUrl` 仍是主协议（PI 用它）。`gatewayFormats`、`gatewayAs`、`pickGatewayFormat`（`packages/protocol`）负责解析。Claude Code 取 `anthropic-messages`，Codex 取 `openai-responses`，中继按所选协议换上对应的 Base URL 和鉴权方式；选择器里按"是否支持该运行时的协议"过滤网关。
- **在另一个运行时继续**：`session.switchRuntime` 在同一目录用新运行时接着聊，列表里只保留这一个会话：原会话随即删除。原对话整理成文字记录（最近约 4 万字符，工具结果截断），作为不显示的上下文随第一条消息交给新运行时（Claude Code 走 `additionalContext`，Codex 走前置输入项，PI 前置在消息文本里，所以 PI 下会可见）。新会话的界面不显示旧消息。

### 14.2 只选 Agent，模型在模型选择器里选

- **Agent 菜单只列 Agent**（PI、Claude Code、Codex 和自定义 Agent），不再有"模型来源"一级。模型选择器像 PI 一样列出该 Agent 能用的全部模型：自带登录的模型，加上每个兼容网关的模型（组名是网关名，`provider` 即网关 id）。`runtime.models` 因此变为 `{ runtime, agent? }`，返回合并列表。
- **模型决定路由**：`session.create` / `session.switchRuntime` 的 `model` 的 `provider` 若是某个网关 id，就走 Prometheus 网关，否则走 Agent 自带登录。会话内用 `model.set` 换到另一个网关的模型时，Claude Code 会停掉进程，下一条消息用新端点 resume 同一会话；Codex 会替换 app-server 进程并 resume 同一线程。回复进行中不能换网关。新路由会写回会话索引，重开后保持。
- **自定义 Agent**（设置 → Agent）：基于 Claude Code 或 Codex，可设可执行文件路径和环境变量；`config.json` 的 `agents` 保存，内置两个也可以加覆盖。`agent.list/save/delete` 管理，改动对之后新建的会话生效。
- **Codex 自带登录**：每个会话用独立的 `CODEX_HOME`，复制账号的 `auth.json` 和 `config.toml`，再追加 Prometheus 工具总线的配置；模型为账号默认（`codex/default`）。账号自己的 `config.toml` 无法解析时，Codex 会报配置错误。

### 14.3 安装与更新 Agent CLI

- **安装位置：** 一键安装用 `npm install --global --prefix <data>/agents`，不碰用户全局的 npm；外部运行时把 `<data>/agents`（Windows）或 `<data>/agents/bin` 放在 PATH 最前。可安装的包来自 `BUILTIN_AGENTS` / `ACP_PRESETS` 的 `npm` 字段，基于 Claude Code / Codex / OpenCode 的自定义 Agent 用同一个包。
- **用哪个：** 不看是谁装的，只做一次 PATH 查找：Agent 里指定的可执行文件优先，否则取 PATH 上第一个，Prometheus 一键安装的目录（`<data>/agents`）排在 PATH **最后**，所以用户自己装的永远优先，没有时才用一键安装的那份。Claude Code 和 Codex 在这里解析（否则 Claude Code 会用 SDK 自带的 CLI，Codex 只看服务进程自己的 PATH），OpenCode 和 ACP Agent 按该 Agent 的 PATH 查找；Claude Code 都找不到时才退回 SDK 自带的（开发环境）。
- **检查更新：** `agent.checkUpdates`（设置 → Agent 打开时自动查，“检查更新”按钮强制刷新）。当前版本：对正在用的那个 CLI 执行 `--version`（按文件修改时间缓存），Claude Code 找不到 CLI 时取 SDK 的 `claudeCodeVersion`（来源 `bundled`）。最新版本用 `npm view <包> version`，所以 `.npmrc` 里的镜像生效，缓存 1 小时。指定了可执行文件（`custom`）、连接外部 OpenCode 服务（`server`）、不在 npm 上的 Agent（`noPackage`）不提供更新，界面上说明原因。
- **更新：** 就是 `agent.install`（安装 `@latest`）。只有跑的那份在 Prometheus 目录里（`source: prometheus`）才显示“更新”按钮；跑的是 PATH 上别处的（`path`），只提示有新版本，请用原来的方式更新，因为 Prometheus 装一份也排在它后面，不会生效。Claude Code 只有 SDK 自带版本（`bundled`）时，更新是装一份到 Prometheus 目录并从此使用。Windows 上正在运行的可执行文件被锁定时 npm 会失败，错误里提示先关闭使用它的会话。
- 测试：`agent-install.test.ts`（版本解析与比较、已装版本与入口），`agent-update.e2e.test.ts`（`PROMETHEUS_TEST_UPDATES=1`：真实 npm，旧版 OpenCode → 检查 → 更新 → 运行的是新版）。
- **安装包不带 Claude Code：** 桌面端打包（`bundle-server.ts`）会删掉 Agent SDK 的各平台二进制（`@anthropic-ai/claude-agent-sdk-<平台>`，约 280 MB），以及 LanceDB 可选依赖带来的 `@huggingface/transformers`、`onnxruntime-*`、`sharp`（约 100 MB，向量由网关计算，用不到）。没有二进制又没指定可执行文件时，Claude Code 的 `probe` 返回不可用，设置页显示“安装”，装好后走上面“装的就是跑的”的路径。开发环境（pnpm 安装）仍带二进制，行为不变。
