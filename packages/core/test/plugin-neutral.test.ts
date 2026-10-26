import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ContextProvider, PluginTool } from "@prometheus/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginHost } from "../src/plugin-host.ts";

async function makeHost() {
	const dataDir = await mkdtemp(join(tmpdir(), "plugneutral-"));
	return new PluginHost({
		host: "server",
		dataDir,
		agentDir: join(dataDir, "agent"),
		cwd: dataDir,
		settings: () => ({}),
		gateways: () => [],
	});
}

const tool = (name: string, extra: Partial<PluginTool> = {}): PluginTool => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: { q: { type: "string" } } },
	execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	...extra,
});

const req = { prompt: "hi", cwd: "/w", runtime: "pi" as const };

/** Records what a plugin-facing `pi` would see. */
function fakePi() {
	const tools: any[] = [];
	const handlers: { event: string; fn: (...args: any[]) => any }[] = [];
	const pi = {
		registerTool: (t: any) => void tools.push(t),
		on: (event: string, fn: (...args: any[]) => any) => void handlers.push({ event, fn }),
	};
	return { pi: pi as any, tools, handlers };
}

describe("neutral tools and context", () => {
	it("registers tools per plugin and rejects duplicates and empty names", async () => {
		const host = await makeHost();
		await host.load(
			{
				name: "alpha",
				setup(ctx) {
					ctx.tools.register(tool("one"));
					ctx.tools.register(tool("two"));
				},
			},
			"builtin",
		);
		expect(host.tools.map((t) => `${t.plugin}/${t.tool.name}`)).toEqual(["alpha/one", "alpha/two"]);

		await host.load({ name: "dup", setup: (ctx) => (ctx.tools.register(tool("x")), ctx.tools.register(tool("x"))) }, "builtin");
		expect(host.list().find((p) => p.name === "dup")).toMatchObject({ status: "error" });
		expect(host.list().find((p) => p.name === "dup")?.error).toMatch(/pluginToolDuplicate/);
		expect(host.tools.some((t) => t.plugin === "dup")).toBe(false);

		await host.load({ name: "blank", setup: (ctx) => ctx.tools.register(tool("  ")) }, "builtin");
		expect(host.list().find((p) => p.name === "blank")?.error).toMatch(/pluginToolNameEmpty/);

		// The same name in a different plugin is refused: tool names are global in the model's tool list.
		await host.load({ name: "beta", setup: (ctx) => ctx.tools.register(tool("one")) }, "builtin");
		const beta = host.list().find((p) => p.name === "beta");
		expect(beta?.status).toBe("error");
		expect(beta?.error).toMatch(/pluginToolDuplicate/);
		expect(beta?.error).toMatch(/owner=alpha/);
		expect(host.tools.map((t) => t.plugin)).toEqual(["alpha", "alpha"]);

		// Once the owner is gone the name is free again.
		await host.reload("builtin:alpha");
		expect(host.tools.map((t) => t.tool.name)).toEqual(["one", "two"]);
	});

	it("validates tool names, shapes and reserved names, and stores the trimmed name", async () => {
		const host = await makeHost();
		const errorOf = async (name: string, t: unknown) => {
			await host.load({ name, setup: (ctx) => ctx.tools.register(t as PluginTool) }, "builtin");
			return host.list().find((p) => p.name === name)?.error;
		};
		expect(await errorOf("sp", tool("has space"))).toMatch(/pluginToolNameInvalid/);
		expect(await errorOf("dot", tool("a.b"))).toMatch(/pluginToolNameInvalid/);
		expect(await errorOf("long", tool("x".repeat(65)))).toMatch(/pluginToolNameInvalid/);
		expect(await errorOf("nonstr", { ...tool("ok"), name: 5 })).toMatch(/pluginToolNameEmpty/);
		for (const reserved of ["bash", "powershell", "read", "edit", "write", "grep", "find", "ls", "codemode", "tool_search", "exit_plan_mode", "prometheus_plugin_install"]) {
			expect(await errorOf(`r-${reserved.replace(/_/g, "-")}`, tool(` ${reserved} `))).toMatch(/pluginToolNameReserved/);
		}
		expect(await errorOf("noexec", { ...tool("noexec_tool"), execute: undefined })).toMatch(/pluginToolShape/);
		expect(await errorOf("noparams", { ...tool("noparams_tool"), parameters: undefined })).toMatch(/pluginToolShape/);
		expect(await errorOf("arrparams", { ...tool("arrparams_tool"), parameters: [] })).toMatch(/pluginToolShape/);
		expect(host.tools).toEqual([]);

		await host.load({ name: "fine", setup: (ctx) => ctx.tools.register(tool("  Good_Name-1  ")) }, "builtin");
		expect(host.tools.map((t) => t.tool.name)).toEqual(["Good_Name-1"]);
	});

	it("removes tools and providers on disable and restores them on enable", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "plugneutral-"));
		const disabled = new Set<string>();
		const host = new PluginHost({
			host: "server",
			dataDir,
			agentDir: dataDir,
			cwd: dataDir,
			settings: () => ({}),
			gateways: () => [],
			isDisabled: (id) => disabled.has(id),
			setDisabled: async (id, d) => void (d ? disabled.add(id) : disabled.delete(id)),
		});
		host.reloadSessions = async () => {};
		await host.load(
			{
				name: "alpha",
				optional: true,
				setup(ctx) {
					ctx.tools.register(tool("one"));
					ctx.context.provide(() => ({ turn: "T" }));
				},
			},
			"builtin",
		);
		expect(host.tools).toHaveLength(1);
		expect((await host.collectContext(req)).turn).toEqual(["T"]);

		await host.setEnabled("builtin:alpha", false);
		expect(host.tools).toEqual([]);
		expect((await host.collectContext(req)).turn).toEqual([]);
		expect(fakeExtensionNames(host)).toEqual([]);

		await host.setEnabled("builtin:alpha", true);
		expect(host.tools).toHaveLength(1);
		expect((await host.collectContext(req)).turn).toEqual(["T"]);
	});

	it("merges static and turn contributions in plugin order and survives a throwing provider", async () => {
		const host = await makeHost();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const seen: unknown[] = [];
		const first: ContextProvider = (r) => (seen.push(r), { static: { sections: { a: "A1", shared: "first" }, guidelines: ["g1"] }, turn: "t1" });
		await host.load({ name: "p1", setup: (ctx) => ctx.context.provide(first) }, "builtin");
		await host.load(
			{
				name: "p2",
				setup(ctx) {
					ctx.context.provide(() => {
						throw new Error("boom");
					});
					ctx.context.provide(async () => Promise.reject(new Error("async boom")));
					ctx.context.provide(() => undefined);
					ctx.context.provide(async () => ({ static: { sections: { shared: "second", b: "B" }, guidelines: ["g2"] }, turn: "t2" }));
				},
			},
			"builtin",
		);
		await host.load({ name: "p3", setup: (ctx) => ctx.context.provide(() => ({ turn: "  " })) }, "builtin");

		const got = await host.collectContext(req);
		expect(got).toEqual({ static: { sections: { a: "A1", shared: "second", b: "B" }, guidelines: ["g1", "g2"] }, turn: ["t1", "t2"] });
		expect(seen).toEqual([{ ...req, signal: expect.any(AbortSignal) }]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("[plugin:p2] 上下文提供者失败：boom"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("async boom"));
		warn.mockRestore();
	});

	it("drops invalid and reserved section keys with a warning naming the plugin, and skips empty or non-string values", async () => {
		const host = await makeHost();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const bad: Record<string, unknown> = {
			Good: "upper-case",
			"1st": "digit first",
			"has space": "space",
			"": "empty key",
			__proto__: "proto",
			preamble: "x",
			rules: "x",
			tools: "x",
			cwd: "x",
			skills: "x",
			project_context: "x",
			addendum: "x",
			docs: "x",
			turn_context: "x",
			unattended: "x",
			auto_mode: "x",
			plan_mode: "x",
			blank: "   ",
			num: 5,
			nil: null,
			memory: "kept",
			"my-notes_2": "kept too",
		};
		// `__proto__:` in a literal sets the prototype; define it as an own key like JSON.parse would.
		Object.defineProperty(bad, "__proto__", { value: "proto", enumerable: true, configurable: true, writable: true });
		await host.load({ name: "messy", setup: (ctx) => ctx.context.provide(() => ({ static: { sections: bad as Record<string, string> } })) }, "builtin");

		const got = await host.collectContext(req);
		expect(Object.keys(got.static.sections).sort()).toEqual(["memory", "my-notes_2"]);
		expect(Object.getPrototypeOf(got.static.sections)).toBe(Object.prototype);
		const text = warn.mock.calls.map((c) => String(c[0])).join("\n");
		expect(text).toContain("[plugin:messy]");
		for (const key of ["Good", "1st", "has space", "__proto__", "preamble", "rules", "turn_context", "unattended", "auto_mode", "plan_mode", "project_context"]) expect(text).toContain(key);
		expect(text).not.toContain("blank");

		// The same bad key is reported once, not on every prompt.
		const before = warn.mock.calls.length;
		await host.collectContext(req);
		expect(warn.mock.calls.length).toBe(before);
		warn.mockRestore();
	});

	it("tolerates malformed provider return shapes", async () => {
		const host = await makeHost();
		const returns: unknown[] = [
			"a string",
			42,
			null,
			true,
			[],
			[{ turn: "in an array" }],
			{ static: "nope", turn: 7 },
			{ static: [], turn: ["x"] },
			{ static: { sections: ["a", "b"], guidelines: "not an array" } },
			{ static: { sections: "str", guidelines: { 0: "obj" } } },
			{ static: { sections: null, guidelines: [1, null, "", "  ", { x: 1 }, "real"] } },
		];
		await host.load(
			{
				name: "weird",
				setup(ctx) {
					for (const value of returns) ctx.context.provide((() => value) as ContextProvider);
					ctx.context.provide(() => ({ turn: "fine" }));
				},
			},
			"builtin",
		);
		expect(await host.collectContext(req)).toEqual({ static: { sections: {}, guidelines: ["real"] }, turn: ["fine"] });
	});

	it("passes permissionMode through to providers", async () => {
		const host = await makeHost();
		const seen: unknown[] = [];
		await host.load({ name: "m", setup: (ctx) => ctx.context.provide((r) => (seen.push(r.permissionMode), undefined)) }, "builtin");
		await host.collectContext({ ...req, permissionMode: "plan" });
		await host.collectContextExternal({ ...req, permissionMode: "auto" });
		await host.collectContext(req);
		expect(seen).toEqual(["plan", "auto", undefined]);
	});
});

describe("context provider timeout", () => {
	afterEach(() => vi.useRealTimers());

	it("skips a hung provider after the timeout, aborts its signal, warns, and keeps the others", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const host = await makeHost();
		let hungSignal: AbortSignal | undefined;
		const order: string[] = [];
		await host.load({ name: "first", setup: (ctx) => ctx.context.provide(() => (order.push("first"), { turn: "1" })) }, "builtin");
		await host.load(
			{
				name: "hung",
				setup: (ctx) =>
					ctx.context.provide((r) => {
						order.push("hung");
						hungSignal = r.signal;
						return new Promise(() => {});
					}),
			},
			"builtin",
		);
		// Started concurrently: the last provider has begun before the hung one finishes.
		await host.load({ name: "last", setup: (ctx) => ctx.context.provide(() => (order.push("last"), { turn: "3" })) }, "builtin");

		let done = false;
		const pending = host.collectContext(req).then((r) => ((done = true), r));
		await vi.advanceTimersByTimeAsync(3999);
		expect(done).toBe(false);
		expect(order).toEqual(["first", "hung", "last"]);
		expect(hungSignal?.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		const got = await pending;
		expect(got.turn).toEqual(["1", "3"]);
		expect(hungSignal?.aborted).toBe(true);
		expect(warn).toHaveBeenCalledWith("[plugin:hung] 上下文提供者超时");
		warn.mockRestore();
	});

	it("honours the contextTimeoutMs option, ignores a late answer, and also covers the external path", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const dataDir = await mkdtemp(join(tmpdir(), "plugneutral-"));
		const host = new PluginHost({ host: "server", dataDir, agentDir: dataDir, cwd: dataDir, settings: () => ({}), gateways: () => [], contextTimeoutMs: 50 });
		await host.load(
			{
				name: "slow",
				setup: (ctx) => ctx.context.provide(() => new Promise((resolve) => setTimeout(() => resolve({ turn: "late" }), 200))),
			},
			"builtin",
		);
		await host.load({ name: "rejects-late", setup: (ctx) => ctx.context.provide(() => new Promise((_, reject) => setTimeout(() => reject(new Error("late boom")), 100))) }, "builtin");

		const pending = host.collectContextExternal(req);
		await vi.advanceTimersByTimeAsync(50);
		expect((await pending).turn).toEqual([]);
		await vi.advanceTimersByTimeAsync(500); // late resolve/reject neither throw nor leak into later calls
		expect(warn).toHaveBeenCalledWith("[plugin:slow] 上下文提供者超时");
		expect(warn).toHaveBeenCalledWith("[plugin:rejects-late] 上下文提供者超时");
		warn.mockRestore();
	});
});

describe("PI bridge", () => {
	it("adapts a neutral tool and maps the PI tool context", async () => {
		const host = await makeHost();
		const calls: unknown[][] = [];
		await host.load(
			{
				name: "alpha",
				setup(ctx) {
					ctx.tools.register(
						tool("echo", {
							label: "Echo",
							promptSnippet: "echo things",
							promptGuidelines: ["be brief"],
							annotations: { readOnlyHint: true },
							defaultActive: false,
							async execute(id, params, signal, onUpdate, toolCtx) {
								onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { n: 1 } });
								const yes = await toolCtx.ui.confirm("T", "M", { timeout: 5 });
								toolCtx.ui.notify("hello", "warning");
								calls.push([id, params, signal, toolCtx.cwd, toolCtx.sessionId, toolCtx.hasUI, yes]);
								return { content: [{ type: "text", text: "done" }], details: { ok: true } };
							},
						}),
					);
				},
			},
			"builtin",
		);
		const { pi, tools } = fakePi();
		await run(host.dynamicExtension(), pi);
		expect(tools).toHaveLength(1);
		const adapted = tools[0];
		expect(adapted).toMatchObject({
			name: "echo",
			label: "Echo",
			description: "echo tool",
			promptSnippet: "echo things",
			promptGuidelines: ["be brief"],
			annotations: { readOnlyHint: true },
			defaultActive: false,
			parameters: { type: "object", properties: { q: { type: "string" } } },
		});

		const confirm = vi.fn(async () => true);
		const notify = vi.fn();
		const updates: unknown[] = [];
		const ac = new AbortController();
		const result = await adapted.execute("call-1", { q: "x" }, ac.signal, (p: unknown) => updates.push(p), {
			cwd: "/proj",
			hasUI: true,
			ui: { confirm, notify, select: vi.fn(), input: vi.fn() },
			sessionManager: { getSessionId: () => "sess-1" },
		});
		expect(result).toEqual({ content: [{ type: "text", text: "done" }], details: { ok: true } });
		expect(calls).toEqual([["call-1", { q: "x" }, ac.signal, "/proj", "sess-1", true, true]]);
		expect(confirm).toHaveBeenCalledWith("T", "M", { timeout: 5 });
		expect(notify).toHaveBeenCalledWith("hello", "warning");
		expect(updates).toEqual([{ content: [{ type: "text", text: "partial" }], details: { n: 1 } }]);
	});

	it("turns isError into a thrown error and tolerates a missing session manager", async () => {
		const host = await makeHost();
		await host.load(
			{
				name: "alpha",
				setup: (ctx) => ctx.tools.register(tool("bad", { execute: async (_i, _p, _s, _u, c) => ({ content: [{ type: "text", text: `fail ${c.sessionId}` }], isError: true }) })),
			},
			"builtin",
		);
		const { pi, tools } = fakePi();
		await run(host.dynamicExtension(), pi);
		await expect(tools[0].execute("1", {}, undefined, undefined, { cwd: "/", hasUI: false, ui: {} })).rejects.toThrow("fail undefined");
	});

	it("adapts defensively: no ctx, missing content, image-only and empty errors", async () => {
		const host = await makeHost();
		const results: Record<string, unknown> = {
			noctx: { content: [{ type: "text", text: "hi" }] },
			nocontent: {},
			badcontent: { content: "oops", details: { d: 1 } },
			nullish: undefined,
			imgerr: { content: [{ type: "text", text: "bad" }, { type: "image", data: "x", mimeType: "image/png" }], isError: true },
			imgonly: { content: [{ type: "image", data: "x", mimeType: "image/png" }], isError: true },
			blank: { content: [{ type: "text", text: "  " }], isError: true },
			noerrcontent: { isError: true },
		};
		await host.load(
			{
				name: "alpha",
				setup(ctx) {
					for (const [name, result] of Object.entries(results)) {
						ctx.tools.register(
							tool(name, {
								async execute(_i, _p, _s, _u, c) {
									if (name === "noctx") {
										expect(await c.ui.confirm("t", "m")).toBe(false);
										expect(await c.ui.select("t", [])).toBeUndefined();
										expect(await c.ui.input("t")).toBeUndefined();
										c.ui.notify("x");
										expect(c).toMatchObject({ hasUI: false, sessionId: undefined });
									}
									return result as never;
								},
							}),
						);
					}
				},
			},
			"builtin",
		);
		const { pi, tools } = fakePi();
		await run(host.dynamicExtension(), pi);
		const call = (name: string) => tools.find((t) => t.name === name).execute("1", {}, undefined, undefined, undefined);
		expect(await call("noctx")).toEqual({ content: [{ type: "text", text: "hi" }], details: undefined });
		expect(await call("nocontent")).toEqual({ content: [], details: undefined });
		expect(await call("badcontent")).toEqual({ content: [], details: { d: 1 } });
		expect(await call("nullish")).toEqual({ content: [], details: undefined });
		await expect(call("imgerr")).rejects.toThrow("bad\n[image]");
		await expect(call("imgonly")).rejects.toThrow("[image]");
		await expect(call("blank")).rejects.toThrow("tool failed");
		await expect(call("noerrcontent")).rejects.toThrow("tool failed");
	});

	it("warns when a neutral tool name is already registered by an earlier plugin's legacy tool", async () => {
		const host = await makeHost();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await host.load({ name: "old", setup: (ctx) => ctx.extension((pi) => pi.registerTool({ name: "shared", label: "s", description: "d", parameters: {}, execute: async () => ({ content: [], details: {} }) } as never)) }, "builtin");
		await host.load({ name: "new", setup: (ctx) => ctx.tools.register(tool("shared")) }, "builtin");
		const { pi, tools } = fakePi();
		await run(host.dynamicExtension(), pi);
		expect(tools.map((t) => t.name)).toEqual(["shared", "shared"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("[plugin:new] "));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("shared"));
		warn.mockRestore();

		// No warning when names differ.
		const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
		const b = await makeHost();
		await b.load({ name: "one", setup: (ctx) => ctx.tools.register(tool("a")) }, "builtin");
		await b.load({ name: "two", setup: (ctx) => ctx.tools.register(tool("b")) }, "builtin");
		await run(b.dynamicExtension(), fakePi().pi);
		expect(quiet).not.toHaveBeenCalled();
		quiet.mockRestore();
	});

	it("registers one before_agent_start handler that writes sections, guidelines and turn_context", async () => {
		const host = await makeHost();
		const seen: unknown[] = [];
		await host.load(
			{
				name: "a",
				setup(ctx) {
					ctx.context.provide((r) => (seen.push(r), { static: { sections: { memory: "M" }, guidelines: ["g1"] }, turn: "hit-1" }));
				},
			},
			"builtin",
		);
		await host.load({ name: "b", setup: (ctx) => ctx.context.provide(() => ({ static: { guidelines: ["g2"] }, turn: "hit-2" })) }, "builtin");
		const { pi, handlers } = fakePi();
		await run(host.dynamicExtension(), pi);
		const starts = handlers.filter((h) => h.event === "before_agent_start");
		expect(starts).toHaveLength(1);

		const event = { type: "before_agent_start", messageType: "user", prompt: "find it", systemPromptOptions: { sections: { existing: "E" }, promptGuidelines: ["old"] } };
		const ret = await starts[0]!.fn(event, { cwd: "/proj", sessionManager: { getSessionId: () => "s9" } });
		expect(ret).toBeUndefined();
		expect(event.systemPromptOptions).toEqual({
			sections: { existing: "E", memory: "M", turn_context: "hit-1\n\nhit-2" },
			promptGuidelines: ["old", "g1", "g2"],
		});
		expect(seen).toEqual([{ prompt: "find it", cwd: "/proj", sessionId: "s9", runtime: "pi", messageType: "user", signal: expect.any(AbortSignal) }]);

		// Non-user starts get an empty prompt, and no turn_context when there is nothing to say.
		const quiet = await makeHost();
		await quiet.load({ name: "q", setup: (ctx) => ctx.context.provide(() => ({ static: { sections: { x: "X" } } })) }, "builtin");
		const q = fakePi();
		await run(quiet.dynamicExtension(), q.pi);
		const custom = { type: "before_agent_start", messageType: "custom", systemPromptOptions: { sections: {}, promptGuidelines: [] as string[] } };
		await q.handlers[0]!.fn(custom, { cwd: "/p" });
		expect(custom.systemPromptOptions).toEqual({ sections: { x: "X" }, promptGuidelines: [] });
	});

	it("runs the context bridge before legacy handlers, so a systemPrompt they fold in already holds the neutral sections", async () => {
		// Like PI's runner: handlers run in registration order and `event.systemPrompt` is rendered on read from the current options.
		const emitStart = async (handlers: { event: string; fn: (...args: any[]) => any }[]) => {
			const options = { sections: { existing: "E" } as Record<string, string>, promptGuidelines: [] as string[] };
			let forced: string | undefined;
			for (const h of handlers.filter((x) => x.event === "before_agent_start")) {
				const event = {
					type: "before_agent_start",
					messageType: "user",
					prompt: "p",
					get systemPrompt() {
						return forced ?? Object.values(options.sections).join("\n");
					},
					systemPromptOptions: options,
				};
				const ret = await h.fn(event, { cwd: "/proj" });
				if (ret?.systemPrompt !== undefined) forced = ret.systemPrompt;
			}
			return forced;
		};
		// The legacy plugin loads first, so plugin order alone would put its handler ahead of the bridge.
		const build = async () => {
			const host = await makeHost();
			await host.load(
				{ name: "modes-like", setup: (ctx) => ctx.extension((pi) => void pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}|X` }))) },
				"builtin",
			);
			await host.load({ name: "neutral", setup: (ctx) => ctx.context.provide(() => ({ static: { sections: { memory: "SECTION-M" } } })) }, "builtin");
			return host;
		};

		const dynamic = fakePi();
		await run((await build()).dynamicExtension(), dynamic.pi);
		const fromDynamic = await emitStart(dynamic.handlers);
		expect(fromDynamic).toContain("SECTION-M");
		expect(fromDynamic?.endsWith("|X")).toBe(true);

		const tuiHost = await build();
		const exts = tuiHost.extensions;
		expect(exts.map((e) => (typeof e === "function" ? "" : e.name))[0]).toBe("prometheus:context");
		const tui = fakePi();
		for (const ext of exts) await run(ext, tui.pi);
		const fromTui = await emitStart(tui.handlers);
		expect(fromTui).toContain("SECTION-M");
		expect(fromTui?.endsWith("|X")).toBe(true);
	});

	it("registers no handler when no plugin provides context, and still replays legacy factories", async () => {
		const host = await makeHost();
		const legacy = vi.fn();
		await host.load(
			{
				name: "old",
				setup(ctx) {
					ctx.extension((pi) => {
						legacy();
						pi.registerTool({ name: "legacy" } as any);
					});
				},
			},
			"builtin",
		);
		await host.load({ name: "new", setup: (ctx) => ctx.tools.register(tool("neutral")) }, "builtin");
		const { pi, tools, handlers } = fakePi();
		await run(host.dynamicExtension(), pi);
		expect(legacy).toHaveBeenCalledTimes(1);
		expect(tools.map((t) => t.name)).toEqual(["legacy", "neutral"]);
		expect(handlers).toEqual([]);
	});

	it("exposes the same tools and one context extension through `extensions` for the TUI", async () => {
		const host = await makeHost();
		const legacy = vi.fn();
		await host.load(
			{
				name: "alpha",
				setup(ctx) {
					ctx.extension(legacy);
					ctx.tools.register(tool("t1"));
					ctx.context.provide(() => ({ turn: "x" }));
				},
			},
			"builtin",
		);
		await host.load({ name: "beta", setup: (ctx) => ctx.context.provide(() => ({ turn: "y" })) }, "builtin");
		const { pi, tools, handlers } = fakePi();
		for (const ext of host.extensions) await run(ext, pi);
		expect(legacy).toHaveBeenCalledTimes(1);
		expect(tools.map((t) => t.name)).toEqual(["t1"]);
		expect(handlers.filter((h) => h.event === "before_agent_start")).toHaveLength(1);
	});
});

const run = async (ext: InlineExtension, pi: any) => (typeof ext === "function" ? ext(pi) : ext.factory(pi));

function fakeExtensionNames(host: PluginHost): string[] {
	return host.extensions.map((e) => (typeof e === "function" ? "" : e.name));
}
