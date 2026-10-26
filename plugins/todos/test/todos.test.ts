import { describe, expect, it } from "vitest";
import { parseTodos } from "@prometheus/protocol";
import plugin, { problem, summarize } from "../src/index.ts";

describe("parseTodos", () => {
	it("reads the wrapped and the bare form", () => {
		const list = [{ content: "a", status: "completed" }];
		expect(parseTodos({ todos: list })).toEqual([{ content: "a", status: "completed" }]);
		expect(parseTodos(list)).toEqual([{ content: "a", status: "completed" }]);
	});

	it("is lenient about bad input", () => {
		expect(parseTodos(undefined)).toEqual([]);
		expect(parseTodos({ todos: "nope" })).toEqual([]);
		expect(parseTodos({ todos: [null, 3, { content: "  " }, { content: "ok", status: "weird" }] })).toEqual([{ content: "ok", status: "pending" }]);
	});

	it("keeps activeForm, trims and caps", () => {
		const out = parseTodos({ todos: [{ content: " Run tests ", status: "in_progress", activeForm: " Running tests " }] });
		expect(out).toEqual([{ content: "Run tests", status: "in_progress", activeForm: "Running tests" }]);
		expect(parseTodos({ todos: Array.from({ length: 80 }, (_, i) => ({ content: `t${i}` })) })).toHaveLength(50);
	});
});

describe("problem / summarize", () => {
	it("rejects empty lists and several in-progress items", () => {
		expect(problem([])).toMatch(/empty/);
		const two = parseTodos([{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }]);
		expect(problem(two)).toMatch(/2 items/);
		expect(problem(parseTodos([{ content: "a", status: "in_progress" }, { content: "b" }]))).toBeUndefined();
	});

	it("summarizes progress", () => {
		const todos = parseTodos([{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c" }]);
		expect(summarize(todos)).toBe("1/3 done; now: b");
	});
});

describe("todos plugin", () => {
	it("registers todo_write whose result carries the parsed list", async () => {
		const tools: { name: string; execute: (...a: unknown[]) => Promise<{ details: { todos: unknown[] }; content: { text: string }[] }> }[] = [];
		await plugin.setup({ tools: { register: (t: never) => tools.push(t) } } as never);
		const tool = tools.find((t) => t.name === "todo_write");
		expect(tool).toBeDefined();
		const res = await tool!.execute("1", { todos: [{ content: "a", status: "in_progress" }] });
		expect(res.details.todos).toEqual([{ content: "a", status: "in_progress" }]);
		expect(res.content[0]?.text).toContain("0/1 done");
		await expect(tool!.execute("2", { todos: [] })).rejects.toThrow(/empty/);
	});
});
