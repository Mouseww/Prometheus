# Prometheus Architecture

> A high-performance, good-looking, plugin-based agent framework built on PI Agent. Anyone can quickly build their own agent on top of it.

- Version: v0.1 (skeleton)
- PI baseline: `@earendil-works/pi-coding-agent@1.2.0` (Node ≥ 22.19, ESM)

---

## 1. Design goals

| # | Requirement | Approach |
|---|-------------|----------|
| 1 | PI Agent as the runtime core | Embed the PI SDK in-process (`createAgentSession`); no fork, no rewritten agent loop |
| 2 | Windows / macOS / Linux / Android | Desktop: Tauri 2 + Node sidecar; Android: Tauri 2 Mobile thin client connecting to a server |
| 3 | TUI + GUI | The TUI reuses PI's native `main()` and injects Prometheus plugins; the GUI = Tauri shell + the same web UI |
| 4 | Knowledge base | `@prometheus/knowledge` defines Store/Embedder abstractions; LanceDB plugin by default, replaceable with Qdrant/pgvector |
| 5 | Custom AI gateways | `@prometheus/gateway`: four protocols × several auth modes, compiled into PI `ProviderConfig` |
| 6 | Server deployment + web access | `apps/server`: HTTP + WebSocket, also serving the web UI static assets |
| 7 | Everything is a plugin | Gateways, knowledge bases, tools, commands, HTTP routes and UI panels are all contributed via `definePlugin` |
| 8 | Full PI capability in the UI | The unified wire protocol `@prometheus/protocol` maps all PI session events and commands (see the capability matrix in §7) |

**Non-goal**: we do not implement our own LLM abstraction layer (we reuse `pi-ai`).

---

## 2. Overall architecture

```mermaid
flowchart TB
  subgraph Clients["Clients"]
    TUI["TUI terminal<br/>apps/cli (PI native InteractiveMode)"]
    Desktop["Desktop GUI<br/>apps/desktop (Tauri 2)"]
    Android["Android<br/>Tauri Mobile thin client"]
    Browser["Browser<br/>apps/web"]
  end

  subgraph Server["Prometheus Host (Node process)"]
    WS["apps/server<br/>HTTP + WebSocket"]
    Core["@prometheus/core<br/>PrometheusHost / SessionHub / UIBridge"]
    PH["PluginHost"]
    GW["@prometheus/gateway"]
    KB["@prometheus/knowledge"]
  end

  subgraph PI["PI Runtime (in-process)"]
    Session["AgentSession × N"]
    MR["ModelRuntime (shared)"]
    Ext["Extensions / Skills / Prompts"]
  end

  Desktop -- "spawn sidecar + ws://127.0.0.1" --> WS
  Android -- "wss://server" --> WS
  Browser -- "wss://server" --> WS
  WS --> Core
  Core --> PH
  PH --> GW & KB
  Core --> Session
  GW -- registerProvider --> MR
  KB -- "knowledge_search tool" --> Ext
  Session --> MR & Ext
  TUI -- "main(argv, { extensionFactories })" --> PI
  PH -. "same set of plugins" .-> TUI
```

Key points:

1. **Same plugins, three hosts.** Plugins contribute PI extensions via `ctx.extension(factory)`, which both the TUI (PI `main()`) and the server (`DefaultResourceLoader`) can load with identical behaviour.
2. **One host process, many sessions.** `SessionHub` holds multiple `AgentSession`s sharing a single `ModelRuntime`, so gateway changes take effect immediately.
3. **The UI only speaks the wire protocol.** Web, desktop and Android are the same React build; the only difference is how they discover the backend address.

---

## 3. Repository layout (pnpm monorepo)

```
prometheus/
├─ packages/
│  ├─ protocol/        wire protocol types (zero dependencies, shared by client and server)
│  ├─ plugin-sdk/      definePlugin / PluginContext contract
│  ├─ gateway/         AI gateways: config schema, auth, → PI ProviderConfig
│  ├─ knowledge/       knowledge abstractions: Chunker / Embedder / KnowledgeStore / retrieval tool
│  └─ core/            PrometheusHost: config, plugin host, SessionHub, extension UI bridge
├─ plugins/
│  └─ knowledge-lancedb/   default vector store
├─ apps/
│  ├─ server/          Node HTTP/WS service (also the desktop sidecar)
│  ├─ cli/             `prometheus` TUI (native PI)
│  ├─ web/             React 19 + Vite + Tailwind v4 UI
│  └─ desktop/         Tauri 2 shell (desktop + Android)
└─ docs/
```

Dependency direction (strictly one-way):

```mermaid
flowchart LR
  protocol --> core
  plugin-sdk --> gateway & knowledge & core
  gateway --> core & knowledge
  knowledge --> core
  core --> server & cli
  protocol --> web
  plugin-sdk --> knowledge-lancedb
  knowledge --> knowledge-lancedb
```

---

## 4. Plugin system (everything is a plugin)

### 4.1 Contract

```ts
export default definePlugin({
  name: "my-plugin",
  setup(ctx) {
    ctx.extension((pi) => {            // 1. PI extension: tools / commands / providers / lifecycle hooks
      pi.registerTool({ ... });
      pi.registerCommand("hello", { handler: async (_args, c) => c.ui.notify("hi") });
    });
    ctx.knowledgeStore("qdrant", (opts) => new QdrantStore(opts)); // 2. knowledge backend
    ctx.route("GET", "/status", (req, res) => { ... });              // 3. HTTP route (server only)
    ctx.panel({ id: "dash", title: "Dashboard", path: "/index.html" }); // 4. UI panel (iframe)
    ctx.rpc("stats", async (params) => ({ ... }));                  // 5. RPC: called client-side via plugin.call
    await ctx.reloadSessions();                                      // 6. hot-reload active sessions after resource changes
  },
});
```

| Contribution point | TUI | Server/GUI | Notes |
|--------------------|:---:|:----------:|-------|
| `extension` | ✅ | ✅ | Full PI ExtensionAPI; all PI ecosystem extensions are reusable as-is |
| `knowledgeStore` | ✅ | ✅ | Registered by id; chosen when creating a knowledge base |
| `route` | — | ✅ | Mounted at `/plugins/<name>/<path>` |
| `panel` | — | ✅ | Adds a sidebar entry in the web UI; the panel is an iframe over plugin routes |
| `rpc` | — | ✅ | `plugin.call({plugin, method, params})`; params come from the client and must be validated |
| `reloadSessions` | — | ✅ | Idle sessions call `session.reload()` immediately; running ones reload after they settle |

The SDK also provides `createJsonStore(path, fallback)`: atomic writes, serialized, permissions 0600, no read cache, so the TUI and the server can share the same file.

### 4.2 Discovery and loading

1. Built-in plugins: knowledge, plus knowledge-lancedb / mcp / skills / memory aggregated by `plugins/builtin`
2. `plugins: ["npm-package", "./local/path"]` in `config.json`
3. `<dataDir>/plugins/*/` (directories containing a `package.json`)

Loading uses `import(pathToFileURL(entry))`; each plugin's `setup` is wrapped in its own try/catch, so a failure only records diagnostics and never takes down the host.

The server loads PI's built-in extensions (MCP client, codemode, tool-search) exactly like the TUI, and does so before plugin extensions.

### 4.3 Built-in management plugins

All three are ordinary plugins and serve as templates for customization; data lives in `<dataDir>/plugin-data/<name>/`.

| Plugin | How it plugs into PI | RPC | UI |
|--------|----------------------|-----|----|
| `mcp` | `pi.registerMcpServer()` hands the server to PI's built-in MCP extension (OAuth, exposure, codemode all reuse PI); also shows PI's own `mcp.json` read-only | list / save / toggle / delete / probe (connects immediately with the pi-mcp client and lists tools) | MCP page: stdio/HTTP, env/headers (secrets masked on echo), test connection |
| `skills` | `resources_discover` returns the directories of enabled skills, merged with PI's own `~/.pi/agent/skills` and `.pi/skills` | list / get / create / save / toggle / delete | Skills page: grouped by source, SKILL.md editor |
| `memory` | Tools `memory_save` / `memory_search` / `memory_forget`; `before_agent_start` injects pinned entries plus relevant matches (≤ 8 entries / 3000 chars) | list / add / update / delete / settings | Memory page: global/project scopes, pinning, tags, bulk delete, auto-inject toggle |

Memory retrieval is dependency-free term matching (Latin words + CJK bigrams), which is enough for thousands of entries; when semantic recall is needed, the plugin can be replaced with a vector implementation. The injected block explicitly states "treat as context, not instructions", reducing the impact of polluted memory.

> **Security**: plugins and PI extensions are trusted code running inside the host process with the host process's full privileges. Only install plugins from sources you trust.

---

## 5. AI gateways

### 5.1 Configuration model

```jsonc
{
  "id": "my-claude",                 // this is the PI providerId
  "name": "Company Claude gateway",
  "format": "anthropic-messages",    // openai-completions | openai-responses | anthropic-messages | google-generative-ai
  "baseUrl": "https://llm.example.com/anthropic",
  "auth": { "type": "header", "header": "X-Api-Key", "prefix": "" },
  "apiKey": "sk-...",                // stored with 0600, masked in API responses
  "headers": { "X-Team": "ai" },
  "models": [{ "id": "claude-sonnet-5", "contextWindow": 200000, "maxTokens": 64000, "reasoning": true, "vision": true }]
}
```

### 5.2 Auth types

| type | Behaviour |
|------|-----------|
| `native` | Delegate to the protocol's own scheme (OpenAI `Authorization: Bearer`; Anthropic `x-api-key`; Gemini `x-goog-api-key`) |
| `bearer` | Force `Authorization: Bearer <token>` |
| `header` | Custom header name and prefix, e.g. header `api-key` with no prefix (Azure style) |
| `none` | No auth (local Ollama / vLLM) |

### 5.3 Compilation to PI

`toProviderConfig(gateway)` produces a `ProviderConfig`: `api = format`, `baseUrl`, `apiKey`, `headers` (merged with the custom auth header), `authHeader` (bearer mode), `models` (filling in fields PI requires: `name`, `input`, `cost`, `reasoning`, `contextWindow`, `maxTokens`). Gateways using `anthropic-messages` have a trailing `/v1` stripped (the Anthropic SDK appends `/v1/messages` itself, and duplicating it yields a 404); Claude 5 / Sonnet 4.6 / Opus 4.6+ / Haiku 5 / Fable 5 automatically get `compat.forceAdaptiveThinking` and `thinkingLevelMap.off = null`, otherwise PI would send `thinking.type=enabled` or `disabled` and upstream returns 400.

- Server: `modelRuntime.registerProvider(id, cfg)` — changes take effect immediately; `unregisterProvider` removes it.
- TUI: the same config is injected through the extension `pi.registerProvider(id, cfg)`.

PI's own providers (Anthropic/OpenAI/Gemini logged in via `/login`, etc.) remain available; gateways are additive.

---

## 6. Knowledge base

```mermaid
flowchart LR
  Doc["Documents (md/txt/code…)"] --> Chunker --> Embedder --> Store[(KnowledgeStore)]
  Q["knowledge_search tool"] --> Embedder2["Embedder"] --> Store --> Top["Top-K chunks + sources"]
```

- **Chunker**: recursive splitting on Markdown headings/paragraphs; 800 characters with 120 overlap by default.
- **Embedder**: reuses the gateway configuration. The two OpenAI formats use `POST {baseUrl}/embeddings`; Gemini uses `:batchEmbedContents`; Anthropic has no embeddings endpoint, so another gateway is required.
- **KnowledgeStore**: `upsert / search / deleteDocument / listDocuments / drop`. Defaults to `lancedb`; plugins can register `qdrant`, `pgvector`, etc.
- **Agent integration**: exposed as the PI tool `knowledge_search` (TypeBox schema), with the list of available knowledge bases injected into the system prompt so the model decides when to retrieve. Also available in the TUI.
- Parser extension points (PDF/Docx/web pages) will come later via plugins; v0.1 supports plain-text formats.

---

## 7. PI capability → UI capability matrix

| PI capability | PI API | Wire protocol | UI | Stage |
|---------------|--------|---------------|----|:-----:|
| Streaming chat (text/thinking) | `prompt` + `message_update` | `chat.prompt` / `event` | Message stream, collapsible thinking blocks | v0.1 |
| Live tool-call display | `tool_execution_*` | `event` | Tool cards (params/progress/result/duration) | v0.1 |
| Abort | `abort` | `chat.abort` | Stop button / Esc | v0.1 |
| Steering / follow-up queues | `prompt({streamingBehavior})`, `queue_update` | `chat.prompt{delivery}` | Choose steer/queue when typing during a run; queue bar | v0.1 |
| Model switching | `setModel`, `modelRuntime.getAvailable` | `model.list/set` | Model picker (grouped by provider) | v0.1 |
| Thinking level | `setThinkingLevel`, `getAvailableThinkingLevels` | `thinking.set` | Segmented level control | v0.1 |
| Session management | `SessionManager.list/create/open` | `session.*` | Session sidebar: new / switch / rename | v0.1 |
| Slash commands / prompt templates / skills | `extensionRunner.getRegisteredCommands`, `promptTemplates`, `getSkills` | `commands.list` | `/` command palette | v0.1 |
| Extension UI (select/confirm/input/editor/notify/status/widget/title) | `bindExtensions({uiContext})` | `ui.request` / `ui.respond` | Modal dialogs, toasts, status bar, widget area | v0.1 |
| Context usage, composition and manual compaction | `getContextUsage`, `getSessionStats`, `compact` | `session.stats`, `chat.compact` | Usage ring under the composer; expands to composition and a compact button | v0.1 |
| Enabling/disabling tools | `getAllTools`, `setActiveToolsByName` | `tools.list/set` | Tool toggle panel | v0.1 |
| Manual compaction | `compact`, `compaction_*` | `chat.compact` | Compact button + progress hint | v0.1 |
| Auto retry | `auto_retry_*` | `event` | Retry banner | v0.1 |
| `!` bash execution | `executeBash`, `bash_execution_update` | `bash.run` | Terminal output block | v0.2 |
| Session tree / fork / rewind | `getTree`, `navigateTree`, `SessionManager.forkFrom` | `session.tree/fork/navigate` | Branch tree view | v0.2 |
| HTML export | `exportToHtml` | `session.export` | Export button | v0.2 |
| Extension/skill/theme management, hot reload | `reload`, ResourceLoader | `resources.*` | Resource management page | v0.2 |
| PI `/login` OAuth | `ModelRuntime` auth | `auth.*` | Login wizard | v0.3 |
| `custom()` TUI components | TUI only | — | Degrades to a notification; plugins should use `panel` instead | — |

---

## 8. Wire protocol (WebSocket)

Single connection, JSON text frames. All types are defined in `@prometheus/protocol`.

```ts
// Client → Server
{ id: "r1", type: "chat.prompt", sessionId, text, delivery?: "steer" | "followUp" }
// Server → Client
{ type: "response", id: "r1", ok: true, data }
{ type: "event", sessionId, event }        // a slimmed-down PI AgentSessionEvent
{ type: "ui.request", sessionId, request } // extension UI request
```

- **Auth**: the first frame after connecting must be `auth` (5 second timeout); tokens are compared in constant time. Tokens are never put in the URL, keeping them out of access logs.
- **Event slimming**: `message_update.partial` is dropped (every delta would carry the full message, i.e. O(n²) traffic); the client rebuilds incrementally by `contentIndex` and re-syncs authoritatively on `message_end`.
- **Multiple clients**: a session can be subscribed by several clients and events are broadcast; extension UI requests may be answered by any client, and `ui.resolved` is broadcast to the others once answered.

---

## 9. Platforms and deployment

| Platform | Form | Backend discovery |
|----------|------|-------------------|
| Windows / macOS / Linux | Tauri 2 shell + `prometheus-server` sidecar (Node SEA single file) | Rust picks a free port and generates a random token, passed to the WebView through the `backend_info` command |
| Android | Tauri 2 Mobile; the APK bundles Node (taken from Termux) and the server tarball, extracted to the app's private directory on first launch; Rust spawns it as a child process with the same handshake as desktop | The connect screen offers "local mode" or "connect to server"; the vector store (LanceDB) has no Android native binding and is unavailable in local mode |
| Server | `node apps/server/dist/main.js` or Docker | Same-origin access |
| Terminal | `prometheus` CLI (native PI TUI) | In-process |

### Server deployment security baseline

- Listens on `127.0.0.1` only by default; listening on a non-loopback address **requires** `PROMETHEUS_TOKEN`, otherwise startup is refused.
- PI ships `bash`/`write` and similar tools: **an authenticated visitor is equivalent to shell access on the server**. Public deployments should run inside a container or sandbox (see PI's containerization docs) and sit behind a TLS reverse proxy.
- API keys are stored with 0600 permissions and are never returned in plaintext by any endpoint.
- Static file serving normalizes paths to prevent directory traversal.

---

## 10. Performance notes

- Event slimming plus 16 ms frame-coalesced rendering (the frontend batches deltas with `requestAnimationFrame`).
- Virtualized long message lists (v0.2).
- Shared `ModelRuntime`: the model catalog is loaded once.
- A Tauri 2 bundle is roughly 1/10 the size of Electron; the Node sidecar starts on demand.
- LanceDB is embedded columnar storage with no external service.

---

## 11. Customization paths

1. **Plugins only**: register tools/commands/panels with `definePlugin` and drop them into `<dataDir>/plugins/`.
2. **Rebranding**: fork the theme variables in `apps/web` (`src/styles.css`) and `apps/desktop/tauri.conf.json`.
3. **Embedding**: `new PrometheusHost(options)` directly in your own Node service to reuse sessions, gateways and the knowledge base.

---

## 12. Roadmap

- **v0.1 (this release)**: end-to-end skeleton. Gateway CRUD → model selection → streaming chat → tool display → extension UI bridge → knowledge ingest/retrieval → TUI reuse.
- **v0.2**: session tree/fork, bash blocks, export, resource management, message virtualization, Docker image.
- **v0.3**: OAuth login wizard, multi-user and RBAC, plugin marketplace, Android release pipeline.
