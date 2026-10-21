import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PermissionMode, PermissionPrompt, RunAccess } from "@prometheus/protocol";
import { decide, EXIT_PLAN_MODE, INSTALL_PLUGIN_TOOL, ruleKey, toolKind } from "./permissions.ts";

const PLAN_PROMPT = `# Plan mode
Plan mode is active. Do not change anything: only read-only tools (read, grep, find, ls and non-mutating commands) will run, everything else is refused.
Explore the code, then call ${EXIT_PLAN_MODE} with a complete plan in Markdown. The user reviews it and decides whether you may start. Do not ask for approval in plain text; use ${EXIT_PLAN_MODE}.`;

const PLAN_GUIDELINES = [
	"Plan mode is active: do not change anything. Investigate with read-only tools, then call exit_plan_mode with the complete plan.",
];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * The live permission mode, for extensions that shape the prompt around it (the `prompts` plugin
 * injects a different system prompt per mode). Keyed by session, since one process serves many.
 * `PermissionGate` owns every entry; readers only look up.
 */
export const permissionModes = new Map<string, PermissionMode>();
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
const str = (v: unknown) => (typeof v === "string" ? v : "");

function describe(toolName: string, input: Record<string, unknown>): Pick<Extract<PermissionPrompt, { kind: "tool" }>, "summary" | "detail"> {
	if (toolName === INSTALL_PLUGIN_TOOL) {
		const files = Array.isArray(input.files) ? (input.files as { path?: unknown; content?: unknown }[]) : [];
		const detail = files.map((f) => `── ${str(f.path)} ──\n${clip(str(f.content), 3000)}`).join("\n\n");
		return { summary: `${str(input.name)}  (${files.length} files)`, detail: clip(detail, 12000) };
	}
	switch (toolKind(toolName)) {
		case "exec": {
			const command = str(input.command);
			return { summary: clip(command.split("\n")[0] ?? "", 200), detail: command.includes("\n") || command.length > 200 ? clip(command, 4000) : undefined };
		}
		case "edit": {
			const path = str(input.path);
			if (toolName === "write") return { summary: path, detail: clip(str(input.content), 3000) };
			const edits = Array.isArray(input.edits) ? (input.edits as { oldText?: unknown; newText?: unknown }[]) : [];
			const detail = edits.map((e) => `- ${clip(str(e.oldText), 600)}\n+ ${clip(str(e.newText), 600)}`).join("\n\n");
			return { summary: path, detail: clip(detail, 4000) };
		}
		default:
			return { summary: clip(JSON.stringify(input), 200), detail: clip(JSON.stringify(input, null, 2), 4000) };
	}
}

const UNATTENDED_PROMPT = `# Unattended run
Nobody is watching this run and nobody can answer questions. Do not ask for confirmation or clarification: decide, do the work, and finish with a short report of what you did and anything you could not do. Actions that are not permitted are refused automatically; carry on without them.`;

const UNATTENDED_GUIDELINES = [
	"Nobody is watching this run: do not ask questions. Decide, do the work, and finish with a short report. Refused actions are skipped automatically.",
];

const AUTO_PROMPT = `# Auto mode
The user is not answering questions during this session and every action is permitted. Do not stop to ask which option to take or for confirmation: pick the most sensible choice yourself, state the assumption in one line, and carry on until the task is done.`;

const AUTO_GUIDELINES = [
	"Auto mode: every action is already permitted. Do not ask the user questions, present options, or wait for confirmation.",
	"When a choice is required, pick the most sensible option, state the assumption in one line, and continue until the task is done.",
];

/** Prompt sections PI will actually send. Mutate `systemPromptOptions` in place so later handlers compose instead of replacing the whole prompt. */
export function applyPermissionPrompt(
	event: { systemPromptOptions: { promptGuidelines: string[]; sections: Record<string, string> } },
	mode: PermissionMode,
	unattended?: RunAccess,
): void {
	const opts = event.systemPromptOptions;
	if (unattended) {
		opts.promptGuidelines.push(...UNATTENDED_GUIDELINES);
		opts.sections.unattended = UNATTENDED_PROMPT;
		return;
	}
	if (mode === "auto") {
		opts.promptGuidelines.push(...AUTO_GUIDELINES);
		opts.sections.auto_mode = AUTO_PROMPT;
	}
	if (mode === "plan") {
		opts.promptGuidelines.push(...PLAN_GUIDELINES);
		opts.sections.plan_mode = PLAN_PROMPT;
	}
}

const ACCESS_MODE: Record<RunAccess, PermissionMode> = { readonly: "plan", edits: "acceptEdits", full: "bypassPermissions" };

/**
 * Per-session permission state plus the PI extension that enforces it. The loader is per session,
 * so the extension can close over this object; the host wires `ask` and `onModeChange` after the
 * session exists.
 */
export class PermissionGate {
	mode: PermissionMode = "default";
	/** Set for runs without a user: nothing is ever asked, whatever `access` does not cover is refused. */
	unattended: RunAccess | undefined;
	/** Rules the user answered "always allow" for during this session. */
	readonly allowed = new Set<string>();
	ask: ((prompt: PermissionPrompt, signal?: AbortSignal) => Promise<string | undefined>) | undefined;
	onModeChange: ((mode: PermissionMode) => void) | undefined;

	/** Set by the host so the shared map is keyed by a stable session id. */
	sessionId = "";

	setMode(mode: PermissionMode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		if (this.sessionId) permissionModes.set(this.sessionId, mode);
		this.onModeChange?.(mode);
	}

	extension(): InlineExtension {
		return {
			name: "prometheus:permissions",
			factory: (pi) => {
				pi.registerTool({
					name: EXIT_PLAN_MODE,
					label: "提交计划",
					description: "Plan mode only: present the finished plan to the user for approval. Call it once the plan is complete; do not start changing anything before the user approves.",
					promptSnippet: `${EXIT_PLAN_MODE}: submit the plan for the user's approval (plan mode only)`,
					parameters: Type.Object({ plan: Type.String({ description: "The complete plan, in Markdown" }) }),
					defaultActive: false,
					execute: async (_id, params, signal) => {
						if (this.mode !== "plan") return text("Plan mode is not active; carry on with the task.");
						const answer = await this.ask?.({ kind: "plan", plan: params.plan }, signal);
						if (answer === "acceptEdits" || answer === "default") {
							this.setMode(answer);
							return text("The user approved the plan. Plan mode is over; implement it now.");
						}
						return text("The user did not approve the plan yet. Stay in plan mode: ask what they want changed, or revise the plan and submit it again.");
					},
				});

				pi.on("before_agent_start", (event, ctx) => {
					applyPermissionPrompt(event, this.mode, this.unattended);
					// Extensions on this same event read the mode from the shared map, so it must be
					// current before they run; PI runs handlers in registration order and the gate is first.
					const id = ctx?.sessionManager?.getSessionId();
					if (id) permissionModes.set(id, this.mode);
				});

				// A reload resets the active tools, which would drop the plan-mode exit tool.
				pi.on("session_start", () => {
					if (this.mode === "plan") this.onModeChange?.("plan");
				});

				pi.on("tool_call", async (event, ctx) => {
					const input = event.input as Record<string, unknown>;
					const readOnly = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations?.readOnlyHint === true;
					if (this.unattended) {
						const v = decide(ACCESS_MODE[this.unattended], { toolName: event.toolName, input, readOnly }, { cwd: ctx.cwd, allowed: this.allowed });
						if (v.type === "allow" && event.toolName !== INSTALL_PLUGIN_TOOL) return;
						return { block: true, reason: `This is an unattended run with ${this.unattended} access and this action is not permitted. Skip it and mention it in your report.` };
					}
					const verdict = decide(this.mode, { toolName: event.toolName, input, readOnly }, { cwd: ctx.cwd, allowed: this.allowed });
					if (verdict.type === "allow") return;
					if (verdict.type === "block") return { block: true, reason: verdict.reason };

					const key = ruleKey(event.toolName, input);
					const answer = await this.ask?.(
						{ kind: "tool", toolName: event.toolName, ...describe(event.toolName, input), alwaysLabel: key?.slice(key.indexOf(":") + 1) },
						ctx.signal,
					);
					if (answer === "allow") return;
					if (answer === "always" && key) {
						this.allowed.add(key);
						return;
					}
					return { block: true, reason: "The user denied this tool call. Do not retry it unchanged; ask what they would prefer." };
				});
			},
		};
	}
}
