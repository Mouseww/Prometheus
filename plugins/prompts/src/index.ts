
import { join } from "node:path";
import { definePlugin } from "@prometheus/plugin-sdk";
import type { ProfileSummary } from "@prometheus/protocol";
import type { PromptProfile, PromptsState } from "./store.ts";
import { bodyOf, makeStore, newProfile, profileFor, sanitizeProfile, seedProfiles } from "./store.ts";

/** Tagged section that carries the profile text: the model can match updates to it. */
const SECTION = "operator_prompt";

interface PromptEvent {
	systemPromptOptions: { customPrompt?: string; sections: Record<string, string> };
}

type Params = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const idOrNull = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : str(v));

export default definePlugin({
	name: "prompts",
	version: "0.1.0",
	// Ignored until a profile is selected, so an untouched install builds the unchanged prompt.
	optional: true,
	setup(ctx) {
		const store = makeStore(join(ctx.dataDir, "prompts.json"));

		const read = async (): Promise<PromptsState> => {
			const current = await store.read();
			if (current.seeded) return current;
			return store.update((s) => seedProfiles(s));
		};

		/** Settings can switch the whole feature off without touching the profile the panel picked. */
		const on = () => ctx.settings.enabled !== false;

		/** Live chats rebuild their prompt on the next turn. */
		const changed = async (): Promise<void> => {
			ctx.notifyChanged();
			await ctx.reloadSessions();
		};

		// ---------- injection ----------

		ctx.extension((pi) => {
			pi.on("before_agent_start", async (event, ext) => {
				if (!on()) return;
				const state = await read();
				const sessionId = ext?.sessionManager?.getSessionId();
				const profile = profileFor(state, sessionId);
				if (!profile) return;
				const text = bodyOf(profile)?.trim();
				if (!text) return;
				const opts = (event as PromptEvent).systemPromptOptions;
				if (profile.mode === "append") opts.sections[`${SECTION}_extra`] = text;
				else opts.sections[SECTION] = text;
			});
		});

		// ---------- api ----------

		ctx.rpc("list", async (): Promise<{ enabled: boolean; active: string | null; profiles: ProfileSummary[] }> => {
			const state = await read();
			const profiles = state.profiles.map<ProfileSummary>((p) => ({
				id: p.id,
				title: p.title,
				description: p.description,
				source: p.source,
				file: p.file,
				enabled: p.enabled,
				mode: p.mode,
				dropPersona: p.dropPersona,
				updatedAt: p.updatedAt,
				bodyLength: bodyOf(p)?.length ?? 0,
			}));
			return { enabled: on(), active: state.active, profiles };
		});

		ctx.rpc("get", async (p): Promise<PromptProfile & { body: string }> => {
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
				? {
						...draft,
						title: `${from.title} (copy)`,
						description: from.description,
						mode: from.mode,
						base: from.base,
						body: bodyOf(from) ?? "",
					}
				: draft;
			const next = sanitizeProfile({ ...seed, ...(p.profile as Params | undefined) }, seed);
			await store.update((s) => {
				const seeded = seedProfiles(s);
				return { ...seeded, profiles: [...seeded.profiles, next] };
			});
			await changed();
			return { id: next.id };
		});

		ctx.rpc("delete", async (p) => {
			const id = str(p.id);
			const state = await store.update((s) => {
				const seeded = seedProfiles(s);
				return {
					...seeded,
					profiles: seeded.profiles.filter((x) => x.id !== id),
					active: seeded.active === id ? null : seeded.active,
					overrides: Object.fromEntries(Object.entries(seeded.overrides).filter(([, v]) => v !== id)),
				};
			});
			await changed();
			return { active: state.active };
		});

		ctx.rpc("activate", async (p) => {
			const id = idOrNull(p.id);
			await read(); // seed the shipped profiles before validating against them
			await store.update((s) => {
				const seeded = seedProfiles(s);
				if (id && !seeded.profiles.some((x) => x.id === id)) throw new Error("配置不存在");
				return { ...seeded, active: id };
			});
			await changed();
			return { active: id };
		});

		/** Per-chat override; the workspace default stays whatever the panel picked. */
		ctx.rpc("override", async (p) => {
			const session = str(p.session);
			const id = idOrNull(p.id);
			if (!session) throw new Error("缺少会话 id");
			if (id) await read();
			await store.update((s) => {
				const seeded = seedProfiles(s);
				if (id && !seeded.profiles.some((x) => x.id === id)) throw new Error("配置不存在");
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
	if (!profile) throw new Error("配置不存在");
	return profile;
}

export { SECTION };
