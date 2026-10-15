import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { slimEvent, toModelRef } from "../src/events.ts";

const ev = (e: unknown) => slimEvent(e as AgentSessionEvent);

describe("toModelRef", () => {
	it("treats PI's placeholder model as none", () => {
		expect(toModelRef({ provider: "unknown", id: "unknown" })).toBeNull();
		expect(toModelRef(undefined)).toBeNull();
		expect(toModelRef({ provider: "openai", id: "gpt" })).toEqual({ provider: "openai", id: "gpt" });
	});
});

describe("slimEvent", () => {
	it("drops the partial message from streaming deltas", () => {
		const out = ev({
			type: "message_update",
			message: {},
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: { content: [] } },
		});
		expect(out).toEqual({ type: "message_update", delta: { type: "text_delta", contentIndex: 0, delta: "hi" } });
	});

	it("carries tool call id and name on toolcall_start", () => {
		const out = ev({
			type: "message_update",
			message: {},
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 1,
				partial: { content: [{ type: "text" }, { type: "toolCall", id: "c1", name: "bash" }] },
			},
		});
		expect(out).toMatchObject({ delta: { type: "toolcall_start", id: "c1", name: "bash" } });
	});

	it("truncates oversized tool results", () => {
		const out = ev({ type: "tool_execution_end", toolCallId: "c", toolName: "read", result: "x".repeat(100_000), isError: false });
		expect(out).toMatchObject({ result: { truncated: true } });
		expect(JSON.stringify(out).length).toBeLessThan(70_000);
	});

	it("passes small tool results through untouched", () => {
		const out = ev({ type: "tool_execution_end", toolCallId: "c", toolName: "ls", result: { ok: 1 }, isError: false });
		expect(out).toMatchObject({ result: { ok: 1 } });
	});
});
