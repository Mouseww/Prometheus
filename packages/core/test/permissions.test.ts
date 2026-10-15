import { describe, expect, it } from "vitest";
import { decide, isProjectPath, isReadOnlyCommand, ruleKey, simpleCommandKey } from "../src/permissions.ts";

const cwd = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
const env = { cwd, allowed: new Set<string>() };
const call = (toolName: string, input: Record<string, unknown> = {}) => ({ toolName, input });

describe("isReadOnlyCommand", () => {
	it("accepts plain inspection commands", () => {
		for (const c of ["ls -la", "git status", "git log --oneline -5", "cat a.txt | grep foo", "pwd && ls", "Get-ChildItem -Recurse", "rg foo src"]) {
			expect(isReadOnlyCommand(c), c).toBe(true);
		}
	});

	it("rejects anything that can write or run something else", () => {
		for (const c of ["rm -rf x", "git push", "git commit -m x", "ls > out.txt", "echo $(rm x)", "cat `x`", "ls; rm x", "ls && npm i", "node a.js", "rg --pre=evil foo", "git diff --output=x", "FOO=1 ls", "./ls", "git"]) {
			expect(isReadOnlyCommand(c), c).toBe(false);
		}
	});

	it("rejects an empty command", () => {
		expect(isReadOnlyCommand("  ")).toBe(false);
	});
});

describe("simpleCommandKey", () => {
	it("keys a single invocation by program name", () => {
		expect(simpleCommandKey("npm install left-pad")).toBe("npm");
		expect(simpleCommandKey("Git.exe status")).toBe("git");
	});

	it("refuses chains, redirections, shells and paths", () => {
		for (const c of ["npm i && rm x", "npm i > log", "bash -c 'x'", "sudo ls", "./run.sh", "cmd /c dir", "echo $(x)"]) {
			expect(simpleCommandKey(c), c).toBeUndefined();
		}
	});
});

describe("isProjectPath", () => {
	it("keeps edits inside the project and out of config directories", () => {
		expect(isProjectPath("src/a.ts", cwd)).toBe(true);
		expect(isProjectPath("@src/a.ts", cwd)).toBe(true);
		expect(isProjectPath("../other/a.ts", cwd)).toBe(false);
		expect(isProjectPath(".git/config", cwd)).toBe(false);
		expect(isProjectPath("a/.pi/settings.json", cwd)).toBe(false);
		expect(isProjectPath("", cwd)).toBe(false);
		expect(isProjectPath(process.platform === "win32" ? "D:\\x\\a.ts" : "/etc/passwd", cwd)).toBe(false);
	});
});

describe("decide", () => {
	it("bypassPermissions allows everything", () => {
		expect(decide("bypassPermissions", call("bash", { command: "rm -rf /" }), env).type).toBe("allow");
	});

	it("always allows reads and read-only commands", () => {
		for (const mode of ["default", "acceptEdits", "plan"] as const) {
			expect(decide(mode, call("read", { path: "a" }), env).type).toBe("allow");
			expect(decide(mode, call("bash", { command: "git status" }), env).type).toBe("allow");
			expect(decide(mode, call("memory_search"), env).type).toBe("allow");
		}
	});

	it("default asks before edits and commands", () => {
		expect(decide("default", call("edit", { path: "src/a.ts" }), env).type).toBe("ask");
		expect(decide("default", call("write", { path: "src/a.ts" }), env).type).toBe("ask");
		expect(decide("default", call("bash", { command: "npm test" }), env).type).toBe("ask");
		expect(decide("default", call("some_mcp_tool"), env).type).toBe("ask");
	});

	it("acceptEdits lets project edits through but not commands or outside paths", () => {
		expect(decide("acceptEdits", call("edit", { path: "src/a.ts" }), env).type).toBe("allow");
		expect(decide("acceptEdits", call("write", { path: "../x" }), env).type).toBe("ask");
		expect(decide("acceptEdits", call("write", { path: ".git/hooks/pre-commit" }), env).type).toBe("ask");
		expect(decide("acceptEdits", call("bash", { command: "npm test" }), env).type).toBe("ask");
	});

	it("plan refuses mutations with a reason", () => {
		const v = decide("plan", call("edit", { path: "src/a.ts" }), env);
		expect(v.type).toBe("block");
		expect(decide("plan", call("bash", { command: "npm i" }), env).type).toBe("block");
	});

	it("honours remembered rules but only for eligible calls", () => {
		const allowed = new Set(["exec:npm", "tool:some_mcp_tool"]);
		expect(decide("default", call("bash", { command: "npm test" }), { cwd, allowed }).type).toBe("allow");
		expect(decide("default", call("bash", { command: "npm test && rm x" }), { cwd, allowed }).type).toBe("ask");
		expect(decide("default", call("some_mcp_tool"), { cwd, allowed }).type).toBe("allow");
		expect(decide("default", call("edit", { path: "a" }), { cwd, allowed }).type).toBe("ask");
	});

	it("lets tools that declare themselves read-only run", () => {
		expect(decide("default", { toolName: "mcp__x__list", input: {}, readOnly: true }, env).type).toBe("allow");
		expect(decide("plan", { toolName: "mcp__x__list", input: {}, readOnly: true }, env).type).toBe("allow");
	});

	it("always asks before installing a plugin, even in bypass mode, and never remembers it", () => {
		const install = call("prometheus_plugin_install", { name: "x", files: [] });
		for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) expect(decide(mode, install, env).type, mode).toBe("ask");
		expect(decide("plan", install, env).type).toBe("block");
		expect(decide("default", install, { cwd, allowed: new Set(["tool:prometheus_plugin_install"]) }).type).toBe("ask");
		expect(ruleKey("prometheus_plugin_install", {})).toBeUndefined();
	});

	it("treats the task list tool as safe in every mode", () => {
		for (const mode of ["default", "acceptEdits", "plan"] as const) expect(decide(mode, call("todo_write", { todos: [] }), env).type).toBe("allow");
	});
});

describe("ruleKey", () => {
	it("offers a rule for commands and foreign tools only", () => {
		expect(ruleKey("bash", { command: "npm test" })).toBe("exec:npm");
		expect(ruleKey("bash", { command: "npm i && x" })).toBeUndefined();
		expect(ruleKey("mcp__a__b", {})).toBe("tool:mcp__a__b");
		expect(ruleKey("edit", { path: "a" })).toBeUndefined();
	});
});
