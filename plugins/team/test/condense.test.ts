import { describe, expect, it } from "vitest";
import { condense, MAX_TOOL_TEXT, resultText, summarizeRequest } from "../src/member/condense.ts";
import { tokenCommand } from "../src/member/provider.ts";
import { safeSegment } from "../src/member/git.ts";

describe("condense", () => {
	it("keeps the events the Hub shows and drops streaming and bookkeeping", () => {
		expect(condense({ type: "agent_start" })).toEqual({ kind: "agent_start", payload: {} });
		expect(condense({ type: "agent_end", willRetry: false })).toEqual({ kind: "agent_end", payload: { willRetry: false } });
		expect(condense({ type: "session_info_changed", name: "x" })).toEqual({ kind: "session_info_changed", payload: { name: "x" } });
		for (const type of ["turn_start", "turn_end", "message_update", "tool_execution_update", "queue_update", "thinking_level_changed", "agent_settled"]) {
			expect(condense({ type } as never)).toBeUndefined();
		}
	});

	it("caps result text at 20KB, from content parts or JSON", () => {
		expect(resultText({ content: [{ type: "text", text: "a" }, { type: "image", data: "zzz" }, { type: "text", text: "b" }] })).toBe("a\nb");
		expect(resultText("y".repeat(MAX_TOOL_TEXT * 2)).length).toBeLessThan(MAX_TOOL_TEXT + 100);
		expect(resultText({ big: "z".repeat(MAX_TOOL_TEXT * 2) }).length).toBeLessThan(MAX_TOOL_TEXT + 100);
		expect(resultText(undefined)).toBe("");
	});

	it("bounds huge tool arguments", () => {
		const out = condense({ type: "tool_execution_start", toolCallId: "t", toolName: "write", args: { content: "q".repeat(MAX_TOOL_TEXT * 2) } });
		expect((out?.payload.args as { truncated: boolean }).truncated).toBe(true);
	});

	it("summarises UI requests without their bodies", () => {
		expect(summarizeRequest({ id: "r1", method: "select", title: "Pick", options: ["a", "b"] })).toEqual({ requestId: "r1", method: "select", title: "Pick", options: ["a", "b"] });
	});
});

describe("helpers", () => {
	it("builds a key command only from a plain node binary, otherwise falls back to node on PATH", () => {
		expect(tokenCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\data\\print-token.mjs", 3)).toBe('!"C:\\Program Files\\nodejs\\node.exe" "C:\\data\\print-token.mjs" 3');
		expect(tokenCommand("/Applications/Prometheus.app/Contents/MacOS/Prometheus", "/d/p.mjs", 1)).toBe('!"node" "/d/p.mjs" 1');
		expect(tokenCommand("/usr/bin/node", '/d/"p.mjs', 1)).toBeUndefined();
	});

	it("makes team and workspace names safe as folder names", () => {
		expect(safeSegment("a/b\\c:d")).toBe("a_b_c_d");
		expect(safeSegment("..")).toBe("_");
		expect(safeSegment("  团队 A.  ")).toBe("团队 A");
	});
});
