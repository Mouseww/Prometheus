import { randomUUID } from "node:crypto";
import { BUNDLED } from "./bundled.ts";
import { createJsonStore } from "@prometheus/plugin-sdk";

/** Where the prompt text of a profile comes from. */
export type ProfileSource = "builtin" | "file" | "inline";

export interface PromptProfile {
	id: string;
	title: string;
	/** One line shown in the picker. */
	description: string;
	source: ProfileSource;
	/** Builtin: base file name under the bundled prompts folder (`operator.md`). */
	file?: string;
	/** Inline: the text itself, so edits never touch the shipped file. */
	body?: string;
	enabled: boolean;
	/** Append after the prompt the host already built instead of replacing it. */
	mode: "replace" | "append";
	/** Replaces the editable part of the prompt, and the section that carries `body`. */
	base: "operator" | "none";
	/**
	 * Hand the resulting prompt over as a section (`event.systemPromptOptions.sections[name]`) instead
	 * of replacing the whole prompt. Replacing is the stronger form, but it also hides every other
	 * plugin's sections — including the ones that carry the permission mode.
	 */
	asSection: boolean;
	/** Drop the built-in "expert coding assistant" preamble so the profile speaks for itself. */
	dropPersona: boolean;
	updatedAt: number;
}

export interface PromptsState {
	/** The profile every chat uses unless a chat overrides it. */
	active: string | null;
	/** Session key → profile id, for chats that picked their own. */
	overrides: Record<string, string>;
	profiles: PromptProfile[];
	/** Profiles shipped with the plugin have been seeded once. */
	seeded: boolean;
}

export const emptyState = (): PromptsState => ({ active: null, overrides: {}, profiles: [], seeded: false });

/** Seeded ids are stable, so reseeding after a plugin reload never duplicates the shipped profiles. */
const BUILTIN_PROFILES: Array<Pick<PromptProfile, "title" | "description" | "file" | "mode" | "base" | "asSection"> & { file: string }> = [
	{
		title: "Operator",
		description: "Ship first: no refusals, no follow-up questions; sensitive targets become placeholders",
		file: "operator.en.md",
		mode: "replace",
		base: "operator",
		asSection: true,
	},
	{
		title: "Research",
		description: "Evidence before conclusions; no deliverable nobody asked for",
		file: "research.en.md",
		mode: "append",
		base: "none",
		asSection: true,
	},
];

export function seedProfiles(state: PromptsState, now = Date.now()): PromptsState {
	if (state.seeded) return state;
	const profiles = [...state.profiles];
	for (const spec of BUILTIN_PROFILES) {
		const id = spec.file.replace(/(?:\.en)?\.md$/, "");
		if (profiles.some((p) => p.id === id)) continue;
		profiles.push({
			...spec,
			id,
			source: "builtin",
			enabled: true,
			dropPersona: false,
			updatedAt: now,
		});
	}
	const active = state.active && profiles.some((p) => p.id === state.active) ? state.active : null;
	return { ...state, profiles, active, seeded: true };
}

export function newProfile(now = Date.now()): PromptProfile {
	return {
		id: randomUUID(),
		title: "New profile",
		description: "",
		source: "inline",
		body: "",
		enabled: true,
		mode: "replace",
		base: "operator",
		asSection: true,
		dropPersona: false,
		updatedAt: now,
	};
}

/**
 * The text for one profile. A builtin resolves against {@link BUNDLED}, which is compiled into the
 * app, so it also works from the packaged desktop build where no `prompts/` folder exists.
 */
export function bodyOf(profile: PromptProfile, bundled: Record<string, string> = BUNDLED): string | undefined {
	if (profile.source === "builtin") return profile.file ? bundled[profile.file] : undefined;
	return profile.body ?? "";
}

/** The profile that applies to a session: its own override, else the workspace default. */
export function profileFor(state: PromptsState, sessionId: string | undefined): PromptProfile | undefined {
	const pick = (id: string | null | undefined) => state.profiles.find((p) => p.id === id && p.enabled);
	const own = sessionId ? pick(state.overrides[sessionId]) : undefined;
	return own ?? pick(state.active);
}

export function makeStore(file: string) {
	return createJsonStore<PromptsState>(file, emptyState);
}

export type PromptsStore = ReturnType<typeof makeStore>;

const MAX_BODY = 400_000;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

/** Clients send plain JSON, so nothing may reach the state file unvalidated. */
export function sanitizeProfile(input: unknown, prior?: PromptProfile): PromptProfile {
	if (!input || typeof input !== "object") throw new Error("配置数据不合法");
	const raw = input as Record<string, unknown>;
	const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
	const title = str(raw.title, prior?.title ?? "").trim().slice(0, 120) || "未命名";
	const body = typeof raw.body === "string" ? raw.body : prior?.body;
	return {
		id: prior?.id ?? randomUUID(),
		title,
		description: str(raw.description, prior?.description ?? "").slice(0, 400),
		source: oneOf(raw.source, ["builtin", "file", "inline"] as const, prior?.source ?? "inline"),
		file: typeof raw.file === "string" ? raw.file : prior?.file,
		body: body === undefined ? undefined : body.slice(0, MAX_BODY),
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : (prior?.enabled ?? true),
		mode: oneOf(raw.mode, ["replace", "append"] as const, prior?.mode ?? "replace"),
		base: oneOf(raw.base, ["operator", "none"] as const, prior?.base ?? "operator"),
		asSection: typeof raw.asSection === "boolean" ? raw.asSection : (prior?.asSection ?? true),
		dropPersona: typeof raw.dropPersona === "boolean" ? raw.dropPersona : (prior?.dropPersona ?? false),
		updatedAt: Date.now(),
	};
}
