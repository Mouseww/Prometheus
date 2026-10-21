import { randomUUID } from "node:crypto";
import { createJsonStore } from "@prometheus/plugin-sdk";
import { BUNDLED } from "./bundled.ts";

/**
 * A mode is a whole agent configuration, not just text: the system prompt it speaks with and the
 * tools it can reach. Deliberately independent of the permission mode — that decides whether a
 * tool call is confirmed, this decides which tools exist at all.
 */
export interface AgentMode {
	id: string;
	title: string;
	description: string;
	/** Bundled file name, resolved against BUNDLED. Absent once the user edits the text. */
	file?: string;
	/** Text of a user-written or user-edited prompt. */
	body?: string;
	/** Off keeps the mode listed but never applied. */
	enabled: boolean;
	/** Replace the host's default prompt, or append after it. */
	how: "replace" | "append";
	/** Also drop the host's "expert coding assistant" preamble. */
	dropPersona: boolean;
	/**
	 * Tools this mode may use. Empty means every tool the host offers.
	 * Only ever narrows: a mode cannot grant a tool the host did not register.
	 */
	tools: string[];
	updatedAt: number;
}

export interface ModesState {
	modes: AgentMode[];
	/** The mode every chat uses unless it picked its own. Empty means no mode: the host default. */
	selected: string | null;
	/** Session id → mode id, for chats that chose something else. */
	overrides: Record<string, string>;
	/** Which seed generation was written; bumped when the shipped set changes shape. */
	seeded: number;
}

/** 1-2: prompt-only generations. 3: prompts, decoupled from permissions. 4: modes with tools. */
const SEED_VERSION = 4;

export const emptyState = (): ModesState => ({ modes: [], selected: null, overrides: {}, seeded: 0 });

interface Seed {
	id: string;
	title: string;
	description: string;
	file: string;
	how: "replace" | "append";
	dropPersona: boolean;
	tools: string[];
}

/** Read-only tools: enough to investigate, nothing that changes the machine. */
const READ_ONLY = ["read", "grep", "find", "ls", "knowledge_search", "memory_search", "todo_write"];

const SEEDS: Seed[] = [
	{
		id: "builtin-default",
		title: "Default",
		description: "Standard assistant: every tool, normal caution",
		file: "default.en.md",
		how: "replace",
		dropPersona: false,
		tools: [],
	},
	{
		id: "builtin-operator",
		title: "Operator",
		description: "Ship first: no refusals, no follow-up questions; sensitive targets become placeholders",
		file: "operator.en.md",
		how: "replace",
		dropPersona: true,
		tools: [],
	},
	{
		id: "builtin-whitehat",
		title: "White hat",
		description: "Authorized security work: deliver first, no refusals, no authorization checks",
		file: "whitehat.en.md",
		how: "replace",
		dropPersona: true,
		tools: [],
	},
	{
		id: "builtin-research",
		title: "Research",
		description: "Evidence before conclusions; reads only, no deliverable nobody asked for",
		file: "research.en.md",
		how: "append",
		dropPersona: false,
		tools: READ_ONLY,
	},
];

export function seedModes(state: ModesState, now = Date.now()): ModesState {
	if (state.seeded === SEED_VERSION) return state;
	// Older generations hold shapes that no longer exist (mode-bound prompts, prompts without tools).
	const modes = state.seeded === 0 ? [...state.modes] : [];
	for (const spec of SEEDS) {
		if (modes.some((m) => m.id === spec.id)) continue;
		modes.push({ ...spec, enabled: true, updatedAt: now });
	}
	const selected = state.selected && modes.some((m) => m.id === state.selected) ? state.selected : null;
	return { ...state, modes, selected, seeded: SEED_VERSION };
}

export function newMode(now = Date.now()): AgentMode {
	return {
		id: randomUUID(),
		title: "New mode",
		description: "",
		body: "",
		enabled: true,
		how: "append",
		dropPersona: false,
		tools: [],
		updatedAt: now,
	};
}

/** The text of one mode. Bundled modes resolve against the compiled-in table. */
export function bodyOf(mode: AgentMode, bundled: Record<string, string> = BUNDLED): string | undefined {
	if (mode.body !== undefined) return mode.body;
	if (mode.file) return bundled[mode.file];
	return undefined;
}

/** Which mode applies to a session: its own pick, else the workspace default. */
export function modeFor(state: ModesState, sessionId: string | undefined): AgentMode | undefined {
	const usable = (id: string | null | undefined) => state.modes.find((m) => m.id === id && m.enabled);
	const own = sessionId ? usable(state.overrides[sessionId]) : undefined;
	return own ?? usable(state.selected);
}

/**
 * The tools a mode leaves available, given what the host currently offers.
 *
 * A mode only narrows: an id the host never registered stays out, and an empty list means "no
 * restriction" rather than "nothing". Anything the mode does not mention is removed.
 */
export function allowedTools(mode: AgentMode | undefined, available: readonly string[]): string[] {
	if (!mode || mode.tools.length === 0) return [...available];
	return available.filter((name) => mode.tools.includes(name));
}

export function makeStore(file: string) {
	return createJsonStore<ModesState>(file, emptyState);
}

export type ModesStore = ReturnType<typeof makeStore>;

const MAX_BODY = 400_000;
const MAX_TOOLS = 200;

/** Clients send plain JSON, so nothing may reach the state file unvalidated. */
export function sanitizeMode(input: unknown, prior?: AgentMode): AgentMode {
	if (!input || typeof input !== "object") throw new Error("模式数据不合法");
	const raw = input as Record<string, unknown>;
	const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
	const title = str(raw.title, prior?.title ?? "").trim().slice(0, 120) || "Untitled";
	const body = typeof raw.body === "string" ? raw.body.slice(0, MAX_BODY) : prior?.body?.slice(0, MAX_BODY);
	const tools = Array.isArray(raw.tools)
		? [...new Set(raw.tools.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length < 128))].slice(0, MAX_TOOLS)
		: (prior?.tools ?? []);
	return {
		id: prior?.id ?? randomUUID(),
		title,
		description: str(raw.description, prior?.description ?? "").slice(0, 400),
		// Editing a bundled mode stores a body, which shadows the file from then on.
		file: body === undefined ? (typeof raw.file === "string" ? raw.file : prior?.file) : undefined,
		body,
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : (prior?.enabled ?? true),
		how: raw.how === "append" ? "append" : raw.how === "replace" ? "replace" : (prior?.how ?? "replace"),
		dropPersona: typeof raw.dropPersona === "boolean" ? raw.dropPersona : (prior?.dropPersona ?? false),
		tools,
		updatedAt: Date.now(),
	};
}
