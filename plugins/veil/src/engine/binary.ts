/**
 * Opaque payload detection. Ported from veil's `binary.rs`.
 *
 * Multimodal APIs put image bytes in JSON strings. Running phone/IP/token rules over those blobs
 * rewrites substrings and produces invalid base64, so they must be skipped wholesale.
 */

/** `data:<mime>;base64,<payload>`, any mime. The whole string is opaque. */
export function isDataUrlBase64(text: string): boolean {
	const t = text.trim();
	if (t.length < 13 || !t.startsWith("data:")) return false;
	return /;base64,/i.test(t);
}

/** True when the text is (almost) only standard or URL-safe base64 alphabet. */
export function looksLikeBase64Blob(text: string): boolean {
	const t = text.trim();
	if (t.length < 32) return false;
	let alnum = 0;
	for (const ch of t) {
		if (/[A-Za-z0-9+/=_-]/.test(ch)) alnum++;
		else if (!/\s/.test(ch)) return false;
	}
	return alnum >= 32;
}

const BINARY_KEYS = new Set(["data", "image", "b64_json", "inline_data", "file_data", "content_base64", "audio", "video"]);

/** Whether outbound desensitisation should leave this string untouched. `key` is the owning JSON key, when known. */
export function shouldSkipDesensitize(key: string | undefined, text: string): boolean {
	if (isDataUrlBase64(text)) return true;
	if (!looksLikeBase64Blob(text)) return false;
	if (key !== undefined && BINARY_KEYS.has(key)) return true;
	// Raw multimodal blobs often sit under generic keys; long pure base64 is opaque.
	return text.trim().length >= 200;
}
