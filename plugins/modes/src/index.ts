import { join } from "node:path";
import { definePlugin } from "@prometheus/plugin-sdk";
import type { AgentMode, LastCut, ModesState } from "./store.ts";
import { allowedTools, bodyOf, composeSystemPrompt, makeStore, modeFor, newMode, sanitizeMode, seedModes } from "./store.ts";
import { knownTools } from "./tools.ts";

type Params = Record<string, unknown>;

interface PromptEvent {
	systemPrompt: string;
	systemPromptOptions: { cwd?: string; sections: Record<string, string> };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idOrNull = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : str(v));
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * Modes: a named system prompt plus the tool set it may reach.
 *
 * Switching is deliberately cheap. Changing *which mode* a chat uses never reloads anything: the
 * extension reads the stored state at the start of every run, so the next message already runs
 * under the new mode. Only editing a mode's text or tools touches the live chats, and even then
 * nothing is reloaded while a chat is generating — it picks the change up on its next run.
 */
export default definePlugin({
	name: "modes",
	version: "0.6.0",
	optional: true,
	setup(ctx) {
		const store = makeStore(join(ctx.dataDir, "modes.json"));

		const read = async (): Promise<ModesState> => {
			const current = await store.read();
			if (current.seeded === SEED_VERSION) return current;
			return store.update((s) => seedModes(s));
		};

		/** Applied state per live session, so a chat can report what is actually in effect. */
		const applied = new Map<string, { modeId: string | null; cut: LastCut }>();

		ctx.extension((pi) => {
			/** What the host offered before a mode narrowed it, so switching back restores everything. */
			let hostTools: string[] | null = null;

			const applyTools = (mode: AgentMode | undefined) => {
				hostTools ??= pi.getActiveTools();
				const next = allowedTools(mode, hostTools);
				// Re-applying the same set is a no-op; PI would otherwise re-declare the tool catalog
				// every turn, which costs a cache miss for nothing.
				if (same(next, pi.getActiveTools())) return;
				pi.setActiveTools(next);
			};

			// A reload rebuilds the registry, so the host baseline has to be recorded again.
			pi.on("session_start", async (_event, ext) => {
				hostTools = null;
				const id = ext?.sessionManager?.getSessionId();
				if (id) applied.delete(id);
				applyTools(await currentMode(ext?.sessionManager?.getSessionId()));
			});

			const currentMode = async (sessionId: string | undefined) => modeFor(await read(), sessionId);

			pi.on("before_agent_start", async (event, ext) => {
				const sessionId = ext?.sessionManager?.getSessionId();
				const mode = await currentMode(sessionId);
				applyTools(mode);
				const body = mode ? bodyOf(mode)?.trim() : undefined;
				if (!mode || !body) {
					if (sessionId) applied.delete(sessionId);
					return;
				}
				// A `replace`/`strict` mode has to cut the host preamble, and sections can only be added
				// or overwritten — never dropped — so the whole rendered prompt is the input. The event's
				// getter already folds in whatever earlier extensions asked for.
				const opts = (event as PromptEvent).systemPromptOptions;
				const { text, cut } = composeSystemPrompt(mode, body, (event as PromptEvent).systemPrompt ?? "", str(opts.cwd) || ctx.cwd);
				// Returning `systemPrompt` is the only way to put this text at the head of the request;
				// writing it as a section instead would leave the original prompt in front of it.
				if (sessionId) applied.set(sessionId, { modeId: mode.id, cut });
				return { systemPrompt: text };
			});
		});

		// ---------- api ----------

		/** Nothing to reload: every chat reads this state at the start of its next run. */
		const changed = (): void => ctx.notifyChanged();

		ctx.rpc("list", async () => {
			const state = await read();
			return {
				selected: state.selected,
				overrides: state.overrides,
				defaultEnabled: state.defaultEnabled === true,
				modes: state.modes.map((m) => ({ ...m, bodyLength: bodyOf(m)?.length ?? 0 })),
			};
		});

		ctx.rpc("get", async (p) => {
			const state = await read();
			const mode = pick(state, str(p.id));
			return { ...mode, body: bodyOf(mode) ?? "" };
		});

		/** What a session is running right now: its own pick, else the workspace default. */
		ctx.rpc("effective", async (p) => {
			const state = await read();
			const session = str(p.session);
			const mode = modeFor(state, session || undefined);
			const source = !mode ? "none" : session && state.overrides[session] === mode.id ? "session" : "workspace";
			return { id: mode?.id ?? null, title: mode?.title ?? null, compose: mode?.compose ?? null, source, applied: applied.get(session) ?? null };
		});

		ctx.rpc("save", async (p) => {
			const state = await read();
			const raw = (p.mode ?? {}) as Params;
			const prior = raw.id ? pick(state, str(raw.id)) : undefined;
			const next = sanitizeMode(raw, prior);
			await store.update((s) => {
				const seeded = seedModes(s);
				return { ...seeded, modes: [...seeded.modes.filter((x) => x.id !== next.id), next] };
			});
			changed();
			return { id: next.id };
		});

		ctx.rpc("create", async (p) => {
			const state = await read();
			const from = p.from ? pick(state, str(p.from)) : undefined;
			const draft = newMode();
			const seed: AgentMode = from
				? {
						...draft,
						title: `${from.title} (copy)`,
						description: from.description,
						compose: from.compose,
						tools: [...from.tools],
						body: bodyOf(from) ?? "",
					}
				: draft;
			const next = sanitizeMode({ ...seed, ...(p.mode as Params | undefined) }, seed);
			await store.update((s) => {
				const seeded = seedModes(s);
				return { ...seeded, modes: [...seeded.modes, next] };
			});
			changed();
			return { id: next.id };
		});

		ctx.rpc("reset", async (p) => {
			const state = await read();
			const mode = pick(state, str(p.id));
			const bundled = SEED_FILES[mode.id] ?? mode.file;
			await store.update((s) => ({
				...s,
				modes: s.modes.map((x) => (x.id === mode.id ? { ...x, body: undefined, file: bundled, updatedAt: Date.now() } : x)),
			}));
			changed();
			return { id: mode.id };
		});

		ctx.rpc("delete", async (p) => {
			const id = str(p.id);
			const state = await store.update((s) => {
				const seeded = seedModes(s);
				return {
					...seeded,
					modes: seeded.modes.filter((x) => x.id !== id),
					selected: seeded.selected === id ? null : seeded.selected,
					overrides: Object.fromEntries(Object.entries(seeded.overrides).filter(([, v]) => v !== id)),
				};
			});
			changed();
			return { selected: state.selected };
		});

		/** The workspace default. Nothing is applied while this is null. */
		ctx.rpc("select", async (p) => {
			const id = idOrNull(p.id);
			await read();
			await store.update((s) => {
				const seeded = seedModes(s);
				if (id && !seeded.modes.some((x) => x.id === id)) throw new Error("模式不存在");
				// Choosing a mode by hand is also the user saying "start here", so it switches the
				// default on instead of leaving a selection that a new chat would silently ignore.
				return { ...seeded, selected: id, defaultEnabled: id ? true : seeded.defaultEnabled };
			});
			changed();
			return { selected: id };
		});

		/** The mode a *new* chat starts in. Off means a fresh chat runs on the host prompt. */
		ctx.rpc("default", async (p) => {
			const on = p.enabled === true;
			await store.update((s) => ({ ...seedModes(s), defaultEnabled: on }));
			changed();
			return { enabled: on };
		});

		/** One chat's own mode, overriding the workspace default without changing it. */
		ctx.rpc("override", async (p) => {
			const session = str(p.session);
			const id = idOrNull(p.id);
			if (!session) throw new Error("缺少会话 id");
			if (id) await read();
			await store.update((s) => {
				const seeded = seedModes(s);
				if (id && !seeded.modes.some((x) => x.id === id)) throw new Error("模式不存在");
				const overrides = { ...seeded.overrides };
				if (id) overrides[session] = id;
				else delete overrides[session];
				return { ...seeded, overrides };
			});
			changed();
			return { session, id };
		});

		/** The tool names a mode may name, so the editor picks from real ones instead of guesses. */
		ctx.rpc("tools", async () => ({ known: knownTools() }));

	},
});

function pick(state: ModesState, id: string): AgentMode {
	const mode = state.modes.find((m) => m.id === id);
	if (!mode) throw new Error("模式不存在");
	return mode;
}

const SEED_VERSION = 5;

/** Shipped file per seeded id, so `reset` can restore the bundled text. */
const SEED_FILES: Record<string, string> = {
	"builtin-default": "default.en.md",
	"builtin-operator": "operator.en.md",
	"builtin-whitehat": "whitehat.en.md",
	"builtin-purge": "purge.en.md",
	"builtin-research": "research.en.md",
};
