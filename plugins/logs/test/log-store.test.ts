import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureConsole, LogStore, scrub } from "../src/log-store.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "logs-")), "errors.jsonl");

describe("LogStore", () => {
	it("keeps the newest entries first and persists across instances", () => {
		const file = tmp();
		const a = new LogStore(file);
		a.add("error", "one");
		a.add("warn", "two");
		expect(a.list().map((e) => e.message)).toEqual(["two", "one"]);
		expect(a.list("error").map((e) => e.message)).toEqual(["one"]);
		expect(new LogStore(file).list().length).toBe(2);
	});

	it("caps the number of entries", () => {
		const s = new LogStore(tmp(), 3);
		for (let i = 0; i < 10; i++) s.add("error", `m${i}`);
		expect(s.list().map((e) => e.message)).toEqual(["m9", "m8", "m7"]);
	});

	it("clears memory and file", () => {
		const file = tmp();
		const s = new LogStore(file);
		s.add("error", "x");
		s.clear();
		expect(s.list()).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("");
	});

	it("masks credentials", () => {
		const body = "abcdefghijklmnop1234";
		expect(scrub(`key ${"sk"}-${body}`)).not.toContain(body);
		expect(scrub(`${"Bearer"} ${body}`)).not.toContain(body);
		expect(scrub(`apiKey=${body}`)).not.toContain(body);
	});
});

describe("captureConsole", () => {
	it("records console.error/warn, still calls the original, and restores", () => {
		const seen: unknown[][] = [];
		const target = { error: (...a: unknown[]) => void seen.push(a), warn: (...a: unknown[]) => void seen.push(a) };
		const original = target.error;
		const store = new LogStore(tmp());
		const restore = captureConsole(store, target);
		target.error("boom", new Error("bad").message);
		target.warn("careful");
		expect(seen).toHaveLength(2);
		expect(store.counts()).toEqual({ error: 1, warn: 1 });
		expect(store.list("error")[0]?.message).toBe("boom bad");
		restore();
		expect(target.error).toBe(original);
	});
});
