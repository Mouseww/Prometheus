import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { type ContextContribution, createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import { type DelegationCard, delegate, type DelegateDeps, type LiveRun, waitOn } from "./delegate.ts";
import { type BriefingSettings, createBriefing, DEFAULT_BRIEFING, localDate, validTime } from "./briefing.ts";
import { createAsk } from "./ask.ts";
import { createInbound, MAX_BODY } from "./inbound.ts";
import { ensureHome, listNotes, notesIndex, readPersona, sameDir } from "./home.ts";
import { mainThread } from "./main-thread.ts";

const NAME = "assistant";

const DELEGATED_RUN = `# Delegated run
The assistant handed you this task on the user's behalf. Go straight to it: read the files the task names or points to instead of searching the whole project, and use no tool the task does not need (no browser, no web search unless asked). Finish with a short report.
One exception to "do not ask questions": if you cannot tell what the user wants and a wrong guess would waste the work, call assistant_ask once with a clear question (and short options when it is a choice). The assistant answers from what the user said. Do not ask about things you can decide or look up; decide and state the assumption.`;

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
			return { home: home.dir, sessionId: alive ? saved : null, delegated: [...delegations.keys()], pending: asker.pending() };
		});

		const briefStore = createJsonStore<BriefingSettings>(join(ctx.dataDir, "briefing.json"), () => ({ ...DEFAULT_BRIEFING }));

		// The personal home page: the newest briefing note (if any) and the briefing's settings.
		ctx.rpc("overview", async () => {
			const note = listNotes(home, 200).find((n) => /^简报-.+\.md$/.test(n.name));
			let briefing: { name: string; text: string } | null = null;
			if (note) {
				try {
					briefing = { name: note.name, text: readFileSync(join(home.notes, note.name), "utf8").slice(0, 4000) };
				} catch {
					// removed since listing
				}
			}
			return { briefing, settings: await briefStore.read() };
		});

		// Which sessions the assistant delegated, and to which project: the app marks them and the home page lists them
		// from this, not from the session's name (which the user may change).
		const delegStore = createJsonStore<{ list: { sessionId: string; project: string; at: number }[] }>(join(ctx.dataDir, "delegations.json"), () => ({ list: [] }));
		const delegations = new Map<string, string>();
		void delegStore.read().then((d) => {
			for (const e of d.list) delegations.set(e.sessionId, e.project);
		});

		const live = new Map<string, LiveRun>();
		const asker = createAsk({
			delegated: (id) => delegations.has(id),
			changed: () => ctx.notifyChanged(),
			now: () => Date.now(),
			// A run waiting for an answer does not use up its time budget.
			waiting: (id, w) => (w ? live.get(id)?.budget.pause() : live.get(id)?.budget.resume()),
		});
		ctx.rpc("answer", async (params) => {
			const p = (params ?? {}) as { id?: string; text?: string };
			return { ok: asker.answer(String(p.id ?? ""), String(p.text ?? "")) };
		});

		ctx.tools.register({
			name: "assistant_ask",
			label: "助理：向用户提问",
			description:
				"Only inside a run the assistant delegated: ask the user one question and wait for the answer. Use it when you cannot tell what they want and a wrong guess would waste the work; do not use it for things you can decide or look up. Offer short options when the answer is a choice. If the user does not answer in time the call fails: then decide yourself and say what you assumed.",
			promptSnippet: "assistant_ask: ask the user one question and wait (delegated runs only; do not guess when unsure)",
			// Asking changes nothing, so a read-only run may ask too.
			annotations: { readOnlyHint: true },
			parameters: Type.Object({
				question: Type.String({ description: "One clear question" }),
				options: Type.Optional(Type.Array(Type.String(), { description: "Up to 6 short choices; the user may also type something else" })),
			}),
			async execute(_id, p, signal, _onUpdate, tctx) {
				const r = await asker.ask(tctx.sessionId, p.question, p.options, signal);
				return r.ok ? { content: [{ type: "text" as const, text: `The user answered: ${r.answer}` }], details: {} } : { content: [{ type: "text" as const, text: r.reason }], details: {}, isError: true };
			},
		});

		const outcomeResult = (r: { text: string; card: DelegationCard }) => ({
			content: [{ type: "text" as const, text: r.text }],
			details: { delegation: r.card },
			...(r.card.status === "refused" ? { isError: true } : {}),
		});

		ctx.tools.register({
			name: "assistant_wait",
			label: "助理：继续等待委派结果",
			description: "Keep waiting for a delegated run that is still going (assistant_delegate told you so). Returns its result, or its next question.",
			promptSnippet: "assistant_wait: keep waiting for a delegated run by session id",
			annotations: { readOnlyHint: true },
			parameters: Type.Object({ session: Type.String({ description: "Session id from assistant_delegate" }) }),
			async execute(_id, p, signal, _u, tctx) {
				if (!sameDir(tctx.cwd, home.dir)) return { ...outcomeResult({ text: "Only usable from the assistant's own home.", card: { project: "", status: "refused", requested: "readonly", access: "readonly" } }) };
				return outcomeResult(await waitOn(delegateDeps, String(p.session ?? ""), signal));
			},
		});

		ctx.tools.register({
			name: "assistant_reply",
			label: "助理：回答委派运行的提问",
			description:
				"Answer the question a delegated run is waiting on (assistant_delegate or assistant_wait returned it), then wait for the run's result or its next question. Answer from what the user asked and what you know of them; if that does not settle it, ask the user in chat first and pass their answer.",
			promptSnippet: "assistant_reply: answer a delegated run's question, then keep waiting",
			annotations: { readOnlyHint: true },
			parameters: Type.Object({ session: Type.String({ description: "Session id of the run that asked" }), answer: Type.String({ description: "The answer" }) }),
			async execute(_id, p, signal, _u, tctx) {
				const bad = (text: string) => outcomeResult({ text, card: { project: "", status: "refused", requested: "readonly", access: "readonly" } });
				if (!sameDir(tctx.cwd, home.dir)) return bad("Only usable from the assistant's own home.");
				const sid = String(p.session ?? "");
				const q = asker.pending().find((x) => x.sessionId === sid);
				if (!q) return bad(`Session ${sid} has no open question (the user may have answered it already, or it timed out). Use assistant_wait to see how the run is doing.`);
				if (!asker.answer(q.id, String(p.answer ?? ""))) return bad("Write the answer.");
				return outcomeResult(await waitOn(delegateDeps, sid, signal));
			},
		});

		const delegateDeps: DelegateDeps = {
			live,
			nextQuestion: (id, signal) => asker.next(id, signal),
			delegatedProject: (id) => delegations.get(id),
			started: (id, project) => {
				if (delegations.has(id)) return;
				delegations.set(id, project);
				void delegStore.update((d) => ({ list: [...d.list, { sessionId: id, project, at: Date.now() }].slice(-300) })).then(() => ctx.notifyChanged());
			},
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
				"Hand one clearly described task to a project folder: a separate agent run starts there, does the work and returns its report. Only usable from your own home. The run can never do more than this chat is allowed to; ask for 'edits' only when the user wants files changed. Give the task everything the run needs (paths, the user's preferences and decisions) so it does not have to ask. If the run does ask something, the result is its question: answer it with assistant_reply.",
			promptSnippet: "assistant_delegate: run a task inside one of the user's projects and get its report",
			annotations: { readOnlyHint: true },
			parameters: Type.Object({
				project: Type.String({ description: "Project name or id from assistant_projects" }),
				task: Type.String({ description: "What to do, how far to go, and what result to bring back" }),
				access: Type.Optional(Type.Union([Type.Literal("readonly"), Type.Literal("edits")])),
				continue_session: Type.Optional(Type.String({ description: "Session id returned by an earlier delegation to the same project. Use it when the new task is more of the same work, so it goes back into that session instead of piling up a new one. Leave out for unrelated work." })),
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

		ctx.context.provide(async (req): Promise<ContextContribution | undefined> => {
			if (req.sessionId && delegations.has(req.sessionId)) return { static: { sections: { delegated_run: DELEGATED_RUN } } };
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
