/**
 * Streaming restore. Ported from veil's `sliding.rs`.
 *
 * A placeholder can be split across two stream chunks, so the tail of each chunk is held back
 * until it is provably not the start of a token. Holding is bounded (max 96 chars), so a stream
 * that never emits `{{` is not delayed.
 */
import { findPlaceholders } from "./placeholder.ts";
import type { MappingStore } from "./store.ts";

/** A placeholder is at most 63 chars; 96 is a safe bound. */
const MAX_HOLD = 96;

/** Index where a suffix that may still be the prefix of `{{TYPE_ULID}}` starts. */
function holdSuffixStart(s: string): number {
	const i = s.lastIndexOf("{");
	if (i === -1) return s.length;
	if (i > 0 && s[i - 1] === "{" && isPlaceholderPrefix(s.slice(i - 1))) return i - 1;
	if (isPlaceholderPrefix(s.slice(i))) return i;
	return s.length;
}

function isPlaceholderPrefix(s: string): boolean {
	if (!s.startsWith("{")) return false;
	if (s.length === 1) return true;
	if (s[1] !== "{") return false;
	if (s.length === 2) return true;
	const rest = s.slice(2);
	let typeLen = 0;
	let ulidAt: number | undefined;
	for (let i = 0; i < rest.length; i++) {
		const c = rest[i] as string;
		if (c === "_") {
			if (typeLen === 0) return false;
			ulidAt = 2 + i + 1;
			break;
		}
		if (typeLen === 0) {
			if (!/[A-Z]/.test(c)) return false;
		} else if (!/[A-Z0-9]/.test(c)) return false;
		typeLen++;
		if (typeLen > 32) return false;
	}
	if (ulidAt === undefined) return true;
	return isUlidClosePrefix(s.slice(ulidAt));
}

function isUlidClosePrefix(s: string): boolean {
	let i = 0;
	while (i < s.length && i < 26) {
		const c = s[i] as string;
		if (c === "}") return false;
		if (!/[0-9A-HJKMNP-TV-Z]/.test(c)) return false;
		i++;
	}
	const rest = s.slice(i);
	return rest === "" || rest === "}";
}

export class RestoreWindow {
	private tail = "";
	readonly store: MappingStore;

	constructor(store: MappingStore) {
		this.store = store;
	}

	push(chunk: string): string {
		this.tail += chunk;
		return this.emit(false);
	}

	flush(): string {
		return this.emit(true);
	}

	private emit(flush: boolean): string {
		const buf = this.tail;
		this.tail = "";
		let out = "";
		let last = 0;
		for (const found of findPlaceholders(buf)) {
			out += buf.slice(last, found.start);
			const plaintext = this.store.lookup(found.token);
			out += plaintext === undefined ? found.token : plaintext;
			last = found.end;
		}
		const remaining = buf.slice(last);
		if (flush) return out + remaining;
		const holdAt = holdSuffixStart(remaining);
		out += remaining.slice(0, holdAt);
		const keep = remaining.slice(holdAt);
		if (keep.length > MAX_HOLD && !keep.startsWith("{{")) out += keep;
		else this.tail = keep;
		return out;
	}
}

