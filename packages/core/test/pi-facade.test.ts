import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PluginTool, PluginToolContext, PrometheusPlugin } from "@prometheus/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { captureExtension } from "../src/agent/facade/pi-facade.ts";
import { PluginHost } from "../src/plugin-host.ts";

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const capture = (factories: ((pi: any) => any)[], extra: { sendMessage?: (m: unknown, o?: unknown) => void } = {}) =>
	captureExtension(factories as ExtensionFactory[], { pluginName: "p", cwd: "/w", log: log(), ...extra });

const req = (prompt: string, extra: Record<string, unknown> = {}) => ({ prompt, cwd: "/proj", sessionId: "s1", runtime: "claude-code" as const, ...extra });

function toolCtx(extra: Partial<PluginToolContext> = {}): PluginToolContext {
	return {
		cwd: "/proj",
		sessionId: "s1",
		hasUI: true,
		ui: { confirm: vi.fn(async () => true), select: vi.fn(), input: vi.fn(), notify: vi.fn() },
		...extra,
	};
}

describe("captureExtension: before_agent_start", () => {
	it("memory-like: the draft is rebuilt per call and delivered as turn", async () => {
		const seen: any[] = [];
		const cap = await capture([
			(pi) => {
				pi.on("before_agent_start", async (event: any, ctx: any) => {
					seen.push({ event: structuredClone(event), cwd: ctx.cwd, id: ctx.sessionManager.getSessionId(), hasUI: ctx.hasUI });
					const prompt = event.messageType === "user" ? event.prompt : "";
					if (!prompt) return;
					event.systemPromptOptions.sections.memory = prompt.includes("coffee") ? "likes coffee" : "index only";
					if (prompt.includes("coffee")) event.systemPromptOptions.promptGuidelines.push("offer coffee");
				});
			},
		]);
		expect(cap.contextProviders).toHaveLength(1);
		const provider = cap.contextProviders[0]!;

		expect(await provider(req("coffee please"))).toEqual({ turn: "- offer coffee\n\n## memory\nlikes coffee" });
		expect(await provider(req("something else"))).toEqual({ turn: "## memory\nindex only" });
		// Nothing written → nothing contributed; static is never used for legacy hooks.
		expect(await provider(req("", { messageType: "custom" }))).toBeUndefined();

		expect(seen[0]).toEqual({
			event: { type: "before_agent_start", prompt: "coffee please", messageType: "user", systemPrompt: "", systemPromptOptions: { cwd: "/proj", promptGuidelines: [], sections: {} } },
			cwd: "/proj",
			id: "s1",
			hasUI: false,
		});
		expect(cap.warnings).toEqual([]);
	});

	it("connectors-like: an async handler is awaited, and several handlers each become a provider", async () => {
		const cap = await capture([
			async (pi) => {
				await new Promise((r) => setTimeout(r, 1));
				pi.on("before_agent_start", async (event: any, ctx: any) => {
					await new Promise((r) => setTimeout(r, 1));
					event.systemPromptOptions.sections.connectors = "# Connected services\n- gh";
					ctx.ui.notify("ignored"); // legacy UI calls must not throw
					ctx.ui.setStatus("x", "y");
					expect(await ctx.ui.confirm("t", "m")).toBe(false);
				});
				pi.on("before_agent_start", (event: any) => void (event.systemPromptOptions.sections.other = "O"));
			},
		]);
		expect(cap.contextProviders).toHaveLength(2);
		expect(await cap.contextProviders[0]!(req("hi"))).toEqual({ turn: "## connectors\n# Connected services\n- gh" });
		expect(await cap.contextProviders[1]!(req("hi"))).toEqual({ turn: "## other\nO" });
	});

	it("warns once when a handler returns systemPrompt, and delivers a changed prompt as turn", async () => {
		const cap = await capture([
			(pi) => {
				pi.on("before_agent_start", () => ({ systemPrompt: "FULL REPLACEMENT" }));
				pi.on("before_agent_start", (event: any) => ({ systemPrompt: event.systemPrompt }));
			},
		]);
		const [replace, same] = cap.contextProviders;
		expect(await replace!(req("a"))).toEqual({ turn: "FULL REPLACEMENT" });
		expect(await replace!(req("b"))).toEqual({ turn: "FULL REPLACEMENT" });
		expect(await same!(req("a"))).toBeUndefined();
		expect(cap.warnings).toEqual(["p: before_agent_start returned systemPrompt, which replaces the whole prompt in PI; delivered as turn context outside PI"]);
	});
});

describe("captureExtension: tools", () => {
	it("converts a PI tool and runs it through PluginToolContext", async () => {
		const calls: any[] = [];
		const cap = await capture([
			(pi) => {
				pi.registerTool({
					name: "write_file",
					label: "Write",
					description: "writes",
					parameters: { type: "object", properties: { path: { type: "string" } } },
					promptSnippet: "write_file: writes",
					promptGuidelines: ["be careful"],
					annotations: { readOnlyHint: false },
					defaultActive: false,
					async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
						calls.push({ id, params, signal, cwd: ctx.cwd, hasUI: ctx.hasUI, sid: ctx.sessionManager.getSessionId(), ctxSignal: ctx.signal, mode: ctx.mode });
						onUpdate?.({ content: [{ type: "text", text: "working" }] });
						const ok = ctx.hasUI ? await ctx.ui.confirm("Write?", params.path) : false;
						ctx.ui.setWidget("w", []); // not provided by PluginToolContext → no-op
						if (params.fail) throw new Error("disk full");
						return { content: [{ type: "text", text: ok ? `wrote ${ctx.cwd}/${params.path}` : "refused" }], details: { ok } };
					},
				});
			},
		]);
		expect(cap.tools).toHaveLength(1);
		const tool = cap.tools[0]!;
		expect(tool).toMatchObject({
			name: "write_file",
			label: "Write",
			description: "writes",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			promptSnippet: "write_file: writes",
			promptGuidelines: ["be careful"],
			annotations: { readOnlyHint: false },
			defaultActive: false,
		});

		const ctx = toolCtx();
		const updates: unknown[] = [];
		const ac = new AbortController();
		const res = await tool.execute("c1", { path: "a.txt" }, ac.signal, (p) => updates.push(p), ctx);
		expect(res).toEqual({ content: [{ type: "text", text: "wrote /proj/a.txt" }], details: { ok: true } });
		expect(ctx.ui.confirm).toHaveBeenCalledWith("Write?", "a.txt");
		expect(updates).toEqual([{ content: [{ type: "text", text: "working" }] }]);
		expect(calls[0]).toMatchObject({ id: "c1", params: { path: "a.txt" }, signal: ac.signal, cwd: "/proj", hasUI: true, sid: "s1", ctxSignal: ac.signal, mode: undefined });

		// Without a UI the legacy code sees hasUI=false and takes its own fallback.
		const quiet = await tool.execute("c2", { path: "b" }, undefined, undefined, toolCtx({ hasUI: false, sessionId: undefined }));
		expect(quiet.content).toEqual([{ type: "text", text: "refused" }]);
		expect(calls[1].sid).toBeUndefined();

		// Errors pass through unchanged.
		await expect(tool.execute("c3", { path: "x", fail: true }, undefined, undefined, ctx)).rejects.toThrow("disk full");
	});

	it("reports getAllTools / getActiveTools in PI shape, and a later tool with the same name wins", async () => {
		let all: unknown;
		let active: unknown;
		const cap = await capture([
			(pi) => {
				pi.registerTool({ name: "a", description: "first", parameters: {}, annotations: { readOnlyHint: true }, execute: async () => ({ content: [] }) });
				pi.registerTool({ name: "b", description: "bee", parameters: {}, execute: async () => ({ content: [] }) });
				pi.registerTool({ name: "a", description: "second", parameters: {}, annotations: { readOnlyHint: true }, execute: async () => ({ content: [] }) });
				all = pi.getAllTools();
				active = pi.getActiveTools();
			},
		]);
		expect(all).toEqual([
			{ name: "a", description: "second", annotations: { readOnlyHint: true } },
			{ name: "b", description: "bee", annotations: undefined },
		]);
		expect(active).toEqual(["a", "b"]);
		expect(cap.tools.map((t) => t.description)).toEqual(["second", "bee"]);
	});
});

describe("captureExtension: hooks, commands and unsupported API", () => {
	it("records permissions-like tool_call and the other known hooks without running them", async () => {
		const toolCall = vi.fn();
		const start = vi.fn();
		const cap = await capture([
			(pi) => {
				pi.on("tool_call", toolCall);
				pi.on("session_start", start);
				pi.on("session_shutdown", start);
				pi.on("resources_discover", async () => ({ skillPaths: ["/s"] }));
				pi.on("before_provider_request", start);
				pi.on("before_provider_headers", start);
				pi.registerCommand("plan", { description: "Plan mode", handler: async () => {} });
				pi.registerMcpServer("srv", { command: "node", args: ["x.js"] });
			},
		]);
		expect(cap.hooks.tool_call).toEqual([toolCall]);
		expect(cap.hooks.session_start).toEqual([start]);
		expect(cap.hooks.session_shutdown).toEqual([start]);
		expect(cap.hooks.resources_discover).toHaveLength(1);
		expect(cap.hooks.before_provider_request).toEqual([start]);
		expect(cap.hooks.before_provider_headers).toEqual([start]);
		expect(toolCall).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(cap.commands).toEqual([{ name: "plan", description: "Plan mode", handler: expect.any(Function) }]);
		expect(cap.mcpServers).toEqual([{ name: "srv", config: { command: "node", args: ["x.js"] } }]);
		expect(cap.warnings).toEqual([]);
	});

	it("turns registerProvider, unknown events, setActiveTools and unknown API into warnings (once each)", async () => {
		const logger = log();
		const cap = await captureExtension(
			[
				(pi: any) => {
					pi.registerProvider("gw", { baseUrl: "http://x" });
					pi.registerProvider({ id: "obj", name: "Obj" });
					pi.on("turn_end", () => {});
					pi.on("turn_end", () => {});
					pi.setActiveTools(["a"]);
					pi.setActiveTools(["b"]);
					pi.exec("ls");
					pi.exec("pwd");
					void pi.events; // merely reading an unknown property is recorded
					pi.sendMessage({ customType: "x", content: "y" });
					pi.sendMessage({ customType: "x", content: "z" });
				},
			] as ExtensionFactory[],
			{ pluginName: "legacy", cwd: "/w", log: logger },
		);
		expect(cap.warnings).toEqual([
			'legacy: pi.registerProvider("gw") is not supported outside PI',
			'legacy: pi.registerProvider("obj") is not supported outside PI',
			'legacy: pi.on("turn_end") is not supported outside PI',
			"legacy: pi.setActiveTools is not supported outside PI",
			"legacy: pi.exec is not supported outside PI",
			"legacy: pi.events is not supported outside PI",
			"legacy: pi.sendMessage is not supported outside PI",
		]);
		expect(cap.providers).toEqual([
			{ name: "gw", config: { baseUrl: "http://x" } },
			{ name: "obj", config: { id: "obj", name: "Obj" } },
		]);
		expect(logger.warn).toHaveBeenCalledTimes(cap.warnings.length);
	});

	it("forwards sendMessage to the callback when given, else warns once", async () => {
		const sent: unknown[][] = [];
		const withCb = await capture([(pi) => pi.sendMessage({ customType: "n", content: "hi" }, { deliverAs: "nextTurn" })], { sendMessage: (m, o) => void sent.push([m, o]) });
		expect(sent).toEqual([[{ customType: "n", content: "hi" }, { deliverAs: "nextTurn" }]]);
		expect(withCb.warnings).toEqual([]);

		const without = await capture([(pi) => (pi.sendMessage({}), pi.sendMessage({}))]);
		expect(without.warnings).toEqual(["p: pi.sendMessage is not supported outside PI"]);
	});

	it("isolates a throwing or rejecting factory and keeps the others", async () => {
		const cap = await capture([
			(pi) => {
				pi.registerCommand("before", { handler: async () => {} });
				throw new Error("boom");
			},
			async () => {
				throw new Error("async boom");
			},
			async (pi) => pi.registerCommand("after", { handler: async () => {} }),
		]);
		expect(cap.commands.map((c) => c.name)).toEqual(["before", "after"]);
		expect(cap.warnings).toEqual(["p: extension failed: boom", "p: extension failed: async boom"]);
	});
});

describe("PluginHost external view", () => {
	async function makeHost() {
		const dataDir = await mkdtemp(join(tmpdir(), "plugfacade-"));
		const disabled = new Set<string>();
		const host = new PluginHost({
			host: "server",
			dataDir,
			agentDir: join(dataDir, "agent"),
			cwd: dataDir,
			settings: () => ({}),
			gateways: () => [],
			isDisabled: (id) => disabled.has(id),
			setDisabled: async (id, d) => void (d ? disabled.add(id) : disabled.delete(id)),
		});
		return host;
	}

	const neutralTool = (name: string): PluginTool => ({
		name,
		description: name,
		parameters: { type: "object" },
		execute: async () => ({ content: [{ type: "text", text: "neutral" }] }),
	});

	function plugins() {
		const replay = vi.fn();
		const legacy: PrometheusPlugin = {
			name: "legacy",
			optional: true,
			setup(ctx) {
				ctx.extension((pi: any) => {
					replay();
					pi.registerTool({ name: "old_tool", description: "old", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "old" }] }) });
					pi.registerTool({ name: "shared", description: "legacy shared", parameters: {}, execute: async () => ({ content: [] }) });
					pi.registerCommand("plan", { description: "d", handler: async () => {} });
					pi.registerMcpServer("srv", { command: "x" } as any);
					pi.on("tool_call", () => undefined);
					pi.on("before_agent_start", (event: any) => void (event.systemPromptOptions.sections.memory = `hits for ${event.prompt}`));
					pi.setActiveTools([]);
				});
			},
		};
		const neutral: PrometheusPlugin = {
			name: "neutral",
			setup(ctx) {
				ctx.tools.register(neutralTool("new_tool"));
				ctx.tools.register(neutralTool("shared"));
				ctx.context.provide(() => ({ static: { sections: { s: "S" }, guidelines: ["g"] }, turn: "neutral turn" }));
			},
		};
		return { legacy, neutral, replay };
	}

	it("merges neutral registrations with captured legacy ones, in plugin order", async () => {
		const host = await makeHost();
		const { legacy, neutral, replay } = plugins();
		await host.load(legacy, "builtin");
		await host.load(neutral, "builtin");

		const view = await host.externalView();
		expect(view.tools.map((t) => `${t.plugin}/${t.tool.name}`)).toEqual(["legacy/old_tool", "legacy/shared", "neutral/new_tool", "neutral/shared"]);
		expect(view.commands).toMatchObject([{ plugin: "legacy", name: "plan", description: "d" }]);
		expect(view.mcpServers).toEqual([{ plugin: "legacy", name: "srv", config: { command: "x" } }]);
		expect(view.hooks.tool_call).toHaveLength(1);
		expect(view.hooks.tool_call[0]!.plugin).toBe("legacy");
		expect(view.contextProviders.map((p) => p.plugin)).toEqual(["legacy", "neutral"]);
		expect(view.warnings).toEqual([{ plugin: "legacy", messages: ["legacy: pi.setActiveTools is not supported outside PI"] }]);
		// The captured tool runs through its wrapper.
		expect(await view.tools[0]!.tool.execute("1", {}, undefined, undefined, toolCtx())).toEqual({ content: [{ type: "text", text: "old" }] });

		expect(await host.compatibility()).toEqual([{ plugin: "legacy", warnings: ["legacy: pi.setActiveTools is not supported outside PI"] }]);
		expect(replay).toHaveBeenCalledTimes(1);
	});

	it("collectContextExternal runs legacy providers too, while collectContext (PI path) is unchanged", async () => {
		const host = await makeHost();
		const { legacy, neutral } = plugins();
		await host.load(legacy, "builtin");
		await host.load(neutral, "builtin");

		const r = { prompt: "find x", cwd: "/p", runtime: "codex" as const };
		expect(await host.collectContextExternal(r)).toEqual({
			static: { sections: { s: "S" }, guidelines: ["g"] },
			turn: ["## memory\nhits for find x", "neutral turn"],
		});
		expect((await host.collectContextExternal({ ...r, prompt: "other" })).turn[0]).toBe("## memory\nhits for other");
		expect(await host.collectContext(r)).toEqual({ static: { sections: { s: "S" }, guidelines: ["g"] }, turn: ["neutral turn"] });
	});

	it("skips a throwing legacy provider like a throwing neutral one", async () => {
		const host = await makeHost();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await host.load(
			{
				name: "bad",
				setup(ctx) {
					ctx.extension((pi: any) => void pi.on("before_agent_start", () => Promise.reject(new Error("nope"))));
					ctx.context.provide(() => ({ turn: "ok" }));
				},
			},
			"builtin",
		);
		expect((await host.collectContextExternal({ prompt: "", cwd: "/", runtime: "codex" })).turn).toEqual(["ok"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("[plugin:bad] 上下文提供者失败：nope"));
		warn.mockRestore();
	});

	it("invalidates the cache on reload and teardown, and caches otherwise", async () => {
		const host = await makeHost();
		const { legacy, replay } = plugins();
		await host.load(legacy, "builtin");

		await host.externalView();
		await host.externalView();
		await host.compatibility();
		expect(replay).toHaveBeenCalledTimes(1);

		await host.reload("builtin:legacy");
		await host.externalView();
		expect(replay).toHaveBeenCalledTimes(2);

		await host.setEnabled("builtin:legacy", false);
		const off = await host.externalView();
		expect(off.tools).toEqual([]);
		expect(off.warnings).toEqual([]);
		expect(await host.compatibility()).toEqual([]);

		await host.setEnabled("builtin:legacy", true);
		expect((await host.externalView()).tools).toHaveLength(2);
		expect(replay).toHaveBeenCalledTimes(3);
	});

	it("re-captures after install replaces a folder plugin", async () => {
		const host = await makeHost();
		const files = (cmd: string) => [
			{ path: "index.js", content: `export default { name: "inst", setup(ctx) { ctx.extension((pi) => { pi.registerCommand(${JSON.stringify(cmd)}, { handler: async () => {} }); }); } };` },
		];
		await host.install({ name: "inst", files: files("one") });
		expect((await host.externalView()).commands.map((c) => c.name)).toEqual(["one"]);
		await host.install({ name: "inst", files: files("two") });
		expect((await host.externalView()).commands.map((c) => c.name)).toEqual(["two"]);
	});
});

describe("real plugins through the external view", () => {
	it("memory: the real plugin recalls per prompt and saves via its neutral tool", async () => {
		let memory: PrometheusPlugin;
		try {
			memory = ((await import("../../../plugins/memory/src/index.ts")) as { default: PrometheusPlugin }).default;
		} catch (err) {
			// Skip when the plugin's dependencies are not installed in this checkout.
			console.warn(`memory plugin not importable, skipping smoke test: ${err}`);
			return;
		}
		const dataDir = await mkdtemp(join(tmpdir(), "plugfacade-mem-"));
		const host = new PluginHost({ host: "server", dataDir, agentDir: dataDir, cwd: dataDir, settings: () => ({}), gateways: () => [] });
		await host.load(memory, "builtin");
		expect(host.list()[0]).toMatchObject({ name: "memory", status: "loaded" });

		// Fully neutral: nothing for the PiFacade to translate or complain about.
		const view = await host.externalView();
		expect(view.warnings).toEqual([]);
		expect(view.tools.map((t) => t.tool.name)).toEqual(["memory_save", "memory_search", "memory_forget"]);
		expect(view.contextProviders).toHaveLength(1);
		const turnFor = async (prompt: string) => (await host.collectContextExternal({ prompt, cwd: dataDir, runtime: "claude-code" })).turn;

		// Empty store: the provider has nothing to say.
		expect(await turnFor("pnpm?")).toEqual([]);

		const save = view.tools.find((t) => t.tool.name === "memory_save")!.tool;
		const saved = await save.execute("1", { content: "The user prefers pnpm over npm", scope: "user" }, undefined, undefined, toolCtx({ cwd: dataDir }));
		expect(saved.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Saved memory") });

		const [hit] = await turnFor("which pnpm should I use?");
		expect(hit).toContain("Long-term memories about the user");
		expect(hit).toContain("prefers pnpm");
		const [miss] = await turnFor("zebra giraffe");
		expect(miss).toContain("Memory store: 1 global");
		expect(miss).not.toContain("Long-term memories about the user");
	});
});
