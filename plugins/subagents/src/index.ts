import { definePlugin } from "@prometheus/plugin-sdk";
import { AgentStore, cliAvailable, PI_CHILD_TOOLS } from "@prometheus/subagents";

type Params = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Subagents: configure the agents the `subagent` tool can delegate to.
 *
 * The runtime lives in @prometheus/subagents and is started by the host with every chat; this plugin
 * is the editor for the agent definitions: description, prompt, prompt mode, model, tools, context
 * and which runner executes the agent (PI itself, Claude Code or Codex).
 */
export default definePlugin({
	name: "subagents",
	version: "0.1.0",
	optional: true,
	setup(ctx) {
		const store = new AgentStore(ctx.agentDir);

		/** The runtime reads definitions each time it launches an agent, so no reload is needed. */
		const changed = async (): Promise<void> => ctx.notifyChanged();

		ctx.rpc("list", async () => ({
			clis: { "claude-code": cliAvailable("claude-code"), codex: cliAvailable("codex") },
			agents: (await store.list()).map(({ prompt, ...rest }) => ({ ...rest, promptLength: prompt.length })),
		}));

		ctx.rpc("get", async (p: Params) => store.get(str(p.name)));

		ctx.rpc("tools", async () => ({ known: PI_CHILD_TOOLS }));

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
