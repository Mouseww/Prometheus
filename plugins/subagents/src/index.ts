import { definePlugin } from "@prometheus/plugin-sdk";
import { AgentStore } from "./agents.ts";

type Params = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Tools a child agent can be limited to. Plugin tools only reach a child that also loads their provider. */
const CHILD_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor", "web_search", "fetch_content", "get_search_content", "source_check", "knowledge_search", "memory_search", "todo_write", "subagent"];

/**
 * Subagents: configure the agents the `subagent` tool can delegate to.
 *
 * The runtime is the pi-subagents PI package (installed from the PI Marketplace); this plugin is the
 * editor for its agent definitions — description, prompt, prompt mode, model, tools and how much
 * context a child is given. Definitions are stored in pi-subagents' own formats (markdown files and
 * `settings.json` overrides), so the PI TUI sees exactly the same agents.
 */
export default definePlugin({
	name: "subagents",
	version: "0.1.0",
	optional: true,
	setup(ctx) {
		const store = new AgentStore(ctx.agentDir);

		/** pi-subagents reads definitions when a session starts, so live chats pick edits up after a reload. */
		const changed = async (): Promise<void> => {
			ctx.notifyChanged();
			await ctx.reloadSessions().catch((err) => ctx.log.warn(`reload after subagent change failed: ${String(err)}`));
		};

		ctx.rpc("list", async () => ({
			installed: await store.packageInstalled(),
			defaultModel: await store.getDefaultModel(),
			agents: (await store.list()).map(({ prompt, ...rest }) => ({ ...rest, promptLength: prompt.length })),
		}));

		ctx.rpc("setDefaultModel", async (p: Params) => {
			const model = str(p.model).slice(0, 200);
			await store.setDefaultModel(model);
			await changed();
			return { model };
		});

		ctx.rpc("get", async (p: Params) => store.get(str(p.name)));

		ctx.rpc("tools", async () => ({ known: CHILD_TOOLS }));

		ctx.rpc("create", async (p: Params) => {
			const name = str(p.name);
			await store.create(name, p.agent ?? { description: "", prompt: "" });
			await changed();
			return { name };
		});

		ctx.rpc("save", async (p: Params) => {
			const name = str(p.name);
			await store.save(name, p.agent);
			await changed();
			return { name };
		});

		ctx.rpc("disable", async (p: Params) => {
			await store.setDisabled(str(p.name), p.disabled === true);
			await changed();
			return null;
		});

		ctx.rpc("reset", async (p: Params) => {
			await store.reset(str(p.name));
			await changed();
			return null;
		});

		ctx.rpc("delete", async (p: Params) => {
			await store.remove(str(p.name));
			await changed();
			return null;
		});
	},
});
