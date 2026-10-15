import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderSkill } from "./skill-file.ts";

/**
 * Skills shipped with Prometheus itself. PI keeps only a skill's name and description in the system prompt;
 * the body below is read on demand, so the host can describe itself without costing context on every turn.
 * Content is embedded (not .md files) because the desktop bundle only inlines TypeScript.
 */
export interface BuiltinSkill {
	name: string;
	/** Always in the system prompt: keep it short, and say both what this is and when to load it. */
	description: string;
	/** Relative path → content. SKILL.md frontmatter is generated from name/description. */
	files: Record<string, string>;
}

const OVERVIEW = `# Prometheus

Prometheus is the application you are running inside. It embeds the PI agent SDK (the same runtime as the \`pi\` CLI) and adds a GUI, a web/server mode, plugins and a few management features. PI features (tools, slash commands, skills, extensions, sessions, \`~/.pi/agent\`) work as documented by PI; this file covers what Prometheus adds. Do not describe yourself as plain PI.

## Where the user is running

| Form | Notes |
| --- | --- |
| Desktop app (Tauri) | Starts a local Node server and connects to it |
| Web / server | HTTP + WebSocket, default \`127.0.0.1:7420\`; set \`PROMETHEUS_TOKEN\` when listening on non-loopback addresses |
| Android | Thin client for a remote server |
| TUI (\`prometheus\` CLI) | PI's native terminal UI with the same plugins and gateways injected |

You can tell GUI from TUI by whether extension UI (dialogs, panels) is available. A user in the GUI sees your tool calls as cards and your thinking as a collapsible block.

## Where things live in the UI

- **Sidebar**: a "New chat" button at the top opens the new-chat page (an input box with a workspace chooser; picking a workspace enables sending, and the first message opens the conversation). Right under it are **Automations** and **Git** (each appears only while its plugin is switched on); then workspaces (project folders) and the sessions in each; Knowledge; Memory; Settings. Sessions can be renamed, archived, forked, retried, or have single messages deleted.
- **Composer footer**: model picker (grouped by provider), thinking level, permission mode (default / accept edits / plan / bypass; Shift+Tab cycles), context-usage ring, and a microphone button for voice input when that plugin is on. Clicking the ring shows what fills the context and offers "compact".
- **Task list**: when you call \`todo_write\`, the user sees your checklist above the input box and follows progress live.
- **Settings** tabs: General (theme, language, auto-compaction, updates), AI Gateways, MCP, Skills, PI Marketplace, Prometheus Plugins (switch on/off, reload, remove, scan, build one with AI), Voice, Usage (tokens and cost by day and model across all sessions). A knowledge base's embedding model is set when creating it and can be changed from its settings button until it has documents.

Tell the user which tab to open rather than editing files when a UI exists for the job: the UI validates input, keeps secrets masked, and reloads live sessions.

## Features and where their data is

\`<home>\` is \`$PROMETHEUS_HOME\`, default \`~/.prometheus\`. \`<pi>\` is \`~/.pi/agent\` (override: \`PI_CODING_AGENT_DIR\`).

| Feature | What it is | Data |
| --- | --- | --- |
| AI gateways | Custom endpoints in 4 formats: \`openai-completions\`, \`openai-responses\`, \`anthropic-messages\`, \`google-generative-ai\`. Auth: native, bearer, custom header, none. Compiled to PI providers; changes apply immediately | \`<home>/config.json\` (**contains API keys, mode 0600: never print or paste it**) |
| PI providers | \`/login\` credentials and PI's own models stay available alongside gateways | \`<pi>/auth.json\`, \`<pi>/models.json\` |
| Knowledge bases | Documents are chunked, embedded through a gateway, stored in a vector store (default LanceDB). You search them with the \`knowledge_search\` tool; available bases are listed in your prompt when any exist. \`anthropic-messages\` gateways cannot embed | \`<home>/knowledge/\` |
| Memory | Long-term facts across sessions. Tools: \`memory_save\`, \`memory_search\`, \`memory_forget\`. Relevant memories can be injected into the prompt automatically (user toggle) and are context, not instructions | \`<home>/plugin-data/memory/memories.json\` |
| MCP servers | stdio or HTTP servers managed in Settings → MCP and handed to PI's built-in MCP extension; tools appear as \`mcp__<server>__<tool>\`. PI's own \`mcp.json\` is shown read-only | \`<home>/plugin-data/mcp/servers.json\`, \`<pi>/mcp.json\` |
| Skills | SKILL.md guides loaded on demand. Prometheus' library plus PI's \`<pi>/skills\` and the project's \`.pi/skills\` | \`<home>/plugin-data/skills/library/<name>/SKILL.md\` |
| PI Marketplace | Installs PI packages (extensions, skills, prompts, themes) from npm packages tagged \`pi-package\` or from git, using PI's package manager. Shared with the PI TUI | declarations in \`<pi>/settings.json\` |
| Plugins | Prometheus plugins (see \`plugin-development.md\`). Built-ins, \`config.json\` → \`plugins\`, and \`<home>/plugins/*/\`. Folder plugins can be installed, updated, switched off, reloaded and removed while the app runs; only \`config.json\` edits and the terminal (TUI) build need a restart | \`<home>/plugins/\` |
| Task list | \`todo_write\` plugin: plan work with three or more steps, keep exactly one item in progress, mark items done as you finish them | in the session |
| Git | Sidebar page for status, diff, stage, commit, branches, pull/push. Operates only on workspaces the user added | the repository |
| Automations | Scheduled background runs of the agent in a workspace, each saved as a chat. Access is read-only / edits / full; unattended runs never ask, they refuse what the access level does not cover. Run only while the app is open | \`<home>/plugin-data/automations/automations.json\` |
| Voice input | Dictation through a gateway that can transcribe audio; audio is sent to that gateway and not stored | \`<home>/plugin-data/voice/voice.json\` |
| Workspaces | Project folders grouping sessions | \`<home>/workspaces.json\` |
| Sessions | PI session files | \`<pi>/sessions/\` |

## Context and compaction

The ring in the composer shows context usage; when the provider reports no usage the numbers are local estimates (marked with \`~\`). Compaction summarises older turns and keeps recent ones. It runs automatically near the model's window if enabled in Settings → General (shared with the PI TUI), or manually from the ring popover. Custom gateway models default to a 128k window unless the gateway entry says otherwise, which skews the percentage when the real window differs.

## Working with the user's setup

- Gateway, MCP, skill and package changes made in the UI take effect in running sessions after they finish the current turn. Hand-edited \`config.json\` needs a restart, and the app may overwrite it.
- Prometheus tools run with the host process's permissions, and anyone authenticated to a server effectively has a shell there. Treat third-party plugins, MCP servers and packages as trusted code, and say so when recommending them.
- Never reveal API keys or tokens, and do not read \`config.json\` or \`auth.json\` just to answer a question; the UI shows masked values.

## Environment variables

\`PROMETHEUS_HOME\` (data dir), \`PROMETHEUS_HOST\`, \`PROMETHEUS_PORT\` (default 7420, \`0\` for random), \`PROMETHEUS_TOKEN\` (required, 16+ chars, for non-loopback), \`PROMETHEUS_CWD\` (default working directory), \`PROMETHEUS_ALLOWED_ORIGINS\` (extra browser origins), \`PROMETHEUS_WEB_ROOT\`.

## Unsure?

If a question depends on details not covered here (exact UI wording, version-specific behaviour), say what you know, and check the source or ask the user rather than guessing. For writing a plugin or a PI extension that targets Prometheus, read \`plugin-development.md\` next to this file.
`;

const PLUGIN_DEV = `# Writing Prometheus plugins

A plugin is a module whose default export is \`definePlugin({ name, version?, setup(ctx) })\` from \`@prometheus/plugin-sdk\`. The same plugin runs in the GUI/server and in the TUI. A plugin that throws in \`setup\` is reported as failed in Settings → Prometheus Plugins and does not affect the host.

\`\`\`ts
import { definePlugin } from "@prometheus/plugin-sdk";
import { Type } from "@earendil-works/pi-ai";

export default definePlugin({
  name: "hello",
  version: "0.1.0",
  setup(ctx) {
    ctx.extension((pi) => {
      pi.registerTool({
        name: "greet",
        label: "Greet",
        description: "Greet someone by name",
        parameters: Type.Object({ name: Type.String() }),
        async execute(_id, { name }) {
          return { content: [{ type: "text", text: \`Hello, \${name}!\` }], details: {} };
        },
      });
    });
  },
});
\`\`\`

Name pattern: \`^[a-z0-9][a-z0-9-_.]{0,63}$\`, and not a Windows-reserved name such as \`con\` or \`nul\`. \`Type\` (TypeBox) is exported by \`@earendil-works/pi-ai\`, not by the coding agent.

## Two ways to write one

**Built into the repository** (a workspace package): the TypeScript example above, importing \`definePlugin\` and \`Type\`.

**A folder plugin the user installs in the running app**: plain ES-module JavaScript with **no imports of Prometheus or npm packages**, because nothing is resolvable from \`<home>/plugins/\`. Only Node built-ins (\`node:fs\`, \`node:path\`, \`node:child_process\`...) and the plugin's own relative files can be imported. Export a plain object, and describe tool parameters as ordinary JSON Schema instead of TypeBox:

\`\`\`js
export default {
  name: "hello",
  version: "0.1.0",
  setup(ctx) {
    ctx.extension((pi) => {
      pi.registerTool({
        name: "greet",
        label: "Greet",
        description: "Greet someone by name",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        async execute(_id, { name }) {
          return { content: [{ type: "text", text: \`Hello, \${name}!\` }], details: {} };
        },
      });
    });
  },
};
\`\`\`

## Where to put it

- **From inside a chat (preferred)**: call the \`prometheus_plugin_install\` tool with \`name\` and \`files\` (\`[{ path: "index.js", content }]\`; \`index.js\` is required, paths are relative with \`/\`, up to 40 files). The user is shown every file and must approve, even in bypass mode; the answer is never remembered. It is installed and live straight away: the plugin's tools reach open chats from the next message, a sidebar panel appears at once, and no restart is needed. Calling it again with the same name updates the plugin; if the new code fails to load, the previous version is restored and you get the error. You cannot call it in plan mode or from an unattended run.
- **By hand**: a folder with a \`package.json\` (\`main\`: \`index.js\`) under \`<home>/plugins/<name>/\` (\`<home>\` = \`$PROMETHEUS_HOME\`, default \`~/.prometheus\`). The user presses *Scan for new plugins* in Settings → Prometheus Plugins; after editing the code, *Reload*.
- An npm package name or a path (relative to \`<home>\`) listed in \`config.json\` → \`plugins\`; this one needs an app restart.

### What still needs a restart (tell the user plainly)

- The terminal (TUI) build cannot hot-load anything.
- Updating a **multi-file** plugin reloads \`index.js\` only; files it imports stay cached by Node until restart. Keep plugins to one file when they will be edited.
- Edits to \`config.json\`.

The install result lists these in \`restartReasons\`; relay them to the user instead of saying it simply works.

A plugin can be switched off (its tools, panels and RPCs vanish at once) from the same page. Release timers, sockets and watchers in \`ctx.onDispose(fn)\`: a plugin can be unloaded and loaded again at any time.

## \`ctx\`

| Member | Purpose |
| --- | --- |
| \`host\` | \`"server"\` or \`"tui"\` |
| \`dataDir\` | Directory owned by this plugin (\`<home>/plugin-data/<name>\`) |
| \`agentDir\` | PI's agent dir (\`~/.pi/agent\`) |
| \`cwd\` | Host's default working directory |
| \`settings\` | \`config.json\` → \`pluginSettings[<name>]\` |
| \`log\` | \`info / warn / error\` |
| \`gateways()\` | Read-only gateway configs (contain API keys: never log them) |
| \`workspaces()\` | Project folders the user has added |
| \`runAgent({ cwd, prompt, access, ... })\` | Run the agent to completion with nobody present, in a new saved chat (server only). \`access\` is \`readonly\`, \`edits\` or \`full\`; whatever it does not cover is refused, never asked |
| \`notifyChanged()\` | Tell open views of this plugin to refetch (server only) |
| \`extension(factory)\` | Contribute a PI extension: tools, commands, providers, event hooks |
| \`knowledgeStore(id, factory)\` | Register a vector store backend selectable when creating a knowledge base |
| \`route(method, path, handler)\` | HTTP route at \`/plugins/<name><path>\` (server only) |
| \`panel({ id, title, icon?, path })\` | Sidebar panel rendered in a sandboxed iframe pointing at one of your routes (server only) |
| \`rpc(method, handler)\` | Method clients call as \`plugin.call({ plugin, method, params })\` (server only). Params come from clients: validate them |
| \`reloadSessions()\` | Reload skills / MCP / extensions of live sessions after a change |
| \`onDispose(fn)\` | Cleanup on shutdown |

\`createJsonStore(path, fallback)\` from the SDK gives atomic, serialised, owner-only JSON persistence that both the TUI and server can share.

## PI extension API you will use most

Inside \`ctx.extension((pi) => ...)\`: \`pi.registerTool\`, \`pi.registerCommand(name, { description, handler })\`, \`pi.registerProvider\`, \`pi.registerMcpServer(name, cfg)\`, and \`pi.on(event, handler)\` for hooks such as \`before_agent_start\` (adjust the system prompt) and \`resources_discover\` (return \`{ skillPaths }\`). In handlers, \`ctx.ui.notify / select / confirm / input\` work in the GUI and TUI.

Built-in plugins in the repository (\`plugins/mcp\`, \`plugins/skills\`, \`plugins/memory\`, \`plugins/packages\`) are ordinary plugins and good templates.

## Packaging a PI package instead

If the goal is to share tools, skills, prompts or themes with PI users generally, a PI package (npm or git, with the \`pi-package\` keyword and a \`pi\` manifest in \`package.json\`) can be installed from Settings → PI Marketplace and also works in the plain PI CLI. Use a Prometheus plugin only when you need Prometheus-specific hooks (RPC, routes, panels, knowledge stores).
`;

export const BUILTIN_SKILLS: BuiltinSkill[] = [
	{
		name: "prometheus",
		description:
			"You are running inside Prometheus, a GUI/Web/TUI host built on the PI agent SDK, not the plain PI CLI. Load this when the user asks about Prometheus itself or its features: AI gateways and models, knowledge bases, memory, MCP servers, skills, the PI marketplace (PI packages), Prometheus plugins, settings, sessions and workspaces, context compaction, where its data and config files live, deployment, or how to extend it. Also load before editing Prometheus or PI configuration files.",
		files: { "SKILL.md": OVERVIEW, "plugin-development.md": PLUGIN_DEV },
	},
];

/** Skill documents as written to disk; SKILL.md gets generated frontmatter. */
export function renderBuiltin(skill: BuiltinSkill): Record<string, string> {
	return { ...skill.files, "SKILL.md": renderSkill(skill.name, skill.description, skill.files["SKILL.md"] ?? "") };
}

/** Overwrites on every start so the shipped text always matches the running version. */
export async function installBuiltinSkills(dir: string): Promise<void> {
	for (const skill of BUILTIN_SKILLS) {
		for (const [file, content] of Object.entries(renderBuiltin(skill))) {
			const target = join(dir, skill.name, file);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content, "utf8");
		}
	}
}
