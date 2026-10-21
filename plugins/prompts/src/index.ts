import { join } from "node:path";
import type { PermissionMode } from "@prometheus/protocol";
import { definePlugin } from "@prometheus/plugin-sdk";
import { bodyOf, makeStore, newProfile, promptFor, sanitizeProfile, seedProfiles, type PromptProfile, type PromptsState } from "./store.ts";

/** Section carrying the prompt text; tagged so a later turn can replace exactly this. */
const SECTION = "mode_prompt";

interface PromptEvent {
	systemPromptOptions: { customPrompt?: string; sections: Record<string, string> };
}

type Params = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export default definePlugin({
	name: "prompts",
	version: "0.2.0",
	optional: true,
	setup(ctx) {
		const store = makeStore(join(ctx.dataDir, "prompts.json"));

		const read = async (): Promise<PromptsState> => {
			const current = await store.read();
			if (current.seeded) return current;
			return store.update((s) => seedProfiles(s));
		};

		const changed = async (): Promise<void> => {
			ctx.notifyChanged();
			await ctx.reloadSessions();
		};

		// ---------- injection: the prompt follows the session's permission mode ----------

		ctx.extension((pi) => {
			pi.on("before_agent_start", async (event, ext) => {
				const sessionId = ext?.sessionManager?.getSessionId();
				const mode = (ctx.permissionMode?.(sessionId) ?? "default") as PermissionMode;
				const state = await read();
				const profile = promptFor(state, mode);
				if (!profile) return;
				const text = bodyOf(profile)?.trim();
				if (!text) return;
				const opts = (event as PromptEvent).systemPromptOptions;
				if (profile.how === "append") opts.sections[`${SECTION}_extra`] = text;
				else opts.sections[SECTION] = text;
			});
		});

		// ---------- api ----------

		ctx.rpc("list", async (): Promise<{ profiles: (PromptProfile & { bodyLength: number })[] }> => {
			const state = await read();
			return {
				profiles: state.profiles.map((p) => ({ ...p, bodyLength: bodyOf(p)?.length ?? 0 })),
			};
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
				// Enabling a prompt switches off any sibling for the same mode: one prompt per mode.
				const profiles = next.enabled
					? seeded.profiles.map((x) => (x.mode === next.mode && x.id !== next.id ? { ...x, enabled: false } : x))
					: seeded.profiles;
				return { ...seeded, profiles: [...profiles.filter((x) => x.id !== next.id), next] };
			});
			await changed();
			return { id: next.id };
		});

		ctx.rpc("reset", async (p) => {
			const state = await read();
			const profile = pick(state, str(p.id));
			// Dropping the body and the file-name override restores the shipped text.
			await store.update((s) => ({
				...s,
				profiles: s.profiles.map((x) => (x.id === profile.id ? { ...x, body: undefined, file: seedFileFor(x.mode), updatedAt: Date.now() } : x)),
			}));
			await changed();
			return { id: profile.id };
		});

		ctx.rpc("delete", async (p) => {
			const id = str(p.id);
			await store.update((s) => {
				const seeded = seedProfiles(s);
				return { ...seeded, profiles: seeded.profiles.filter((x) => x.id !== id) };
			});
			await changed();
			return { ok: true as const };
		});

		ctx.rpc("create", async (p) => {
			const state = await read();
			const draft = newProfile((str(p.mode) || "default") as PermissionMode);
			const next = sanitizeProfile({ ...draft, ...(p.profile as Params | undefined) }, draft);
			await store.update((s) => {
				const seeded = seedProfiles(s);
				const profiles = next.enabled ? seeded.profiles.map((x) => (x.mode === next.mode ? { ...x, enabled: false } : x)) : seeded.profiles;
				return { ...seeded, profiles: [...profiles, next] };
			});
			await changed();
			return { id: next.id };
		});
	},
});

function pick(state: PromptsState, id: string): PromptProfile {
	const profile = state.profiles.find((p) => p.id === id);
	if (!profile) throw new Error("提示词不存在");
	return profile;
}

/** The shipped file for a mode, used by `reset` to fall back to the bundled text. */
function seedFileFor(mode: PermissionMode): string {
	return SEED_FILES[mode] ?? "default.en.md";
}

const SEED_FILES: Record<PermissionMode, string> = {
	default: "default.en.md",
	acceptEdits: "accept-edits.en.md",
	plan: "plan.en.md",
	bypassPermissions: "whitehat.en.md",
	auto: "operator.en.md",
};
