/**
 * `{{TYPE_ULID}}` tokens. Ported from veil's `placeholder.rs`.
 *
 * The shape is deliberately narrow: an uppercase type of 1..=32 chars, an underscore, then a
 * 26-character Crockford base32 ULID. A token that does not parse is left alone, so ordinary
 * mustache templates (`{{TODO_1}}`) pass through untouched.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Same pattern as veil: `[A-Z][A-Z0-9]{0,31}_[0-9A-HJKMNP-TV-Z]{26}` inside double braces.
 * A factory, not a shared literal: a module-level `/g` regex carries `lastIndex` between calls,
 * and any re-entrant scan would silently skip matches.
 */
export const placeholderPattern = (): RegExp => /\{\{([A-Z][A-Z0-9]{0,31})_([0-9A-HJKMNP-TV-Z]{26})\}\}/g;

export interface Placeholder {
	typePrefix: string;
	id: string;
}

/** Fresh ULID: 48-bit millisecond timestamp + 80 bits of randomness, Crockford encoded. */
export function newUlid(now = Date.now(), random: () => number = Math.random): string {
	let time = "";
	let t = now;
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32] + time;
		t = Math.floor(t / 32);
	}
	let rest = "";
	for (let i = 0; i < 16; i++) rest += CROCKFORD[Math.floor(random() * 32) % 32];
	return time + rest;
}

export function formatPlaceholder(p: Placeholder): string {
	return `{{${p.typePrefix}_${p.id}}}`;
}

/** Parses a complete token; the whole string must match. */
export function parsePlaceholder(token: string): Placeholder | undefined {
	const m = placeholderPattern().exec(token);
	if (!m || m[0] !== token) return undefined;
	return { typePrefix: m[1] as string, id: m[2] as string };
}

/** All tokens found in `text`, in order. */
export function findPlaceholders(text: string): { start: number; end: number; token: string; parsed: Placeholder }[] {
	const out: { start: number; end: number; token: string; parsed: Placeholder }[] = [];
	const pattern = placeholderPattern();
	for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
		const parsed = parsePlaceholder(m[0]);
		if (parsed) out.push({ start: m.index, end: m.index + m[0].length, token: m[0], parsed });
	}
	// Zero-length matches cannot loop forever here: the pattern consumes at least 32 chars.
	return out;
}
