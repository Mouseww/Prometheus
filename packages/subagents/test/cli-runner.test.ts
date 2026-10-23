import { describe, expect, it } from "vitest";
import type { SubagentStep } from "@prometheus/protocol";
import type { AgentDef } from "../src/agents.ts";
import { claudeArgs, codexArgs, composePrompt, readClaudeLine, readCodexLine } from "../src/cli-runner.ts";
import type { RunHooks } from "../src/types.ts";

const def = (over: Partial<AgentDef> = {}): AgentDef => ({
	name: "x", description: "", mode: "replace", prompt: "Be brief.", model: "", thinking: "", tools: [], context: "", inheritProject: false, inheritGlobal: false, inheritSkills: false, timeoutMin: 0, advertise: false, runner: "claude-code", writable: false, ...over,
});

const hooks = () => {
	const steps: SubagentStep[] = [];
	const state = { tools: [] as string[], tokens: 0, touched: 0 };
	const h: RunHooks = { step: (s) => steps.push(s), tool: (n) => state.tools.push(n), tokens: (n) => (state.tokens = n), touch: () => state.touched++, model: () => {} };
	return { h, steps, state };
};

describe("claude args", () => {
	it("is read-only in plan mode without edit tools", () => {
		const a = claudeArgs({ def: def(), task: "t", cwd: "." });
		expect(a).toContain("plan");
		expect(a.join(" ")).not.toContain("Edit");
	});
	it("may edit when writable, and passes the model as one argv element", () => {
		const a = claudeArgs({ def: def({ writable: true }), task: "t", cwd: ".", model: "sonnet" });
		expect(a).toContain("acceptEdits");
		expect(a[a.indexOf("--model") + 1]).toBe("sonnet");
	});
	it("rejects a model name that is not a plain identifier", () => {
		expect(() => claudeArgs({ def: def(), task: "t", cwd: ".", model: "a; rm -rf /" })).toThrow();
	});
});

describe("codex args", () => {
	it("sandboxes by access and reads the prompt from stdin", () => {
		expect(codexArgs({ def: def({ runner: "codex" }), task: "t", cwd: "." }, "f.txt")).toEqual(expect.arrayContaining(["read-only", "--output-last-message", "f.txt", "-"]));
		expect(codexArgs({ def: def({ runner: "codex", writable: true }), task: "t", cwd: "." }, "f.txt")).toContain("workspace-write");
	});
	it("maps thinking to reasoning effort", () => {
		const a = codexArgs({ def: def({ runner: "codex" }), task: "t", cwd: ".", thinking: "high" }, "f");
		expect(a).toContain('model_reasoning_effort="high"');
	});
});

describe("prompt", () => {
	it("puts the agent brief before the task", () => {
		expect(composePrompt({ def: def(), task: "do it", cwd: "." })).toBe("Be brief.\n\n# Task\n\ndo it\n");
		expect(composePrompt({ def: def({ prompt: "" }), task: "do it", cwd: "." })).toBe("do it\n");
	});
});

describe("claude stream", () => {
	it("turns assistant text, tool use and results into steps and returns the final result", () => {
		const { h, steps, state } = hooks();
		const open = new Map<string, SubagentStep>();
		readClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "looking" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } }), h, open);
		readClaudeLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] } }), h, open);
		const end = readClaudeLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 3, output_tokens: 4 } }), h, open);
		expect(steps.map((s) => s.kind)).toEqual(["text", "tool"]);
		expect(steps[1]).toMatchObject({ tool: "Read", args: "a.ts", result: "file body" });
		expect(state.tools).toEqual(["Read"]);
		expect(state.tokens).toBe(7);
		expect(end).toEqual({ output: "done" });
	});
	it("reports an error result", () => {
		const { h } = hooks();
		expect(readClaudeLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "" }), h, new Map())?.error).toContain("error_max_turns");
	});
	it("ignores lines that are not JSON", () => {
		expect(readClaudeLine("warning: something", hooks().h, new Map())).toBeUndefined();
	});
});

describe("codex stream", () => {
	it("tracks a command and its output, and flags failures", () => {
		const { h, steps, state } = hooks();
		const open = new Map<string, SubagentStep>();
		readCodexLine(JSON.stringify({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls" } }), h, open);
		readCodexLine(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "boom", exit_code: 2 } }), h, open);
		expect(steps).toHaveLength(1);
		expect(steps[0]).toMatchObject({ tool: "bash", args: "ls", result: "boom", isError: true });
		expect(state.tools).toEqual(["bash"]);
	});
	it("reads messages, usage and failures", () => {
		const { h, steps, state } = hooks();
		readCodexLine(JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text: "hi" } }), h, new Map());
		expect(steps[0]).toMatchObject({ kind: "text", text: "hi" });
		expect(readCodexLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }), h, new Map())).toEqual({ done: true });
		expect(state.tokens).toBe(3);
		expect(readCodexLine(JSON.stringify({ type: "turn.failed", error: { message: "nope" } }), h, new Map())?.error).toBe("nope");
	});
});
