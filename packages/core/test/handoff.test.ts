import type { ChatMessage } from "@prometheus/protocol";
import { describe, expect, it } from "vitest";
import { buildHandoff, handoffBlock } from "../src/agent/handoff.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

describe("buildHandoff", () => {
	it("renders user, assistant, tool calls and tool results", () => {
		const messages = [
			{ role: "user", content: "fix the bug", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }], provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 2 },
			{ role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "x".repeat(1000) }], isError: false, timestamp: 3 },
		] as ChatMessage[];
		const out = buildHandoff(messages, "PI");
		expect(out).toContain("started in PI");
		expect(out).toContain("User: fix the bug");
		expect(out).toContain('[tool read({"path":"a.ts"})]');
		expect(out).toContain("…");
		expect(out.length).toBeLessThan(1200);
	});

	it("is empty when there is nothing to carry over", () => {
		expect(buildHandoff([], "PI")).toBe("");
	});

	it("keeps the most recent part of a long conversation", () => {
		const messages = Array.from({ length: 200 }, (_, i) => ({ role: "user", content: `message ${i} ${"y".repeat(1000)}`, timestamp: i })) as ChatMessage[];
		const out = buildHandoff(messages, "Codex");
		expect(out).toContain("[earlier messages omitted]");
		expect(out).toContain("message 199");
		expect(out).not.toContain("message 0 ");
		expect(handoffBlock(out).startsWith("<previous_conversation>")).toBe(true);
	});
});
