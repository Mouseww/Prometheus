import { Type } from "@earendil-works/pi-ai";
import { definePlugin } from "@prometheus/plugin-sdk";
import { parseTodos, TODO_TOOL, type TodoItem } from "@prometheus/protocol";

export function summarize(todos: TodoItem[]): string {
	const done = todos.filter((t) => t.status === "completed").length;
	const doing = todos.find((t) => t.status === "in_progress");
	return `${done}/${todos.length} done${doing ? `; now: ${doing.content}` : ""}`;
}

/** Why a list is unusable, or undefined when it is fine. At most one item may be in progress. */
export function problem(todos: TodoItem[]): string | undefined {
	if (!todos.length) return "the list is empty: pass at least one item, or skip the tool for trivial work";
	const active = todos.filter((t) => t.status === "in_progress").length;
	if (active > 1) return `${active} items are in_progress; work on one at a time`;
	return undefined;
}

const GUIDELINES = [
	`Use ${TODO_TOOL} to plan any task with three or more distinct steps, and when the user hands you several things at once. Skip it for a single trivial step.`,
	`${TODO_TOOL} replaces the whole list each call, so always send every item. Keep exactly one item in_progress, mark it completed the moment it is done, and add follow-up items as you discover them.`,
	`Only mark an item completed when the work is really finished and verified, not when you merely started or hit an error.`,
];

export default definePlugin({
	name: "todos",
	version: "0.1.0",
	// Safe to switch off: the chat panel simply has nothing to show.
	optional: true,
	setup(ctx) {
		ctx.extension((pi) => {
			pi.registerTool({
				name: TODO_TOOL,
				label: "任务清单",
				description:
					"Create and update the task list for this conversation. The user sees it next to the chat and follows your progress live. Send the complete list every time.",
				promptSnippet: `${TODO_TOOL}: plan multi-step work and keep a live checklist the user can follow`,
				promptGuidelines: GUIDELINES,
				parameters: Type.Object({
					todos: Type.Array(
						Type.Object({
							content: Type.String({ description: "What to do, in the imperative: \"Run the tests\"" }),
							status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
							activeForm: Type.Optional(Type.String({ description: "Present continuous form shown while in progress: \"Running the tests\"" })),
						}),
						{ maxItems: 50 },
					),
				}),
				async execute(_id, params) {
					const todos = parseTodos(params);
					const bad = problem(todos);
					if (bad) throw new Error(bad);
					return { content: [{ type: "text", text: `Task list updated (${summarize(todos)}). Carry on with the current item.` }], details: { todos } };
				},
			});
		});
	},
});
