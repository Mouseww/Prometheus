export type LiveStatus = "running" | "waiting" | "idle";
export type SessionStatus = LiveStatus | "offline";

/** The inputs of the status machine; `offline` is layered on top by presence tracking and is not part of the state. */
export interface StatusState {
	agentRunning: boolean;
	/** Ids of UI requests (permission, select, confirm, input...) that are not resolved yet. */
	pending: readonly string[];
}

export const initialStatusState: StatusState = { agentRunning: false, pending: [] };

export function deriveStatus(state: StatusState): LiveStatus {
	if (state.pending.length > 0) return "waiting";
	return state.agentRunning ? "running" : "idle";
}

const requestIdOf = (payload: unknown): string | undefined => {
	if (typeof payload !== "object" || payload === null) return undefined;
	const id = (payload as { requestId?: unknown }).requestId;
	return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
};

/**
 * Folds one mirrored event into the state (spec 6.2 and 12.5 item 1):
 * agent_start / agent_end toggle running; ui_request adds a pending request and ui_resolved removes it.
 */
export function applyEvent(state: StatusState, event: { kind: string; payload: unknown }): StatusState {
	switch (event.kind) {
		case "agent_start":
			return { ...state, agentRunning: true };
		case "agent_end":
			return { ...state, agentRunning: false };
		case "ui_request": {
			const id = requestIdOf(event.payload);
			if (id === undefined || state.pending.includes(id)) return state;
			return { ...state, pending: [...state.pending, id] };
		}
		case "ui_resolved": {
			const id = requestIdOf(event.payload);
			if (id === undefined || !state.pending.includes(id)) return state;
			return { ...state, pending: state.pending.filter((p) => p !== id) };
		}
		default:
			return state;
	}
}
