import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { INSTALL_PLUGIN_TOOL } from "./permissions.ts";
import type { PluginHost } from "./plugin-host.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

const GUIDE = `Create or update a Prometheus plugin from inside the app and load it without restarting.

A plugin is a folder of ES-module files. The entry is index.js and must default-export an object:
  export default { name: "my-plugin", version: "0.1.0", setup(ctx) { ... } }
The name must match the "name" argument (lowercase letters, digits, - _ .). Plugins cannot import npm packages or Prometheus modules, only Node built-ins ("node:fs", "node:path", "node:child_process", ...) and relative files of their own.

ctx gives you: ctx.extension((pi) => { pi.registerTool({ name, label, description, parameters: <JSON Schema object>, async execute(toolCallId, params, signal, onUpdate, toolCtx) { return { content: [{ type: "text", text: "..." }], details: {} }; } }); pi.registerCommand(name, { description, handler }); pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "..." })); }), ctx.rpc(method, async (params) => value) for the app UI, ctx.route(method, path, (req, res) => ...) and ctx.panel({ id, title, path }) for a sidebar page served from a route, ctx.dataDir (private folder), ctx.cwd, ctx.log, ctx.onDispose(fn) (release timers and sockets here: the plugin can be reloaded at any time).

Parameters are plain JSON Schema, e.g. { type: "object", properties: { city: { type: "string" } }, required: ["city"] }.

The user is shown every file and must approve before anything is written. The plugin runs with the full permissions of the app, so keep it small, do not touch files you were not asked to, and never read secrets. Install again with the same name to update it; if the new version fails to load the old one is kept.

In a chat that is running, new tools appear from the next message on.`;

/** Lets the agent write a plugin into the app. Only the server host registers it; the TUI cannot hot-load. */
export function pluginBuilderExtension(plugins: PluginHost): InlineExtension {
	return {
		name: "prometheus:plugin-builder",
		factory: (pi) => {
			pi.registerTool({
				name: INSTALL_PLUGIN_TOOL,
				label: "安装插件",
				description: GUIDE,
				promptSnippet: `${INSTALL_PLUGIN_TOOL}: write a Prometheus plugin (tools, commands, panels) into the app and load it live`,
				parameters: Type.Object({
					name: Type.String({ description: "Plugin name, lowercase letters/digits/-/_/." }),
					version: Type.Optional(Type.String()),
					files: Type.Array(Type.Object({ path: Type.String({ description: "Relative path, forward slashes, e.g. index.js" }), content: Type.String() }), { minItems: 1 }),
				}),
				async execute(_id, params) {
					const result = await plugins.install({ name: params.name, version: params.version, files: params.files });
					const lines = [`${result.updated ? "Updated" : "Installed"} plugin "${result.plugin.name}" (${result.plugin.id}).`, `Hot-loaded: ${result.hot ? "yes" : "no"}.`];
					if (result.plugin.panels.length) lines.push(`Sidebar panels: ${result.plugin.panels.map((p) => p.title).join(", ")}.`);
					if (result.restartReasons.length) lines.push(`Tell the user: ${result.restartReasons.join(" ")}`);
					else lines.push("Its tools and commands become available to this chat from the next message; no restart is needed.");
					return text(lines.join("\n"));
				},
			});
		},
	};
}
