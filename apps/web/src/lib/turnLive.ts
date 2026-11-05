/**
 * Whether an assistant turn is the one currently being generated.
 *
 * A new send sets `streaming` before the next user message is in the transcript, so the
 * previous reply is still lastIndex (or still looks like it is awaiting the next model
 * call). Treating that finished turn as live unfolds every collapsed step and the
 * conversation jumps.
 */
export function assistantTurnLive(input: {
	streaming: boolean;
	/** Fresh prompt echoed as a pending bubble; not yet a user message in `messages`. */
	pending: boolean;
	lastInGroup: number;
	lastIndex: number;
	lastNonResult: number;
	stopReason?: string;
}): boolean {
	if (!input.streaming) return false;
	// The next prompt is on screen as a placeholder: no existing turn belongs to this run yet.
	if (input.pending) return false;
	const awaitingNext = input.lastInGroup < input.lastIndex && input.lastNonResult === input.lastInGroup;
	if (awaitingNext) return true;
	if (input.lastInGroup !== input.lastIndex) return false;
	// Completed reply that is still last while the next run has started (or has not produced tokens yet).
	if (input.stopReason && input.stopReason !== "pending" && input.stopReason !== "toolUse") return false;
	return true;
}
