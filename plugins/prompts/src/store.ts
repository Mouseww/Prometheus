import { randomUUID } from "node:crypto";
import { BUNDLED } from "./bundled.ts";
import { createJsonStore } from "@prometheus/plugin-sdk";
import { PERMISSION_MODES, type PermissionMode } from "@prometheus/protocol";

/**
 * One saved system prompt, bound to a permission mode. A mode has at most one active prompt; the
 * prompt is what the agent is told, the mode is what the gate actually enforces.
 */
export interface PromptProfile {
	id: string;
	/** The mode this prompt speaks for. Two prompts may share a mode; the enabled one wins. */
	mode: PermissionMode;
	title: string;
	description: string;
	/** Bundled file name, resolved against BUNDLED. Absent once the user edits it. */
	file?: string;
	/** Text of a user-written or user-edited prompt. */
	body?: string;
	enabled: boolean;
	/** Replace the section body outright, or append after the host's own prompt. */
	how: "replace" | "append";
	/** Also drop the host's "expert coding assistant" preamble. */
	dropPersona: boolean;
	updatedAt: number;
}

export interface PromptsState {
	profiles: PromptProfile[];
	/** Which seed generation was written; bumped when the shipped set changes shape. */
	seeded: number;
}

/** 1: profiles without a mode (pre-mode versions). 2: one prompt per permission mode. */
const SEED_VERSION = 2;

export const emptyState = (): PromptsState => ({ profiles: [], seeded: 0 });

interface Seed {
	mode: PermissionMode;
	title: string;
	description: string;
	file: string;
	how: "replace" | "append";
	dropPersona: boolean;
}

/**
 * What each mode is told, out of the box.
 *
 * The three gated modes get a plain, contract-style prompt: their behaviour is enforced by the
 * permission gate, so the prompt only has to state what the mode is for. `auto` and
 * `bypassPermissions` hand the agent real latitude, so they get the operator prompt — the long one
 * that decides *how* it answers, not just what it may touch.
 */
const SEEDS: Seed[] = [
	{
		mode: "default",
		title: "Default",
		description: "Standard assistant: normal help, normal caution",
		file: "default.en.md",
		how: "replace",
		dropPersona: false,
	},
	{
		mode: "acceptEdits",
		title: "Accept edits",
		description: "Edits inside the project apply without asking; commands still confirm",
		file: "accept-edits.en.md",
		how: "replace",
		dropPersona: false,
	},
	{
		mode: "plan",
		title: "Plan",
		description: "Read-only research and a plan for approval; nothing changes",
		file: "plan.en.md",
		how: "replace",
		dropPersona: false,
	},
	{
		mode: "bypassPermissions",
		title: "White hat",
		description: "Authorized security work: deliver first, no refusals, no authorization checks",
		file: "whitehat.en.md",
		how: "replace",
		dropPersona: true,
	},
	{
		mode: "auto",
		title: "Auto",
		description: "Nothing is asked and the agent decides everything itself",
		file: "operator.en.md",
		how: "replace",
		dropPersona: true,
	},
];

/** Stable ids, so reseeding after a reload never duplicates the shipped prompts. */
const seedId = (mode: PermissionMode) => `builtin-${mode}`;

export function seedProfiles(state: PromptsState, now = Date.now()): PromptsState {
	if (state.seeded === SEED_VERSION) return state;
	// A state from an older generation carries profiles that do not fit the current shape (no `mode`,
	// retired files). Keeping them would leave every mode without a prompt and show dead entries, so
	// that generation is replaced outright; it shipped one version and held no user-authored text.
	const profiles = state.seeded === 0 ? [...state.profiles] : [];
	for (const spec of SEEDS) {
		const id = seedId(spec.mode);
		if (profiles.some((p) => p.id === id)) continue;
		profiles.push({
			id,
			mode: spec.mode,
			title: spec.title,
			description: spec.description,
			file: spec.file,
			enabled: true,
			how: spec.how,
			dropPersona: spec.dropPersona,
			updatedAt: now,
		});
	}
	return { ...state, profiles, seeded: SEED_VERSION };
}

export function newProfile(mode: PermissionMode, now = Date.now()): PromptProfile {
	return {
		id: randomUUID(),
		mode,
		title: "New prompt",
		description: "",
		body: "",
		enabled: true,
		how: "append",
		dropPersona: false,
		updatedAt: now,
	};
}

/** The text of one prompt. Bundled prompts resolve against the compiled-in table. */
export function bodyOf(profile: PromptProfile, bundled: Record<string, string> = BUNDLED): string | undefined {
	if (profile.body !== undefined) return profile.body;
	if (profile.file) return bundled[profile.file];
	return undefined;
}

/** The prompt that speaks for a mode: the enabled one, preferring the seeded entry. */
export function promptFor(state: PromptsState, mode: PermissionMode): PromptProfile | undefined {
	const candidates = state.profiles.filter((p) => p.mode === mode && p.enabled);
	return candidates.find((p) => p.id === seedId(mode)) ?? candidates[0];
}

export function makeStore(file: string) {
	return createJsonStore<PromptsState>(file, emptyState);
}

export type PromptsStore = ReturnType<typeof makeStore>;

const MAX_BODY = 400_000;

const asMode = (v: unknown, fallback: PermissionMode): PermissionMode =>
	PERMISSION_MODES.includes(v as PermissionMode) ? (v as PermissionMode) : fallback;

/** Clients send plain JSON, so nothing may reach the state file unvalidated. */
export function sanitizeProfile(input: unknown, prior?: PromptProfile): PromptProfile {
	if (!input || typeof input !== "object") throw new Error("提示词数据不合法");
	const raw = input as Record<string, unknown>;
	const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
	const title = str(raw.title, prior?.title ?? "").trim().slice(0, 120) || "Untitled";
	const body = typeof raw.body === "string" ? raw.body.slice(0, MAX_BODY) : prior?.body?.slice(0, MAX_BODY);
	return {
		id: prior?.id ?? randomUUID(),
		mode: asMode(raw.mode, prior?.mode ?? "default"),
		title,
		description: str(raw.description, prior?.description ?? "").slice(0, 400),
		// Editing a bundled prompt stores a body, which shadows the file from then on.
		file: body === undefined ? (typeof raw.file === "string" ? raw.file : prior?.file) : undefined,
		body,
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : (prior?.enabled ?? true),
		how: raw.how === "append" ? "append" : raw.how === "replace" ? "replace" : (prior?.how ?? "replace"),
		dropPersona: typeof raw.dropPersona === "boolean" ? raw.dropPersona : (prior?.dropPersona ?? false),
		updatedAt: Date.now(),
	};
}
