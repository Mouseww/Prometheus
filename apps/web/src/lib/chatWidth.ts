/** Chat column width: one CSS variable, set on the chat container and read by the message list, composer and panels. */
export const CHAT_WIDTH_VAR = "--chat-width";
export const CHAT_WIDTH_MIN = 640;
export const CHAT_WIDTH_ADAPTIVE_MIN = 768;
export const CHAT_WIDTH_ADAPTIVE_MAX = 1040;
/** Room kept free on both sides for the drag handles. */
export const CHAT_WIDTH_EDGE = 96;

/**
 * Width to show for the available column width. No saved preference adapts to the window
 * (clamp 768..1040, 72%), so a big or high-DPI window gets a wider column automatically.
 * A saved preference is only clamped for display, never overwritten, so it returns when the window grows back.
 */
export function resolveChatWidth(column: number, preference: number | null): number {
	const max = Math.max(CHAT_WIDTH_MIN, column - CHAT_WIDTH_EDGE);
	if (preference !== null) return Math.min(Math.max(preference, CHAT_WIDTH_MIN), max);
	return Math.min(Math.max(column * 0.72, CHAT_WIDTH_ADAPTIVE_MIN), CHAT_WIDTH_ADAPTIVE_MAX, Math.max(CHAT_WIDTH_MIN, column));
}

/** Turns the displayed width after a drag into the preference to store, so nudging while the window is small can't shrink a wider saved choice. */
export function preferenceFromDrag(column: number, startPreference: number, startDisplay: number, rawDisplay: number): number {
	const clamped = resolveChatWidth(column, rawDisplay);
	return Math.max(CHAT_WIDTH_MIN, Math.round(startPreference + (clamped - startDisplay)));
}
