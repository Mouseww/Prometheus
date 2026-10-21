import { randomUUID } from "node:crypto";
import { createJsonStore } from "@prometheus/plugin-sdk";
import { BUNDLED } from "./bundled.ts";

/**
 * One saved system prompt. Deliberately independent of the permission mode: which prompt the agent
 * is given and which tool calls the gate allows are separate decisions, so a jailbreak prompt can
 * be used with confirmations still on.
 */
export interface PromptProfile {
	id: string;
	title: string;
	description: string;
	/** Bundled file name, resolved against BUNDLED. Absent once the user edits the text. */
	file?: string;
	/** Text of a user-written or user-edited prompt. */
	body?: string;
	/** Off keeps the profile listed but never injected. */
	enabled: boolean;
	/** Replace the prompt section, or append after the host's own prompt. */
	how: "replace" | "append";
	/** Also drop the host's "expert coding assistant" preamble. */
	dropPersona: boolean;
	updatedAt: number;
}

export interface PromptsState {
	profiles: PromptProfile[];
	/** The profile every chat uses unless it picked its own. Empty means no injection at all. */
	selected: string | null;
	/** Session id → profile id, for chats that chose something else. */
	overrides: Record<string, string>;
	/** Which seed generation was written; bumped when the shipped set changes shape. */
	seeded: number;
}

/** 1: pre-mode profiles. 2: mode-bound profiles. 3: prompt and permission mode separated again. */
const SEED_VERSION = 3;

export const emptyState = (): PromptsState => ({ profiles: [], selected: null, overrides: {}, seeded: 0 });

interface Seed {
	id: string;
	title: string;
	description: string;
	file: string;
	how: "replace" | "append";
	dropPersona: boolean;
}

const SEEDS: Seed[] = [
	{
		id: "builtin-default",
		title: "Default",
		description: "Standard assistant: normal help, normal caution",
		file: "default.en.md",
		how: "replace",
		dropPersona: false,
	},
	{
		id: "builtin-operator",
		title: "Operator",
		description: "Ship first: no refusals, no follow-up questions; sensitive targets become placeholders",
		file: "operator.en.md",
		how: "replace",
		dropPersona: true,
	},
	{
		id: "builtin-whitehat",
		title: "White hat",
		description: "Authorized security work: deliver first, no refusals, no authorization checks",
		file: "whitehat.en.md",
		how: "replace",
		dropPersona: true,
	},
	{
		id: "builtin-research",
		title: "Research",
		description: "Evidence before conclusions; no deliverable nobody asked for",
		file: "research.en.md",
		how: "append",
		dropPersona: false,
	},
];

export function seedProfiles(state: PromptsState, now = Date.now()): PromptsState {
	if (state.seeded === SEED_VERSION) return state;
	// An older generation carries profiles shaped for a design that no longer exists (mode-bound in
	// v2, list-bound in v1). Rebuild from the shipped set instead of leaving dead entries behind.
	const profiles = state.seeded === 0 ? [...state.profiles] : [];
	for (const spec of SEEDS) {
		if (profiles.some((p) => p.id === spec.id)) continue;
		profiles.push({ ...spec, enabled: true, updatedAt: now });
	}
	const selected = state.selected && profiles.some((p) => p.id === state.selected) ? state.selected : null;
	return { ...state, profiles, selected, seeded: SEED_VERSION };
}

export function newProfile(now = Date.now()): PromptProfile {
	return {
		id: randomUUID(),
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

/** Which prompt applies to a session: its own pick, else the workspace default. */
export function profileFor(state: PromptsState, sessionId: string | undefined): PromptProfile | undefined {
	const usable = (id: string | null | undefined) => state.profiles.find((p) => p.id === id && p.enabled);
	const own = sessionId ? usable(state.overrides[sessionId]) : undefined;
	return own ?? usable(state.selected);
}

export function makeStore(file: string) {
	return createJsonStore<PromptsState>(file, emptyState);
}

export type PromptsStore = ReturnType<typeof makeStore>;

const MAX_BODY = 400_000;

/** Clients send plain JSON, so nothing may reach the state file unvalidated. */
export function sanitizeProfile(input: unknown, prior?: PromptProfile): PromptProfile {
	if (!input || typeof input !== "object") throw new Error("提示词数据不合法");
	const raw = input as Record<string, unknown>;
	const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
	const title = str(raw.title, prior?.title ?? "").trim().slice(0, 120) || "Untitled";
	const body = typeof raw.body === "string" ? raw.body.slice(0, MAX_BODY) : prior?.body?.slice(0, MAX_BODY);
	return {
		id: prior?.id ?? randomUUID(),
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
