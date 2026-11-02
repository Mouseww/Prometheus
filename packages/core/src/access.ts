import type { PermissionMode, RunAccess } from "@prometheus/protocol";

const RANK: Record<RunAccess, number> = { readonly: 0, edits: 1, full: 2 };

/** The larger of two access levels is never granted: a delegated run gets the lower of what it asks for and what its parent may do. */
export function clampAccess(requested: RunAccess, ceiling: RunAccess): RunAccess {
	return RANK[requested] <= RANK[ceiling] ? requested : ceiling;
}

/** What a chat in this permission mode may hand on. Asking for each action ("default") is not a licence to edit unattended. */
export function accessOfMode(mode: PermissionMode): RunAccess {
	switch (mode) {
		case "bypassPermissions":
		case "auto":
			return "full";
		case "acceptEdits":
			return "edits";
		default:
			return "readonly";
	}
}

/**
 * The ceiling for a run started on behalf of another session. A session that is itself unattended is capped at its own
 * access; an unknown parent gets nothing beyond reading.
 */
export function ceilingFor(parent: { unattended?: RunAccess; mode: PermissionMode } | undefined): RunAccess {
	if (!parent) return "readonly";
	return parent.unattended ?? accessOfMode(parent.mode);
}
