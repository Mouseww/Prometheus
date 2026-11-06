import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { decide } from "./permissions.ts";

/** The administrator locks a guard enforces. */
export interface GuardPolicy {
	disabledTools?: readonly string[];
	readOutsideProject?: "allow" | "ask" | "deny";
}

export const READ_OUTSIDE_UNATTENDED_REASON =
	"Reading outside the working folder needs the owner's confirmation, which a subagent cannot get. Stay inside the project folder.";

/** Subagent runners that start an external CLI, which Prometheus cannot gate call by call. */
export type CliRunner = "claude-code" | "codex";

/**
 * The first administrator lock a CLI subagent runner cannot enforce, or undefined when it can run.
 * Claude Code takes disabled tools through `--disallowedTools` but cannot be kept inside the project folder;
 * Codex can do neither, so any lock refuses it.
 */
export function unenforceableLock(runner: CliRunner, policy: GuardPolicy | undefined): keyof GuardPolicy | undefined {
	const readLocked = policy?.readOutsideProject === "ask" || policy?.readOutsideProject === "deny";
	if (runner === "codex" && policy?.disabledTools?.length) return "disabledTools";
	if (readLocked) return "readOutsideProject";
	return undefined;
}

/**
 * Enforces only the administrator locks, for sessions that have no permission gate (subagent children).
 * Everything else is allowed as before; a read the policy would ask about is refused, since nobody can answer.
 */
export function policyGuardExtension(policy: GuardPolicy): InlineExtension {
	return {
		name: "prometheus:policy-guard",
		hidden: true,
		factory: (pi) => {
			pi.on("tool_call", (event, ctx) => {
				const verdict = decide("bypassPermissions", { toolName: event.toolName, input: event.input as Record<string, unknown> }, { cwd: ctx.cwd, allowed: new Set(), policy });
				if (verdict.type === "block") return { block: true, reason: verdict.reason };
				if (verdict.type === "ask") return { block: true, reason: READ_OUTSIDE_UNATTENDED_REASON };
				return undefined;
			});
		},
	};
}
