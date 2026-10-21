import { join } from "node:path";
import { definePlugin } from "@prometheus/plugin-sdk";
import type { PromptProfile, PromptsState } from "./store.ts";
import { bodyOf, makeStore, newProfile, profileFor, sanitizeProfile, seedProfiles } from "./store.ts";

/** Section carrying the prompt text; tagged so a later turn replaces exactly this. */
const SECTION = "prompt_profile";

interface PromptEvent {
	systemPromptOptions: { customPrompt?: string; sections: Record<string, string> };
}

type Params = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idOrNull = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : str(v));

export default definePlugin({
	name: "prompts",
	version: "0.3.0",
	optional: true,
	setup(ctx) {
		const store = makeStore(join(ctx.dataDir, "prompts.json"));

		const read = async (): Promise<PromptsState> => {
			const current = await store.read();
			if (current.seeded === 3) return current;
			return store.update((s) => seedProfiles(s));
		};

		const changed = async (): Promise<void> => {
			ctx.notifyChanged();
			await ctx.reloadSessions();
		};

		// ---------- injection ----------

		ctx.extension((pi) => {
			pi.on("before_agent_start", async (event, ext) => {
				// The prompt follows this chat's own choice, else the workspace default. It has nothing
				// to do with the permission mode: which tools may run is the gate's decision alone.
				const state = await read();
				const profile = profileFor(state, ext?.sessionManager?.getSessionId());
				if (!profile) return;
				const text = bodyOf(profile)?.trim();
				if (!text) return;
				const opts = (event as PromptEvent).systemPromptOptions;
				if (profile.how === "append") opts.sections[`${SECTION}_extra`] = text;
				else opts.sections[SECTION] = text;
			});
		});

		// ---------- api ----------

		ctx.rpc("list", async () => {
			const state = await read();
			return {
				selected: state.selected,
				overrides: state.overrides,
				profiles: state.profiles.map((p) => ({ ...p, bodyLength: bodyOf(p)?.length ?? 0 })),
			};
		});

		ctx.rpc("get", async (p) => {
			const state = await read();
			const profile = pick(state, str(p.id));
			return { ...profile, body: bodyOf(profile) ?? "" };
		});

		ctx.rpc("save", async (p) => {
			const state = await read();
			const raw = (p.profile ?? {}) as Params;
			const prior = raw.id ? pick(state, str(raw.id)) : undefined;
			const next = sanitizeProfile(raw, prior);
			await store.update((s) => {
				const seeded = seedProfiles(s);
				return { ...seeded, profiles: [...seeded.profiles.filter((x) => x.id !== next.id), next] };
			});
			await changed();
			return { id: next.id };
		});

		ctx.rpc("create", async (p) => {
			const state = await read();
			const from = p.from ? pick(state, str(p.from)) : undefined;
			const draft = newProfile();
			const seed: PromptProfile = from
				? { ...draft, title: `${from.title} (copy)`, description: from.description, how: from.how, dropPersona: from.dropPersona, body: bodyOf(from) ?? "" }
				: draft;
			const next = sanitizeProfile({ ...seed, ...(p.profile as Params | undefined) }, seed);
			await store.update((s) => {
				const seeded = seedProfiles(s);
				return { ...seeded, profiles: [...seeded.profiles, next] };
			});
			await changed();
			return { id: next.id };
		});

		ctx.rpc("reset", async (p) => {
			const state = await read();
			const profile = pick(state, str(p.id));
			const bundled = SEED_FILES[profile.id] ?? profile.file;
			await store.update((s) => ({
				...s,
				profiles: s.profiles.map((x) => (x.id === profile.id ? { ...x, body: undefined, file: bundled, updatedAt: Date.now() } : x)),
			}));
			await changed();
			return { id: profile.id };
		});

		ctx.rpc("delete", async (p) => {
			const id = str(p.id);
			const state = await store.update((s) => {
				const seeded = seedProfiles(s);
				return {
					...seeded,
					profiles: seeded.profiles.filter((x) => x.id !== id),
					selected: seeded.selected === id ? null : seeded.selected,
					overrides: Object.fromEntries(Object.entries(seeded.overrides).filter(([, v]) => v !== id)),
				};
			});
			await changed();
			return { selected: state.selected };
		});

		/** The workspace default. Nothing is injected while this is null. */
		ctx.rpc("select", async (p) => {
			const id = idOrNull(p.id);
			await read();
			await store.update((s) => {
				const seeded = seedProfiles(s);
				if (id && !seeded.profiles.some((x) => x.id === id)) throw new Error("提示词不存在");
				return { ...seeded, selected: id };
			});
			await changed();
			return { selected: id };
		});

		/** One chat's own choice, overriding the workspace default without changing it. */
		ctx.rpc("override", async (p) => {
			const session = str(p.session);
			const id = idOrNull(p.id);
			if (!session) throw new Error("缺少会话 id");
			if (id) await read();
			await store.update((s) => {
				const seeded = seedProfiles(s);
				if (id && !seeded.profiles.some((x) => x.id === id)) throw new Error("提示词不存在");
				const overrides = { ...seeded.overrides };
				if (id) overrides[session] = id;
				else delete overrides[session];
				return { ...seeded, overrides };
			});
			await changed();
			return { session, id };
		});
	},
});

function pick(state: PromptsState, id: string): PromptProfile {
	const profile = state.profiles.find((p) => p.id === id);
	if (!profile) throw new Error("提示词不存在");
	return profile;
}

/** Shipped file per seeded id, so `reset` can restore the bundled text. */
const SEED_FILES: Record<string, string> = {
	"builtin-default": "default.en.md",
	"builtin-operator": "operator.en.md",
	"builtin-whitehat": "whitehat.en.md",
	"builtin-research": "research.en.md",
};
