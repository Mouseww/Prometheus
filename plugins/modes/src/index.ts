import { join } from "node:path";
import { definePlugin } from "@prometheus/plugin-sdk";
import type { AgentMode, ModesState } from "./store.ts";
import { allowedTools, bodyOf, makeStore, modeFor, newMode, sanitizeMode, seedModes } from "./store.ts";
import { knownTools } from "./tools.ts";

/** Section carrying the mode's prompt text; tagged so a later turn replaces exactly this. */
const SECTION = "agent_mode";

interface PromptEvent {
	systemPromptOptions: { customPrompt?: string; sections: Record<string, string> };
}

type Params = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idOrNull = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : str(v));

export default definePlugin({
	name: "modes",
	version: "0.4.0",
	optional: true,
	setup(ctx) {
		const store = makeStore(join(ctx.dataDir, "modes.json"));

		const read = async (): Promise<ModesState> => {
			const current = await store.read();
			if (current.seeded === 4) return current;
			return store.update((s) => seedModes(s));
		};

		const changed = async (): Promise<void> => {
			ctx.notifyChanged();
			await ctx.reloadSessions();
		};

		// ---------- applying a mode: prompt + tools ----------

		ctx.extension((pi) => {
			/** What the host offered before the mode narrowed it, so switching back restores everything. */
			let hostTools: string[] | null = null;

			const currentMode = async (sessionId: string | undefined) => {
				const state = await read();
				return modeFor(state, sessionId);
			};

			const applyTools = (mode: AgentMode | undefined) => {
				hostTools ??= pi.getActiveTools();
				const next = allowedTools(mode, hostTools);
				// Re-applying the same set is a no-op; PI would otherwise re-declare the tool catalog
				// every turn, which costs a cache miss for nothing.
				const now = pi.getActiveTools();
				if (next.length === now.length && next.every((n, i) => n === now[i])) return;
				pi.setActiveTools(next);
			};

			// Tools must be settled before the run starts, and a reload resets them to the host default.
			pi.on("session_start", async (_event, ext) => {
				hostTools = null;
				applyTools(await currentMode(ext?.sessionManager?.getSessionId()));
			});

			pi.on("before_agent_start", async (event, ext) => {
				const mode = await currentMode(ext?.sessionManager?.getSessionId());
				applyTools(mode);
				if (!mode) return;
				const text = bodyOf(mode)?.trim();
				if (!text) return;
				const opts = (event as PromptEvent).systemPromptOptions;
				if (mode.how === "append") opts.sections[`${SECTION}_extra`] = text;
				else opts.sections[SECTION] = text;
			});
		});

		// ---------- api ----------

		ctx.rpc("list", async () => {
			const state = await read();
			return {
				selected: state.selected,
				overrides: state.overrides,
				modes: state.modes.map((m) => ({ ...m, bodyLength: bodyOf(m)?.length ?? 0 })),
			};
		});

		ctx.rpc("get", async (p) => {
			const state = await read();
			const mode = pick(state, str(p.id));
			return { ...mode, body: bodyOf(mode) ?? "" };
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
			await changed();
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
						how: from.how,
						dropPersona: from.dropPersona,
						tools: [...from.tools],
						body: bodyOf(from) ?? "",
					}
				: draft;
			const next = sanitizeMode({ ...seed, ...(p.mode as Params | undefined) }, seed);
			await store.update((s) => {
				const seeded = seedModes(s);
				return { ...seeded, modes: [...seeded.modes, next] };
			});
			await changed();
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
			await changed();
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
			await changed();
			return { selected: state.selected };
		});

		/** The workspace default. Nothing is applied while this is null. */
		ctx.rpc("select", async (p) => {
			const id = idOrNull(p.id);
			await read();
			await store.update((s) => {
				const seeded = seedModes(s);
				if (id && !seeded.modes.some((x) => x.id === id)) throw new Error("模式不存在");
				return { ...seeded, selected: id };
			});
			await changed();
			return { selected: id };
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
			await changed();
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

/** Shipped file per seeded id, so `reset` can restore the bundled text. */
const SEED_FILES: Record<string, string> = {
	"builtin-default": "default.en.md",
	"builtin-operator": "operator.en.md",
	"builtin-whitehat": "whitehat.en.md",
	"builtin-research": "research.en.md",
};
