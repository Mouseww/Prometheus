/**
 * Desensitise and restore JSON / plain text. Ported from veil's `walk.rs`.
 *
 * Only string values are touched, never keys: rewriting a key would change the request schema.
 * Multimodal blobs (`data`, long base64) are skipped so image payloads stay byte-identical.
 */
import { shouldSkipDesensitize } from "./binary.ts";
import { findPlaceholders } from "./placeholder.ts";
import { type RuleSet } from "./rules.ts";
import type { MappingStore } from "./store.ts";

export class WalkError extends Error {}

/** Any JSON value; the walker preserves structure exactly. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function mapStrings(value: Json, key: string | undefined, f: (key: string | undefined, text: string) => string): Json {
	if (typeof value === "string") return f(key, value);
	if (Array.isArray(value)) return value.map((item) => mapStrings(item, undefined, f));
	if (value && typeof value === "object") {
		const sourceIsBinary =
			(value.type === "base64" || value.type === "BASE64") ||
			(typeof value.media_type === "string" && /^(image|audio|video)\//i.test(value.media_type));
		const out: { [key: string]: Json } = {};
		for (const [childKey, child] of Object.entries(value)) {
			const effective = sourceIsBinary && childKey === "data" ? "data" : childKey;
			out[childKey] = mapStrings(child, effective, f);
		}
		return out;
	}
	return value;
}

export function desensitizeString(text: string, rules: RuleSet, store: MappingStore): string {
	const hits = rules.findHits(text);
	if (hits.length === 0) return text;
	let out = text;
	// Replace from the end so earlier offsets stay valid.
	for (let i = hits.length - 1; i >= 0; i--) {
		const hit = hits[i] as (typeof hits)[number];
		out = out.slice(0, hit.start) + store.getOrInsert(hit.typePrefix, hit.plaintext) + out.slice(hit.end);
	}
	return out;
}

export function restoreString(text: string, store: MappingStore): string {
	const found = findPlaceholders(text);
	if (found.length === 0) return text;
	let out = text;
	for (let i = found.length - 1; i >= 0; i--) {
		const item = found[i] as (typeof found)[number];
		const plaintext = store.lookup(item.token);
		// A token this table never issued is left as-is: a model may quote an example verbatim.
		if (plaintext === undefined) continue;
		out = out.slice(0, item.start) + plaintext + out.slice(item.end);
	}
	return out;
}

export function desensitizeJson(value: Json, rules: RuleSet, store: MappingStore): Json {
	return mapStrings(value, undefined, (key, text) => {
		if (shouldSkipDesensitize(key, text)) return text;
		return desensitizeString(text, rules, store);
	});
}

export function restoreJson(value: Json, store: MappingStore): Json {
	return mapStrings(value, undefined, (_key, text) => restoreString(text, store));
}

/** Best-effort JSON parse; returns undefined for non-JSON input. */
export function parseJson(text: string): Json | undefined {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(text) as Json;
	} catch {
		return undefined;
	}
}
