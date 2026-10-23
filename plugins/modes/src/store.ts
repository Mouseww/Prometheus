import { randomUUID } from "node:crypto";
import { createJsonStore } from "@prometheus/plugin-sdk";
import { BUNDLED } from "./bundled.ts";

/**
 * How a mode composes its text with the host prompt. Indistinguishable from pi-purge's three modes
 * on purpose: the difference between "persona on top" and "persona alone" *is* the effect.
 *
 * - append  — text before the host prompt, nothing removed (weakest: the harness framing still wins)
 * - replace — text, then the host prompt with its identity line and pi docs section cut out
 * - strict  — text plus the working directory only; every host section is dropped
 */
export type ComposeMode = "append" | "replace" | "strict";

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
	compose: ComposeMode;
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
	/**
	 * Whether a brand-new chat starts in the workspace default mode. Absent or false means it starts
	 * on the host prompt: a mode is opt-in (this is what keeps /purge-style behaviour predictable),
	 * but once switched on it sticks across restarts.
	 */
	defaultEnabled?: boolean;
}

/** 1-2: prompt-only. 3: prompts, decoupled from permissions. 4: per-mode tools. 5: purge-strength compose modes. 6: subagent boost. */
const SEED_VERSION = 7;

export const emptyState = (): ModesState => ({ modes: [], selected: null, overrides: {}, seeded: 0 });

interface Seed {
	id: string;
	title: string;
	description: string;
	file: string;
	compose: ComposeMode;
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
		compose: "replace",
		tools: [],
	},
	{
		id: "builtin-delegate",
		title: "Subagent boost",
		description: "Orchestrator: hands work to subagents first, runs independent jobs in parallel, verifies before reporting",
		file: "delegate.en.md",
		compose: "append",
		tools: [],
	},
	{
		id: "builtin-operator",
		title: "Operator",
		description: "Ship first: no refusals, no follow-up questions; sensitive targets become placeholders",
		file: "operator.en.md",
		compose: "replace",
		tools: [],
	},
	{
		id: "builtin-whitehat",
		title: "White hat",
		description: "Authorized security work: deliver first, no refusals, no authorization checks",
		file: "whitehat.en.md",
		compose: "replace",
		tools: [],
	},
	{
		id: "builtin-purge",
		title: "Purge",
		description: "Persona alone: the host prompt is dropped entirely, only the persona and cwd remain",
		file: "purge.en.md",
		compose: "strict",
		tools: [],
	},
	{
		id: "builtin-research",
		title: "Research",
		description: "Evidence before conclusions; reads only, no deliverable nobody asked for",
		file: "research.en.md",
		compose: "append",
		tools: READ_ONLY,
	},
];

export function seedModes(state: ModesState, now = Date.now()): ModesState {
	if (state.seeded === SEED_VERSION) return state;
	// Older generations hold shapes that no longer exist (mode-bound prompts, prompts without tools).
	// Bundled ids are rebuilt from the shipped text; user modes that already have a body survive, but
	// a generation bump drops the whole list, so keep user modes only when they carry their own text.
	// A state written by an older shape may be missing anything; nothing here may throw on it.
	const prior = Array.isArray(state.modes) ? state.modes : [];
	const kept = state.seeded === 0 ? prior : prior.filter((m) => !m.file);
	const modes = [...kept];
	for (const spec of SEEDS) {
		if (modes.some((m) => m.id === spec.id)) continue;
		modes.push({ ...spec, enabled: true, updatedAt: now });
	}
	const selected = state.selected && modes.some((m) => m.id === state.selected) ? state.selected : null;
	const overrides = Object.fromEntries(
		Object.entries(state.overrides ?? {}).filter(([, id]) => modes.some((m) => m.id === id && m.enabled)),
	);
	return { ...state, modes, selected, overrides, seeded: SEED_VERSION };
}

export function newMode(now = Date.now()): AgentMode {
	return {
		id: randomUUID(),
		title: "New mode",
		description: "",
		body: "",
		enabled: true,
		compose: "append",
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
	// A chat's own pick always counts; the workspace default only when the user switched it on, so a
	// selected mode never surprises a new chat that was started without one.
	const usable = (id: string | null | undefined, ignoreDefault: boolean) =>
		(ignoreDefault || state.defaultEnabled === true ? state.modes.find((m) => m.id === id && m.enabled) : undefined);
	const own = sessionId ? usable(state.overrides[sessionId], true) : undefined;
	return own ?? usable(state.selected, false);
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

/** Only plan mode may switch this one on; the permission gate adds and removes it itself. */
const PLAN_EXIT_TOOL = "exit_plan_mode";

/**
 * The active tool set a mode asks for, or null when it is already in effect.
 *
 * The mode alone decides: a mode that names tools gets exactly those, and a mode that names none
 * (or no mode at all) opens every tool PI has registered, including the ones it keeps off by
 * default (powershell, grep, find, ls). Two kinds are left alone: the plan-exit tool, which the
 * permission gate manages, and MCP tools, which stay behind the tool-search tool instead of being
 * dumped into every prompt.
 */
export function planTools(mode: AgentMode | undefined, active: readonly string[], registered: readonly string[]): string[] | null {
	if (registered.length === 0) return null;
	const live = new Set(active);
	const base = registered.filter((n) => n !== PLAN_EXIT_TOOL);
	const next = mode && mode.tools.length > 0 ? allowedTools(mode, base) : base.filter((n) => !n.startsWith("mcp__") || live.has(n));
	if (live.has(PLAN_EXIT_TOOL)) next.push(PLAN_EXIT_TOOL);
	return sameSet(next, active) ? null : next;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size && a.every((x) => b.includes(x));

/** pi's own identity sentence, the template's first line. */
const HOST_IDENTITY = "You are an expert coding assistant operating inside pi, a coding agent harness.";
/** Start and end markers of pi's documentation section. Either one missing means "leave it alone". */
const HOST_DOCS_START = "Pi documentation (read only when the user asks about pi itself";
const HOST_DOCS_END = "(e.g., tui.md for TUI API details)";

/**
 * Cut the host identity line and pi's documentation section out of a prompt.
 *
 * Both are located by their exact wording, so a pi release that rewords them leaves the prompt
 * intact instead of slicing the wrong text — `/modes status` then reports the section as unmatched.
 */
export function stripHostPersona(prompt: string): { text: string; identity: boolean; docs: boolean } {
	let text = prompt;
	let identity = false;
	let docs = false;

	const identityAt = text.indexOf(HOST_IDENTITY);
	if (identityAt !== -1) {
		const lineEnd = text.indexOf("\n", identityAt);
		text = text.slice(0, identityAt) + text.slice(lineEnd === -1 ? text.length : lineEnd + 1);
		identity = true;
	}

	const docsAt = text.indexOf(HOST_DOCS_START);
	if (docsAt !== -1) {
		const docsEndAt = text.indexOf(HOST_DOCS_END, docsAt + HOST_DOCS_START.length);
		if (docsEndAt !== -1) {
			let start = docsAt;
			while (start > 0 && text[start - 1] === "\n") start -= 1;
			const lineEnd = text.indexOf("\n", docsEndAt);
			text = text.slice(0, start) + text.slice(lineEnd === -1 ? text.length : lineEnd + 1);
			// The section is rendered inside <docs>…</docs>; leaving an empty wrapper behind would
			// still tell the model a documentation section exists.
			text = text.replace(/<docs>\s*<\/docs>\n?/g, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
			docs = true;
		}
	}

	return { text, identity, docs };
}

/** What the previous turn actually removed, so a status read can answer "did it take effect". */
export interface LastCut {
	identity: boolean;
	docs: boolean;
	at: number;
}

/**
 * The system prompt text for one mode.
 *
 * `strict` ignores the host prompt entirely — the tool schemas travel in the API `tools` parameter,
 * not in this text, so tools keep working with no host prose present.
 */
export function composeSystemPrompt(
	mode: AgentMode | undefined,
	body: string,
	host: string,
	cwd: string,
): { text: string; cut: LastCut } {
	if (!mode) return { text: host, cut: { identity: false, docs: false, at: 0 } };
	const cut = stripHostPersona(host);
	const at = Date.now();
	if (mode.compose === "strict") {
		const where = cwd ? `Current working directory: ${cwd.replace(/\\/g, "/")}` : "";
		return { text: where ? `${body}\n\n${where}` : body, cut: { ...cut, at } };
	}
	if (mode.compose === "replace") return { text: cut.text ? `${body}\n\n${cut.text}` : body, cut: { ...cut, at } };
	return { text: host ? `${body}\n\n${host}` : body, cut: { identity: false, docs: false, at: 0 } };
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
	const compose =
		raw.compose === "append" || raw.compose === "replace" || raw.compose === "strict"
			? raw.compose
			: // Older clients know only `how`, so keep honouring it instead of resetting to append.
				raw.how === "append"
				? "append"
				: raw.how === "replace"
					? "replace"
					: (prior?.compose ?? "replace");
	return {
		id: prior?.id ?? randomUUID(),
		title,
		description: str(raw.description, prior?.description ?? "").slice(0, 400),
		// Editing a bundled mode stores a body, which shadows the file from then on.
		file: body === undefined ? (typeof raw.file === "string" ? raw.file : prior?.file) : undefined,
		body,
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : (prior?.enabled ?? true),
		compose,
		tools,
		updatedAt: Date.now(),
	};
}
