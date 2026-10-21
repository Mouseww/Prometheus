import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ALLOWLIST, RuleSet, builtinRules } from "../src/engine/rules.ts";
import { RestoreWindow } from "../src/engine/sliding.ts";
import { MappingStore } from "../src/engine/store.ts";
import { desensitizeJson, desensitizeString, restoreJson, restoreString, type Json } from "../src/engine/walk.ts";
import { findPlaceholders, parsePlaceholder } from "../src/engine/placeholder.ts";
import { shouldSkipDesensitize } from "../src/engine/binary.ts";

let dir: string;
let store: MappingStore;
const rules = () => new RuleSet({ rules: builtinRules(), allowlist: DEFAULT_ALLOWLIST });

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "veil-test-"));
	store = new MappingStore({ path: join(dir, "mappings.json"), ttlDays: 0 });
});

afterEach(async () => {
	await store.flush();
	await rm(dir, { recursive: true, force: true });
});

describe("placeholder", () => {
	it("formats and parses a round trip", () => {
		const token = store.getOrInsert("PHONE", "13800138000");
		expect(token).toMatch(/^\{\{PHONE_[0-9A-HJKMNP-TV-Z]{26}\}\}$/);
		const parsed = parsePlaceholder(token);
		expect(parsed?.typePrefix).toBe("PHONE");
	});

	it("rejects documentation examples and mustache templates", () => {
		expect(parsePlaceholder("{{PHONE_xxxx}}")).toBeUndefined();
		expect(parsePlaceholder("{{TODO_1}}")).toBeUndefined();
		expect(parsePlaceholder("{{phone_01ARZ3NDEKTSV4RRFFQ69G5FAV}}")).toBeUndefined();
	});
});

describe("store", () => {
	it("reuses the same placeholder for the same plaintext", () => {
		const a = store.getOrInsert("PHONE", "13800138000");
		const b = store.getOrInsert("PHONE", "13800138000");
		expect(a).toBe(b);
	});

	it("looks up what it issued and nothing else", () => {
		const token = store.getOrInsert("PHONE", "13800138000");
		expect(store.lookup(token)).toBe("13800138000");
		expect(store.lookup("{{PHONE_01ARZ3NDEKTSV4RRFFQ69G5FAV}}")).toBeUndefined();
	});

	it("persists across reloads so old conversations still restore", async () => {
		const token = store.getOrInsert("PHONE", "13800138000");
		await store.flush();
		const second = new MappingStore({ path: join(dir, "mappings.json"), ttlDays: 0 });
		const loaded = await second.load();
		expect(loaded.loaded).toBe(1);
		expect(second.lookup(token)).toBe("13800138000");
	});

	it("stores keys as hashes, not plaintext", async () => {
		store.getOrInsert("PHONE", "13800138000");
		await store.flush();
		const raw = await readFile(join(dir, "mappings.json"), "utf8");
		const parsed = JSON.parse(raw) as { entries: Record<string, unknown> };
		// The value has to be recoverable, but the key must not be the secret itself.
		expect(Object.keys(parsed.entries).every((k) => /^[0-9a-f]{16}$/.test(k))).toBe(true);
	});
});

describe("walk round trip", () => {
	it("masks a text request and restores it", () => {
		const original = "查一下 mysql://root:Pass123@10.1.2.3:3306/app，电话打 13800138000";
		const masked = desensitizeString(original, rules(), store);
		expect(masked).not.toContain("13800138000");
		expect(masked).not.toContain("10.1.2.3");
		expect(restoreString(masked, store)).toBe(original);
	});

	it("masks only string values of a JSON payload", () => {
		const payload: Json = {
			model: "claude",
			messages: [{ role: "user", content: "call 13800138000" }],
			key_like_name: "13800138000",
		};
		const masked = desensitizeJson(payload, rules(), store);
		const asText = JSON.stringify(masked);
		expect(asText).not.toContain("13800138000");
		// Keys are untouched, so the request schema still matches.
		expect(asText).toContain('"key_like_name"');
		expect(restoreJson(masked, store)).toEqual(payload);
	});

	it("leaves base64 image payloads byte-identical", () => {
		const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const payload: Json = { type: "base64", media_type: "image/png", data: tiny };
		const masked = desensitizeJson(payload, rules(), store) as { data: string };
		expect(masked.data).toBe(tiny);
	});

	it("keeps one placeholder per secret even across different calls", () => {
		const first = desensitizeString("13800138000", rules(), store);
		const second = desensitizeString("call 13800138000 again", rules(), store);
		const token = findPlaceholders(first)[0]?.token;
		expect(token).toBeDefined();
		expect(second).toContain(token as string);
	});
});

describe("binary skip", () => {
	it("detects data urls", () => {
		expect(shouldSkipDesensitize(undefined, "data:image/png;base64,AAAA")).toBe(true);
		expect(shouldSkipDesensitize(undefined, "data:text/plain,hello")).toBe(false);
	});

	it("does not skip ordinary secrets", () => {
		expect(shouldSkipDesensitize("content", "call 13800138000 at 10.0.0.5")).toBe(false);
	});
});

describe("streaming window", () => {
	it("restores a placeholder split across two pushes", () => {
		const token = store.getOrInsert("PHONE", "13800138000");
		const mid = Math.floor(token.length / 2);
		const window = new RestoreWindow(store);
		let out = window.push(token.slice(0, mid));
		out += window.push(token.slice(mid));
		out += window.flush();
		expect(out).toBe("13800138000");
	});

	it("emits a safe prefix immediately rather than buffering the whole stream", () => {
		const window = new RestoreWindow(store);
		expect(window.push("hello ")).toBe("hello ");
	});

	it("passes an unknown token through unchanged", () => {
		const window = new RestoreWindow(store);
		const fake = "{{PHONE_01ARZ3NDEKTSV4RRFFQ69G5FAV}}";
		expect(window.push(fake) + window.flush()).toBe(fake);
	});
});
