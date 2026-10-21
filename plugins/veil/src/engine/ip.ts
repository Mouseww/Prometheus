/**
 * Parse-based IPv4/IPv6 detection. Ported from veil's `ip.rs`.
 *
 * A regex over dotted quads both over- and under-matches (versions, hashes, `host:port`), so the
 * token is split on common delimiters and handed to Node's own address parser.
 */

/** Characters that always end an IP candidate token. Letters are *not* delimiters, so `v1.2.3.4` stays one non-IP token. */
const DELIMS = new Set([" ", "\t", "\n", "\r", "/", ",", ";", "|", "(", ")", "[", "]", "=", "@", '"', "'", "<", ">", "{", "}", "\f", "\v"]);

const TRAILING_PUNCT = new Set([".", ",", ":", ";", "!", "?", "。", "，", "："]);

function isDelim(ch: string): boolean {
	return DELIMS.has(ch) || /\s/.test(ch);
}

/** `net.isIP` accepts some forms the WHATWG URL parser rejects; mirror veil by using a strict parser. */
function parseIpv4(token: string): boolean {
	const parts = token.split(".");
	if (parts.length !== 4) return false;
	return parts.every((p) => p.length > 0 && p.length <= 3 && /^\d+$/.test(p) && Number(p) <= 255);
}

function parseIpv6(token: string): boolean {
	if (!token.includes(":")) return false;
	// URL rejects neither brackets nor zones; strip the common wrappers first.
	const bare = token.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
	try {
		// eslint-disable-next-line no-new
		new URL(`http://[${bare}]/`);
		return true;
	} catch {
		return false;
	}
}

function parseIp(token: string): boolean {
	return parseIpv4(token) || parseIpv6(token);
}

function trimTrailingPunct(text: string, start: number, end: number): number {
	let e = end;
	while (e > start) {
		const ch = String.fromCodePoint(text.codePointAt(e - 1) ?? 0);
		// A surrogate half is never trailing punctuation; back off one code point at a time.
		const cp = text.codePointAt(e - 1) ?? 0;
		const width = cp > 0xffff ? 2 : 1;
		if (!TRAILING_PUNCT.has(ch) && ![...ch].some((c) => TRAILING_PUNCT.has(c))) break;
		e -= width;
	}
	return e;
}

function considerColonSplit(text: string, start: number, end: number, spans: [number, number][]): void {
	let subStart = start;
	for (const part of text.slice(start, end).split(":")) {
		const subEnd = subStart + part.length;
		if (parseIpv4(part)) spans.push([subStart, subEnd]);
		subStart = subEnd + 1;
	}
}

function considerToken(text: string, start: number, end: number, spans: [number, number][]): void {
	if (start >= end) return;
	const token = text.slice(start, end);
	if (parseIp(token)) {
		spans.push([start, end]);
		return;
	}
	const trimmed = trimTrailingPunct(text, start, end);
	if (trimmed !== end) {
		if (parseIp(text.slice(start, trimmed))) {
			spans.push([start, trimmed]);
			return;
		}
		considerColonSplit(text, start, trimmed, spans);
		return;
	}
	considerColonSplit(text, start, end, spans);
}

/** Byte offsets of parseable IP addresses in `text`. */
export function findIpSpans(text: string): [number, number][] {
	const spans: [number, number][] = [];
	let i = 0;
	while (i < text.length) {
		const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
		if (isDelim(ch)) {
			i += ch.length;
			continue;
		}
		const start = i;
		i += ch.length;
		while (i < text.length) {
			const c = String.fromCodePoint(text.codePointAt(i) ?? 0);
			if (isDelim(c)) break;
			i += c.length;
		}
		considerToken(text, start, i, spans);
	}
	return spans;
}
