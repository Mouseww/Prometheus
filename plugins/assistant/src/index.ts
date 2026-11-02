import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import { type DelegationCard, delegate, type DelegateDeps } from "./delegate.ts";
import { ensureHome, listNotes, notesIndex, readPersona, sameDir } from "./home.ts";
import { mainThread } from "./main-thread.ts";

const NAME = "assistant";

export default definePlugin({
	name: NAME,
	version: "0.1.0",
	// Switching it off removes the sidebar entry and the tools; the files in its folder stay.
	optional: true,
	async setup(ctx) {
		// It needs the in-process session host (openSession / runAgent); the terminal build has none.
		if (ctx.host !== "server") return;

		const home = ensureHome(ctx.dataDir);
		const store = createJsonStore<{ sessionId?: string }>(join(ctx.dataDir, "main.json"), () => ({}));

		const getMain = mainThread({
			read: () => store.read(),
			write: async (s) => void (await store.update(() => s)),
			exists: (id) => ctx.sessionExists(id),
			create: () => ctx.openSession({ cwd: home.dir, name: "个人助理", workspaceName: "个人助理" }),
		});

		// What the chat the user opens from the sidebar is: one long conversation, always the same one.
		ctx.rpc("main", async () => {
			const { sessionId, created } = await getMain();
			if (created) ctx.notifyChanged();
			return { sessionId, home: home.dir };
		});

		const delegateDeps: DelegateDeps = {
			homeDir: home.dir,
			workspaces: () => ctx.workspaces(),
			runAgent: (o) => ctx.runAgent(o),
		};

		ctx.tools.register({
			name: "assistant_projects",
			label: "助理：项目列表",
			description: "List the user's project folders (name and id) that work can be handed to with assistant_delegate. Use it when you are working in your own home and a task concerns a project.",
			promptSnippet: "assistant_projects: list the projects work can be delegated to",
			// Reads only; the delegated run is capped by the host at what this chat may do, so the gate can treat both tools as reads.
			annotations: { readOnlyHint: true },
			parameters: Type.Object({}),
			async execute() {
				const list = (await ctx.workspaces()).filter((w) => !sameDir(w.path, home.dir));
				const text = list.map((w) => `- ${w.name}  (id: ${w.id})`).join("\n") || "No projects yet.";
				return { content: [{ type: "text" as const, text }], details: {} };
			},
		});

		ctx.tools.register({
			name: "assistant_delegate",
			label: "助理：派活到项目",
			description:
				"Hand one clearly described task to a project folder: a separate agent run starts there, does the work and returns its report. Only usable from your own home. The run can never do more than this chat is allowed to; ask for 'edits' only when the user wants files changed.",
			promptSnippet: "assistant_delegate: run a task inside one of the user's projects and get its report",
			annotations: { readOnlyHint: true },
			parameters: Type.Object({
				project: Type.String({ description: "Project name or id from assistant_projects" }),
				task: Type.String({ description: "What to do, how far to go, and what result to bring back" }),
				access: Type.Optional(Type.Union([Type.Literal("readonly"), Type.Literal("edits")])),
			}),
			async execute(_id, params, signal, _onUpdate, tctx) {
				const r = await delegate(delegateDeps, { cwd: tctx.cwd, sessionId: tctx.sessionId, signal }, params);
				const card: DelegationCard = r.card;
				return { content: [{ type: "text" as const, text: r.text }], details: { delegation: card }, ...(card.status === "refused" ? { isError: true } : {}) };
			},
		});

		ctx.context.provide(async (req) => {
			if (!sameDir(req.cwd, home.dir)) return undefined;
			const persona = readPersona(home);
			const index = notesIndex(listNotes(home));
			return {
				...(persona ? { static: { sections: { personal_assistant: persona } } } : {}),
				...(index ? { turn: index } : {}),
			};
		});
	},
});
