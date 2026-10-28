// /goal: the user sets an objective and the agent keeps working toward it on its own, turn after turn, until it
// reports the objective done, says it is blocked, or runs out of turns. The host drives the loop (packages/core/src/goal.ts);
// these are the shapes and the text conventions shared by the host, the web UI and the TUI.

/**
 * active: the agent is working on it (a turn is running or the next one is about to start).
 * paused: the user stopped a turn, or a turn failed; nothing more runs until it is resumed.
 * complete: the agent reported the objective achieved. blocked: the agent needs the user.
 * limit: the turn budget ran out before the objective was reached.
 */
export type GoalStatus = "active" | "paused" | "complete" | "blocked" | "limit";

export interface GoalState {
	objective: string;
	status: GoalStatus;
	/** Turns the host has started for this goal so far. */
	turns: number;
	maxTurns: number;
	/** Epoch ms. */
	startedAt: number;
	updatedAt: number;
	/** Why it stopped (blocked reason, error) or the agent's closing summary. */
	note?: string;
}

export const GOAL_DEFAULT_TURNS = 30;
export const GOAL_MAX_TURNS = 200;

/** Opens every turn the host sends for a goal; the UI shows such a message as a compact goal marker instead of the text. */
export const GOAL_DIRECTIVE_TAG = "goal_directive";
/** How the agent reports the outcome at the end of a reply. */
export const GOAL_STATUS_TAG = "goal_status";

/** The turn text the agent receives. Turn 1 introduces the objective; later turns ask it to carry on. */
export function goalDirective(objective: string, turn: number, maxTurns: number): string {
	const intro =
		turn <= 1
			? "You have been given an objective to complete autonomously. The user is not reviewing each step: after each of your replies you will be prompted again to continue, until you report the objective complete."
			: "Continue working toward the objective. Review what has already been done in this conversation, then take the next concrete step.";
	return [
		`<${GOAL_DIRECTIVE_TAG} turn="${turn}" max_turns="${maxTurns}">`,
		intro,
		"",
		"Objective:",
		objective.trim(),
		"",
		"Rules:",
		"- Make real progress in this turn with your tools. Do not stop to ask for confirmation of routine choices: pick the sensible option and state the assumption.",
		"- Verify the result (run the tests, the build, or whatever proves it works) before you call the objective done.",
		`- When the objective is fully achieved and verified, end your reply with a short summary followed by <${GOAL_STATUS_TAG}>complete</${GOAL_STATUS_TAG}>.`,
		`- If you cannot go on without the user (missing information, credentials, or a decision only they can make), end with <${GOAL_STATUS_TAG}>blocked: the reason</${GOAL_STATUS_TAG}>.`,
		`- Otherwise end with a one-line progress note and no ${GOAL_STATUS_TAG} tag; you will be asked to continue.`,
		`- This is turn ${turn} of at most ${maxTurns}.`,
		`</${GOAL_DIRECTIVE_TAG}>`,
	].join("\n");
}

const DIRECTIVE_RE = new RegExp(`^\\s*<${GOAL_DIRECTIVE_TAG} turn="(\\d+)" max_turns="(\\d+)">\\n[\\s\\S]*?\\nObjective:\\n([\\s\\S]*?)\\n\\nRules:[\\s\\S]*?</${GOAL_DIRECTIVE_TAG}>\\s*$`);

/** A goal turn's text back as its parts, or null for an ordinary message. */
export function parseGoalDirective(text: string): { turn: number; maxTurns: number; objective: string } | null {
	const m = DIRECTIVE_RE.exec(text);
	if (!m) return null;
	return { turn: Number(m[1]), maxTurns: Number(m[2]), objective: m[3]!.trim() };
}

/** A conversation title for a first message that is a goal turn: its objective. Works on text cut short, too. */
export function goalTitle(text: string): string | null {
	if (!text.trimStart().startsWith(`<${GOAL_DIRECTIVE_TAG} `)) return null;
	const at = text.indexOf("\nObjective:\n");
	if (at < 0) return "Goal";
	const rest = text.slice(at + "\nObjective:\n".length);
	let end = rest.indexOf("\n\nRules:");
	if (end < 0) {
		// Cut short inside the "Rules:" header itself.
		const gap = rest.lastIndexOf("\n\n");
		if (gap >= 0 && "Rules:".startsWith(rest.slice(gap + 2))) end = gap;
	}
	return (end >= 0 ? rest.slice(0, end) : rest).trim() || "Goal";
}

const STATUS_RE = new RegExp(`<${GOAL_STATUS_TAG}>\\s*(complete|blocked)\\s*(?::\\s*([\\s\\S]*?))?\\s*</${GOAL_STATUS_TAG}>`, "gi");

/** What the agent reported at the end of a reply: the last status tag wins; null when it reported nothing. */
export function readGoalStatus(reply: string): { status: "complete" | "blocked"; reason?: string } | null {
	let last: RegExpExecArray | null = null;
	for (const m of reply.matchAll(STATUS_RE)) last = m;
	if (!last) return null;
	const status = last[1]!.toLowerCase() as "complete" | "blocked";
	const reason = last[2]?.trim();
	return reason ? { status, reason } : { status };
}

/** Reply text without the status tags (the goal bar shows the status). */
export function stripGoalStatus(text: string): string {
	return text.replace(STATUS_RE, "").replace(/\s+$/, "");
}

/** `/goal ...` typed by the user, understood. `null` when the text is not a /goal command. */
export type GoalCommand = { action: "show" } | { action: "pause" } | { action: "resume" } | { action: "clear" } | { action: "set"; objective: string; maxTurns?: number };

export function parseGoalCommand(text: string): GoalCommand | null {
	const m = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!m) return null;
	let rest = (m[1] ?? "").trim();
	if (!rest) return { action: "show" };
	const word = rest.toLowerCase();
	if (word === "pause") return { action: "pause" };
	if (word === "resume" || word === "continue") return { action: "resume" };
	if (word === "clear" || word === "stop" || word === "off" || word === "cancel") return { action: "clear" };
	let maxTurns: number | undefined;
	const flag = /^--(?:max|turns|max-turns)(?:=|\s+)(\d+)\s*/i.exec(rest);
	if (flag) {
		maxTurns = Math.min(GOAL_MAX_TURNS, Math.max(1, Number(flag[1])));
		rest = rest.slice(flag[0].length).trim();
	}
	if (!rest) return { action: "show" };
	return maxTurns ? { action: "set", objective: rest, maxTurns } : { action: "set", objective: rest };
}
