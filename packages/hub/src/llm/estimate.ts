/** Tokens charged for an inline image or file part, whatever its encoded size (base64 bytes say nothing about token count). */
const BLOB_TOKENS = 1500;
const CHARS_PER_TOKEN = 4;

/**
 * Rough input size of an LLM request for the billing pre-check: text characters / 4, plus a flat amount per inline blob.
 * It only has to be in the right order of magnitude (the real cost is booked from the upstream's usage report afterwards);
 * what matters is that a huge prompt can no longer pass a check that looked at the output cap alone.
 */
export function estimateInputTokens(body: unknown, rawBytes: number): number {
	if (body === undefined || body === null) return Math.ceil(rawBytes / CHARS_PER_TOKEN);
	let chars = 0;
	let blobs = 0;
	const walk = (value: unknown, key: string | undefined): void => {
		if (typeof value === "string") {
			// Inline data: data URLs, and the `data` field of Anthropic base64 sources and Gemini inlineData.
			if (value.startsWith("data:") || (key === "data" && value.length > 256 && !/\s/.test(value.slice(0, 256)))) blobs += 1;
			else chars += value.length;
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item, key);
			return;
		}
		if (typeof value === "object" && value !== null) {
			for (const [k, v] of Object.entries(value)) walk(v, k);
		}
	};
	walk(body, undefined);
	return Math.ceil(chars / CHARS_PER_TOKEN) + blobs * BLOB_TOKENS;
}
