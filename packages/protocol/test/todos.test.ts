import { describe, expect, it } from "vitest";
import { latestTodos, type ChatMessage } from "../src/index.ts";

const call = (id: string, todos: unknown): ChatMessage =>
	({ role: "assistant", content: [{ type: "toolCall", id, name: "todo_write", arguments: { todos } }], stopReason: "toolUse", timestamp: 1 }) as unknown as ChatMessage;
const result = (id: string, isError: boolean): ChatMessage => ({ role: "toolResult", toolCallId: id, toolName: "todo_write", content: [], isError, timestamp: 2 });

describe("latestTodos", () => {
	it("returns the newest successful list", () => {
		const msgs = [call("a", [{ content: "one", status: "pending" }]), result("a", false), call("b", [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }]), result("b", false)];
		expect(latestTodos(msgs)).toEqual([{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }]);
	});

	it("shows a call that has not returned yet, so progress appears immediately", () => {
		expect(latestTodos([call("a", [{ content: "x", status: "in_progress" }])])).toHaveLength(1);
	});

	it("ignores a call the tool rejected and falls back to the previous list", () => {
		const msgs = [call("a", [{ content: "good", status: "pending" }]), result("a", false), call("b", [{ content: "x", status: "in_progress" }, { content: "y", status: "in_progress" }]), result("b", true)];
		expect(latestTodos(msgs).map((t) => t.content)).toEqual(["good"]);
	});

	it("ignores other tools, empty lists and non-assistant messages", () => {
		const other = { role: "assistant", content: [{ type: "toolCall", id: "z", name: "bash", arguments: { todos: [{ content: "no" }] } }], timestamp: 1 } as unknown as ChatMessage;
		expect(latestTodos([other])).toEqual([]);
		expect(latestTodos([call("a", [])])).toEqual([]);
		expect(latestTodos([{ role: "user", content: "hi", timestamp: 1 }])).toEqual([]);
		expect(latestTodos([])).toEqual([]);
	});
});
