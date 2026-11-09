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

/**
 * Restores a finished assistant message in the history the user sees.
 *
 * The in-process PI path only masks the outgoing request; nothing rewrites the reply, so a model that
 * echoes `{{PHONE_7K2M9XQA}}` would show (and persist) the alias instead of the real value. Text and
 * tool-call arguments are restored; signed or redacted thinking is left alone because editing it would
 * invalidate the provider's signature. Returns the same object when nothing changed. The next request
 * masks the restored text again, and the same plaintext always maps to the same alias.
 */
export function restoreAssistantMessage<T extends { role?: unknown; content?: unknown }>(message: T, store: MappingStore): T {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	let changed = false;
	const content = message.content.map((block: unknown) => {
		if (!block || typeof block !== "object") return block;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			const text = restoreString(b.text, store);
			if (text === b.text) return block;
			changed = true;
			return { ...b, text };
		}
		if (b.type === "thinking" && typeof b.thinking === "string" && !b.thinkingSignature && !b.redacted) {
			const thinking = restoreString(b.thinking, store);
			if (thinking === b.thinking) return block;
			changed = true;
			return { ...b, thinking };
		}
		if (b.type === "toolCall" && b.arguments && typeof b.arguments === "object") {
			const args = restoreJson(b.arguments as Json, store);
			if (JSON.stringify(args) === JSON.stringify(b.arguments)) return block;
			changed = true;
			return { ...b, arguments: args };
		}
		return block;
	});
	return changed ? { ...message, content } : message;
}

/**
 * Restores placeholders inside a tool call's input, in place (that is how PI lets a `tool_call` handler
 * change arguments). The model only ever saw aliases, so a command, path or password it wrote would
 * otherwise run with the alias text. Returns whether anything changed.
 */
export function restoreInPlace(value: unknown, store: MappingStore): boolean {
	let changed = false;
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			node.forEach((item, i) => {
				if (typeof item === "string") {
					const next = restoreString(item, store);
					if (next !== item) {
						node[i] = next;
						changed = true;
					}
				} else visit(item);
			});
		} else if (node && typeof node === "object") {
			const obj = node as Record<string, unknown>;
			for (const key of Object.keys(obj)) {
				const item = obj[key];
				if (typeof item === "string") {
					const next = restoreString(item, store);
					if (next !== item) {
						obj[key] = next;
						changed = true;
					}
				} else visit(item);
			}
		}
	};
	visit(value);
	return changed;
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
