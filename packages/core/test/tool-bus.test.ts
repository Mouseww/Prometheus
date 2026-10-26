import type { PluginTool } from "@prometheus/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BusSession, type BusToolEvent, ToolBus } from "../src/agent/bus/tool-bus.ts";

const ui = {
	confirm: async () => true,
	select: async () => undefined,
	input: async () => undefined,
	notify: () => {},
};

const echo: PluginTool = {
	name: "echo",
	description: "echo",
	parameters: { type: "object", properties: { text: { type: "string" } } },
	annotations: { readOnlyHint: true },
	async execute(_id, params, _s, _u, ctx) {
		return { content: [{ type: "text", text: `${params.text}@${ctx.cwd}:${ctx.sessionId}:${ctx.hasUI}` }], details: { n: 1 } };
	},
};

let bus: ToolBus;
let session: BusSession;
let tools: PluginTool[];
let events: BusToolEvent[];
let allow: ReadonlySet<string> | undefined;

async function rpc(body: unknown, opts: { token?: string; headers?: Record<string, string>; url?: string } = {}) {
	const res = await fetch(opts.url ?? session.url, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${opts.token ?? session.token}`, ...opts.headers },
		body: JSON.stringify(body),
	});
	return res;
}
const call = (name: string, args: unknown, id = 1, extra: Record<string, unknown> = {}) =>
	rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...extra } });

beforeEach(async () => {
	bus = new ToolBus();
	await bus.start();
	tools = [echo];
	events = [];
	allow = undefined;
	session = bus.open({
		sessionId: "s1",
		cwd: () => "/work",
		ui,
		hasUI: () => true,
		tools: () => tools,
		allow: () => allow,
		onEvent: (e) => events.push(e),
	});
});
afterEach(() => bus.stop());

describe("ToolBus", () => {
	it("authenticates and isolates sessions", async () => {
		expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: "wrong" })).status).toBe(401);
		expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { url: session.url.replace("s1", "nope") })).status).toBe(404);
		expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
		const other = bus.open({ sessionId: "s2", cwd: () => "/", ui, hasUI: () => false, tools: () => [] });
		// a token of one session does not open another
		expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { url: other.url })).status).toBe(401);
	});

	it("initializes and lists tools with annotations", async () => {
		const init = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json()) as any;
		expect(init.result.protocolVersion).toBe("2025-03-26");
		expect(init.result.capabilities.tools).toBeDefined();
		const list = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
		expect(list.result.tools).toEqual([
			{ name: "echo", title: "echo", description: "echo", inputSchema: echo.parameters, annotations: { readOnlyHint: true } },
		]);
	});

	it("sees hot-registered tools and honours the allow list", async () => {
		tools = [echo, { ...echo, name: "other" }];
		allow = new Set(["other"]);
		const list = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
		expect(list.result.tools.map((t: any) => t.name)).toEqual(["other"]);
		const denied = (await (await call("echo", {})).json()) as any;
		expect(denied.error.code).toBe(-32602);
	});

	it("runs a tool with the session context and reports events", async () => {
		const out = (await (await call("echo", { text: "hi" })).json()) as any;
		expect(out.result.content).toEqual([{ type: "text", text: "hi@/work:s1:true" }]);
		expect(out.result.structuredContent).toEqual({ n: 1 });
		expect(events.map((e) => e.type)).toEqual(["start", "end"]);
		const end = events[1] as Extract<BusToolEvent, { type: "end" }>;
		expect(end.name).toBe("echo");
		expect(end.isError).toBe(false);
		expect(end.result.details).toEqual({ n: 1 });
	});

	it("turns thrown errors and isError results into isError", async () => {
		tools = [
			{ ...echo, name: "boom", execute: async () => { throw new Error("nope"); } },
			{ ...echo, name: "soft", execute: async () => ({ content: [{ type: "text", text: "bad" }], isError: true }) },
		];
		const a = (await (await call("boom", {})).json()) as any;
		expect(a.result).toMatchObject({ isError: true, content: [{ type: "text", text: "nope" }] });
		const b = (await (await call("soft", {}, 2)).json()) as any;
		expect(b.result.isError).toBe(true);
		expect(events.filter((e) => e.type === "end").every((e: any) => e.isError)).toBe(true);
	});

	it("blocks a call the permission check refuses, without running it", async () => {
		let ran = false;
		tools = [{ ...echo, execute: async () => { ran = true; return { content: [] }; } }];
		session = bus.open({
			sessionId: "s1",
			cwd: () => "/",
			ui,
			hasUI: () => true,
			tools: () => tools,
			beforeCall: () => ({ allow: false, reason: "denied by user" }),
		});
		const out = (await (await call("echo", {})).json()) as any;
		expect(ran).toBe(false);
		expect(out.result).toMatchObject({ isError: true, content: [{ type: "text", text: "denied by user" }] });
	});

	it("streams progress when asked and cancels on notification", async () => {
		tools = [
			{
				...echo,
				name: "slow",
				async execute(_id, _p, signal, onUpdate) {
					onUpdate?.({ content: [{ type: "text", text: "step 1" }] });
					await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
					throw new Error("aborted");
				},
			},
		];
		const pending = call("slow", {}, 7, { _meta: { progressToken: "p1" } });
		// ask for SSE
		const res = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "slow", arguments: {}, _meta: { progressToken: "p2" } } }, { headers: { accept: "application/json, text/event-stream" } });
		await new Promise((r) => setTimeout(r, 50));
		expect(session.running()).toBe(2);
		await rpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8 } });
		await rpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
		const text = await res.text();
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(text).toContain("notifications/progress");
		expect(text).toContain('"progressToken":"p2"');
		expect(text).toContain('"isError":true');
		await pending;
		expect(session.running()).toBe(0);
		expect(events.some((e) => e.type === "update")).toBe(true);
	});

	it("revokes the endpoint and aborts running calls on close", async () => {
		let aborted = false;
		tools = [{ ...echo, name: "hang", execute: async (_i, _p, s) => new Promise((_r, rej) => s?.addEventListener("abort", () => { aborted = true; rej(new Error("x")); })) }];
		const p = call("hang", {}).catch(() => undefined);
		await new Promise((r) => setTimeout(r, 30));
		session.close();
		await p;
		expect(aborted).toBe(true);
		expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
	});

	it("rejects malformed input", async () => {
		const res = await fetch(session.url, { method: "POST", headers: { authorization: `Bearer ${session.token}` }, body: "{" });
		expect(res.status).toBe(400);
		expect((await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
		const unknown = (await (await rpc({ jsonrpc: "2.0", id: 3, method: "nope" })).json()) as any;
		expect(unknown.error.code).toBe(-32601);
		expect((await fetch(session.url, { headers: { authorization: `Bearer ${session.token}` } })).status).toBe(405);
	});

	it("wraps non-object structured details and non-object schemas", async () => {
		tools = [{ ...echo, parameters: { type: "string" }, execute: async () => ({ content: [], details: [1, 2] }) }];
		const list = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any;
		expect(list.result.tools[0].inputSchema).toEqual({ type: "object", properties: {} });
		const out = (await (await call("echo", {})).json()) as any;
		expect(out.result.structuredContent).toEqual({ value: [1, 2] });
	});
});
