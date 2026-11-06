import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { decide } from "./permissions.ts";

/** The administrator locks a guard enforces. */
export interface GuardPolicy {
	disabledTools?: readonly string[];
	readOutsideProject?: "allow" | "ask" | "deny";
}

export const READ_OUTSIDE_UNATTENDED_REASON =
	"Reading outside the working folder needs the owner's confirmation, which a subagent cannot get. Stay inside the project folder.";

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
