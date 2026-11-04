import { describe, expect, it } from "vitest";
import { PermissionGate } from "../src/permission-gate.ts";

const cwd = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
const call = (toolName: string, input: Record<string, unknown> = {}, readOnly = false) => ({ toolName, input, readOnly, cwd });

describe("PermissionGate unattended runs", () => {
	it("allows what the access covers and refuses the rest", async () => {
		const gate = new PermissionGate();
		gate.unattended = "readonly";
		expect(await gate.evaluate(call("read", { path: "a.ts" }))).toBeUndefined();
		expect(await gate.evaluate(call("bash", { command: "ls -la" }))).toBeUndefined();
		expect((await gate.evaluate(call("bash", { command: "python tools/check.py" })))?.block).toBe(true);
		expect((await gate.evaluate(call("write", { path: "a.ts", content: "x" })))?.block).toBe(true);
	});

	it("edits may write inside the project but still cannot run commands", async () => {
		const gate = new PermissionGate();
		gate.unattended = "edits";
		expect(await gate.evaluate(call("write", { path: "src/a.ts" }))).toBeUndefined();
		expect((await gate.evaluate(call("bash", { command: "npm test" })))?.block).toBe(true);
		expect((await gate.evaluate(call("write", { path: "../outside.txt" })))?.block).toBe(true);
	});

	it("full allows everything except installing a plugin", async () => {
		const gate = new PermissionGate();
		gate.unattended = "full";
		expect(await gate.evaluate(call("bash", { command: "rm -rf build" }))).toBeUndefined();
		expect((await gate.evaluate(call("prometheus_plugin_install", { name: "x" })))?.block).toBe(true);
	});

	it("says which access level the refused call needed", async () => {
		const gate = new PermissionGate();
		gate.unattended = "edits";
		const reason = (await gate.evaluate(call("bash", { command: "npm test" })))?.reason ?? "";
		expect(reason).toMatch(/needs "full"/);
		expect(reason).toMatch(/Edits|edits/);
	});

	it("collects refusals for the caller and starts a new list after handing them over", async () => {
		const gate = new PermissionGate();
		gate.unattended = "readonly";
		await gate.evaluate(call("bash", { command: "node build.js" }));
		await gate.evaluate(call("write", { path: "a.ts" }));
		await gate.evaluate(call("read", { path: "a.ts" })); // allowed: not recorded
		const blocked = gate.takeBlocked();
		expect(blocked.map((b) => b.tool)).toEqual(["bash", "write"]);
		expect(blocked[0]?.reason).toMatch(/Blocked by permissions/);
		expect(gate.takeBlocked()).toEqual([]);
	});

	it("keeps a bounded list", async () => {
		const gate = new PermissionGate();
		gate.unattended = "readonly";
		for (let i = 0; i < 40; i++) await gate.evaluate(call("bash", { command: `node x${i}.js` }));
		expect(gate.takeBlocked()).toHaveLength(20);
	});

	it("records nothing for an attended session the user denied", async () => {
		const gate = new PermissionGate();
		gate.mode = "default";
		gate.ask = async () => "deny";
		expect((await gate.evaluate(call("bash", { command: "npm i" })))?.block).toBe(true);
		expect(gate.takeBlocked()).toEqual([]);
	});
});
