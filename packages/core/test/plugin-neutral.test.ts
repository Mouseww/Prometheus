import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ContextProvider, PluginTool } from "@prometheus/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
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

		// The same name in a different plugin is allowed.
		await host.load({ name: "beta", setup: (ctx) => ctx.tools.register(tool("one")) }, "builtin");
		expect(host.tools.map((t) => t.plugin)).toEqual(["alpha", "alpha", "beta"]);
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
		expect(seen).toEqual([req]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("[plugin:p2] 上下文提供者失败：boom"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("async boom"));
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
		expect(seen).toEqual([{ prompt: "find it", cwd: "/proj", sessionId: "s9", runtime: "pi", messageType: "user" }]);

		// Non-user starts get an empty prompt, and no turn_context when there is nothing to say.
		const quiet = await makeHost();
		await quiet.load({ name: "q", setup: (ctx) => ctx.context.provide(() => ({ static: { sections: { x: "X" } } })) }, "builtin");
		const q = fakePi();
		await run(quiet.dynamicExtension(), q.pi);
		const custom = { type: "before_agent_start", messageType: "custom", systemPromptOptions: { sections: {}, promptGuidelines: [] as string[] } };
		await q.handlers[0]!.fn(custom, { cwd: "/p" });
		expect(custom.systemPromptOptions).toEqual({ sections: { x: "X" }, promptGuidelines: [] });
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
