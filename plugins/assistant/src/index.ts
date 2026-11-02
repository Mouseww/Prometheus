import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import { type DelegationCard, delegate, type DelegateDeps } from "./delegate.ts";
import { type BriefingSettings, createBriefing, DEFAULT_BRIEFING, localDate, validTime } from "./briefing.ts";
import { createInbound, MAX_BODY } from "./inbound.ts";
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

		// What the app needs to tell the personal space from the work space: the home folder, and the main chat if it exists.
		// Unlike `main` this creates nothing, so asking is free.
		ctx.rpc("info", async () => {
			const saved = (await store.read()).sessionId;
			const alive = saved ? await ctx.sessionExists(saved) : false;
			return { home: home.dir, sessionId: alive ? saved : null };
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

		// Messages from outside (an IM bridge, a phone shortcut) arrive here. Same login as the rest of the server; the
		// run is read-only whatever the message says (see inbound.ts).
		const inbound = createInbound({ main: getMain, run: (o) => ctx.runAgent(o), now: () => Date.now() });
		ctx.route("POST", "/inbound", async (req, res) => {
			const send = (status: number, body: unknown) => {
				res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(JSON.stringify(body));
			};
			let raw = "";
			let size = 0;
			try {
				for await (const chunk of req) {
					size += (chunk as Buffer).length;
					if (size > MAX_BODY) return send(413, { ok: false, error: "body too large" });
					raw += chunk;
				}
			} catch {
				return send(400, { ok: false, error: "unreadable body" });
			}
			let body: unknown;
			try {
				body = JSON.parse(raw);
			} catch {
				return send(400, { ok: false, error: "body must be JSON" });
			}
			const r = await inbound(body);
			send(r.status, r.body);
		});

		// Daily briefing: off until the user asks for it (assistant_briefing); the text lands in notes/.
		const briefStore = createJsonStore<BriefingSettings>(join(ctx.dataDir, "briefing.json"), () => ({ ...DEFAULT_BRIEFING }));
		const tickBriefing = createBriefing({
			load: () => briefStore.read(),
			save: async (s) => void (await briefStore.update(() => s)),
			now: () => new Date(),
			run: (o) => ctx.runAgent(o),
			publish: async (date, text) => writeFileSync(join(home.notes, `简报-${date}.md`), `# 每日简报 ${date}

${text}
`),
			changed: () => ctx.notifyChanged(),
			log: (m) => ctx.log.warn(m),
			homeDir: home.dir,
		});
		const timer = setInterval(() => void tickBriefing().catch(() => {}), 60_000);
		timer.unref?.();
		ctx.onDispose(() => clearInterval(timer));
		void tickBriefing().catch(() => {});

		ctx.tools.register({
			name: "assistant_briefing",
			label: "助理：每日简报",
			description:
				"Turn the assistant's daily briefing on or off, change its time, or see its state. The briefing runs unattended and read-only at the set local time and is saved as a note in notes/. Only turn it on when the user asked for it.",
			promptSnippet: "assistant_briefing: set up the daily briefing (on/off/time/status)",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("enable"), Type.Literal("disable"), Type.Literal("status")]),
				time: Type.Optional(Type.String({ description: "Local time HH:MM, e.g. 08:30" })),
			}),
			async execute(_id, p) {
				const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
				const cur = await briefStore.read();
				if (p.action === "status") return reply(`Briefing is ${cur.enabled ? "on" : "off"}, at ${cur.time}${cur.lastDate ? `, last ran ${cur.lastDate}` : ""}.`);
				if (p.time !== undefined && !validTime(p.time)) return { ...reply("time must look like 08:30 (24-hour, local)."), isError: true };
				const next = { ...cur, enabled: p.action === "enable", time: p.time ?? cur.time };
				await briefStore.update(() => next);
				ctx.notifyChanged();
				return reply(next.enabled ? `Briefing on, every day at ${next.time}${next.lastDate === localDate(new Date()) ? " (today's has already run)" : ""}.` : "Briefing off.");
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
