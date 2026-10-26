// The built-in plugins that were moved from `ctx.extension` to the neutral API (docs/agent-runtime.md §5.1)
// run here inside a real PluginHost. Plugins are imported by relative path, as pi-facade.test.ts does.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { KnowledgeService } from "@prometheus/knowledge";
import { registerKnowledge } from "@prometheus/knowledge";
import type { PluginTool, PluginToolContext, PrometheusPlugin } from "@prometheus/plugin-sdk";
import { OPEN_FILE_TOOL, TODO_TOOL } from "@prometheus/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import automations from "../../../plugins/automations/src/index.ts";
import connectors from "../../../plugins/connectors/src/index.ts";
import { openVault } from "../../../plugins/connectors/src/vault.ts";
import memory from "../../../plugins/memory/src/index.ts";
import ssh from "../../../plugins/ssh/src/index.ts";
import todos from "../../../plugins/todos/src/index.ts";
import workbench from "../../../plugins/workbench/src/index.ts";
import { PluginHost } from "../src/plugin-host.ts";

const hosts: PluginHost[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const host of hosts.splice(0)) await host.dispose();
});

async function makeDir(prefix = "builtin-neutral-") {
	return mkdtemp(join(tmpdir(), prefix));
}

function makeHost(dataDir: string, kind: "server" | "tui" = "server") {
	const host = new PluginHost({ host: kind, dataDir, agentDir: join(dataDir, "agent"), cwd: dataDir, settings: () => ({}), gateways: () => [] });
	hosts.push(host);
	return host;
}

const toolCtx = (cwd: string, extra: Partial<PluginToolContext> = {}): PluginToolContext => ({
	cwd,
	sessionId: "s1",
	hasUI: false,
	ui: { confirm: async () => false, select: async () => undefined, input: async () => undefined, notify: () => {} },
	...extra,
});

const toolOf = (host: PluginHost, name: string): PluginTool => {
	const found = host.tools.find((t) => t.tool.name === name);
	if (!found) throw new Error(`tool ${name} is not registered`);
	return found.tool;
};

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text ?? "").join("\n");

/** Stands in for the knowledge service: one populated base, one empty one. */
const fakeKnowledge = {
	list: () => [
		{ id: "kb1", name: "Docs", description: "Team docs", chunkCount: 3 },
		{ id: "kb2", name: "Empty", description: "", chunkCount: 0 },
	],
	search: async (id: string) => [{ documentId: "d1", title: "Guide", text: `passage from ${id}`, score: 0.9 }],
} as unknown as KnowledgeService;

const knowledge: PrometheusPlugin = { name: "knowledge", version: "0.1.0", setup: (ctx) => registerKnowledge(ctx, fakeKnowledge) };

/** Every plugin migrated in P2-c and the tools it must register. */
const MIGRATED: { plugin: PrometheusPlugin; tools: string[] }[] = [
	{ plugin: memory, tools: ["memory_save", "memory_search", "memory_forget"] },
	{ plugin: knowledge, tools: ["knowledge_search"] },
	{ plugin: connectors, tools: ["connector_list", "connector_describe", "connector_call"] },
	{ plugin: workbench, tools: [OPEN_FILE_TOOL] },
	{ plugin: todos, tools: [TODO_TOOL] },
	{ plugin: ssh, tools: ["ssh_hosts", "ssh_exec", "ssh_upload", "ssh_download"] },
	{ plugin: automations, tools: ["automation_create", "automation_list", "automation_delete"] },
];

function fakePi() {
	const tools: any[] = [];
	const handlers: { event: string; fn: (...args: any[]) => any }[] = [];
	const pi = {
		registerTool: (t: any) => void tools.push(t),
		on: (event: string, fn: (...args: any[]) => any) => void handlers.push({ event, fn }),
	};
	return { pi: pi as any, tools, handlers };
}

/** Replays the host's plugins onto a fake `pi`, the way a PI session loads `dynamicExtension()`. */
async function replay(host: PluginHost) {
	const fake = fakePi();
	const ext: InlineExtension = host.dynamicExtension();
	await (typeof ext === "function" ? ext(fake.pi) : ext.factory(fake.pi));
	return fake;
}

describe("migrated built-ins are fully neutral", () => {
	it("load together without tool-name collisions and give the PiFacade nothing to translate", async () => {
		const host = makeHost(await makeDir());
		for (const { plugin } of MIGRATED) await host.load(plugin, "builtin");

		expect(host.list().map((p) => [p.name, p.status, p.error])).toEqual(MIGRATED.map(({ plugin }) => [plugin.name, "loaded", undefined]));
		expect(host.tools.map((t) => t.tool.name)).toEqual(MIGRATED.flatMap((m) => m.tools));

		const view = await host.externalView();
		expect(view.warnings).toEqual([]);
		expect(view.tools.map((t) => t.tool.name)).toEqual(MIGRATED.flatMap((m) => m.tools));
		expect(view.commands).toEqual([]);
		expect(view.mcpServers).toEqual([]);
		expect(Object.values(view.hooks).flat()).toEqual([]);
		expect(await host.compatibility()).toEqual([]);
		// memory, knowledge, connectors and workbench contribute prompt text.
		expect(view.contextProviders.map((p) => p.plugin)).toEqual(["memory", "knowledge", "connectors", "workbench"]);
	});

	it("reach PI as real tools and one context bridge, with no legacy extension factories", async () => {
		const host = makeHost(await makeDir());
		for (const { plugin } of MIGRATED) await host.load(plugin, "builtin");
		const { tools, handlers } = await replay(host);
		expect(tools.map((t) => t.name)).toEqual(MIGRATED.flatMap((m) => m.tools));
		expect(handlers.map((h) => h.event)).toEqual(["before_agent_start"]);
		// The TUI path hands PI the same: the bridge first, then one entry per plugin that has tools.
		const names = host.extensions.map((e) => (typeof e === "function" ? "" : e.name));
		expect(names).toEqual(["prometheus:context", ...MIGRATED.map((m) => `prometheus:${m.plugin.name}`)]);
	});
});

describe("memory", () => {
	it("keeps all memory text in `turn`, honours cwd visibility and the autoInject switch", async () => {
		const dataDir = await makeDir();
		const host = makeHost(dataDir);
		await host.load(memory, "builtin");
		const projectA = join(dataDir, "a");
		const projectB = join(dataDir, "b");
		const ask = async (prompt: string, cwd: string) => host.collectContext({ prompt, cwd, runtime: "pi" });

		// Nothing saved yet: nothing to inject.
		expect(await ask("pnpm?", projectA)).toEqual({ static: { sections: {}, guidelines: [] }, turn: [] });

		const save = toolOf(host, "memory_save");
		expect(textOf(await save.execute("1", { content: "The user prefers pnpm over npm", scope: "user" }, undefined, undefined, toolCtx(projectA)))).toMatch(/^Saved memory \w+\.$/);
		await save.execute("2", { content: "Project A deploys with rsync", scope: "project" }, undefined, undefined, toolCtx(projectA));

		const inA = await ask("which pnpm should I use? how do we deploy with rsync", projectA);
		expect(inA.static).toEqual({ sections: {}, guidelines: [] });
		expect(inA.turn).toHaveLength(1);
		expect(inA.turn[0]).toContain("Long-term memories about the user and this project");
		expect(inA.turn[0]).toContain("prefers pnpm");
		expect(inA.turn[0]).toContain("Project A deploys with rsync");
		expect(inA.turn[0]).toContain("Memory store: 1 global, 1 project entries.");

		// Another project sees the user-scoped memory only.
		const inB = (await ask("which pnpm should I use? how do we deploy with rsync", projectB)).turn[0];
		expect(inB).toContain("prefers pnpm");
		expect(inB).not.toContain("rsync");
		expect(inB).toContain("Memory store: 1 global, 0 project entries.");

		// A prompt that matches nothing still gets the index, but no recalled section.
		const miss = (await ask("zebra giraffe", projectA)).turn[0];
		expect(miss).toContain("Memory store: 1 global, 1 project entries.");
		expect(miss).not.toContain("Long-term memories about the user");

		// Saving mid-session changes the next answer, which is why it all lives in `turn`.
		await save.execute("3", { content: "Always answer in French", scope: "user" }, undefined, undefined, toolCtx(projectA));
		expect((await ask("zebra giraffe", projectA)).turn[0]).toContain("2 global");

		await host.rpcs.get("memory/settings")!({ autoInject: false });
		expect((await ask("which pnpm", projectA)).turn).toEqual([]);
		await host.rpcs.get("memory/settings")!({ autoInject: true });
		expect((await ask("which pnpm", projectA)).turn).toHaveLength(1);
	});

	it("works end to end through PI: tools run and the memory lands in turn_context, not a frozen section", async () => {
		const dataDir = await makeDir();
		const host = makeHost(dataDir);
		await host.load(memory, "builtin");
		const { tools, handlers } = await replay(host);
		const piCtx = { cwd: dataDir, hasUI: false, ui: {}, sessionManager: { getSessionId: () => "s1" } };

		const save = tools.find((t) => t.name === "memory_save");
		expect(save).toMatchObject({ label: "保存记忆", promptSnippet: "memory_save: remember a durable fact across sessions" });
		const saved = await save.execute("1", { content: "The user prefers pnpm over npm" }, undefined, undefined, piCtx);
		expect(saved).toEqual({ content: [{ type: "text", text: expect.stringMatching(/^Saved memory \w+\.$/) }], details: {} });
		const found = await tools.find((t) => t.name === "memory_search").execute("2", { query: "pnpm" }, undefined, undefined, piCtx);
		expect(found.content[0].text).toContain("The user prefers pnpm over npm");
		const none = await tools.find((t) => t.name === "memory_forget").execute("3", { id: "nope" }, undefined, undefined, piCtx);
		expect(none.content[0].text).toBe("No memory with id nope.");

		const event = { type: "before_agent_start", messageType: "user", prompt: "which pnpm?", systemPromptOptions: { sections: {} as Record<string, string>, promptGuidelines: [] as string[] } };
		expect(await handlers[0]!.fn(event, piCtx)).toBeUndefined();
		expect(Object.keys(event.systemPromptOptions.sections)).toEqual(["turn_context"]);
		expect(event.systemPromptOptions.sections.turn_context).toContain("prefers pnpm");

		// A turn the user did not start gets an empty prompt: only the index, no recalled memories.
		const custom = { ...event, messageType: "custom", systemPromptOptions: { sections: {} as Record<string, string>, promptGuidelines: [] as string[] } };
		await handlers[0]!.fn(custom, piCtx);
		expect(custom.systemPromptOptions.sections.turn_context).toContain("Memory store: 1 global");
		expect(custom.systemPromptOptions.sections.turn_context).not.toContain("Long-term memories about the user");
	});
});

describe("knowledge", () => {
	it("registers knowledge_search and lists populated bases in static.sections.knowledge", async () => {
		const host = makeHost(await makeDir());
		await host.load(knowledge, "builtin");
		expect(host.list()[0]).toMatchObject({ name: "knowledge", status: "loaded" });

		const tool = toolOf(host, "knowledge_search");
		expect(tool).toMatchObject({ label: "知识库检索", promptSnippet: "knowledge_search: semantic search over the user's knowledge bases" });
		const result = await tool.execute("1", { query: "how" }, undefined, undefined, toolCtx("/w"));
		expect(result.details).toEqual({ hits: [{ documentId: "d1", title: "Guide", text: "passage from kb1", score: 0.9, base: "Docs" }] });
		expect(textOf(result)).toBe("[1] Docs / Guide (score 0.900)\npassage from kb1");

		expect(await host.collectContext({ prompt: "x", cwd: "/w", runtime: "pi" })).toEqual({
			static: { sections: { knowledge: "Knowledge bases available via knowledge_search:\n- kb1: Docs — Team docs" }, guidelines: [] },
			turn: [],
		});
	});

	it("adds nothing when no base has content, and never returns a systemPrompt to PI", async () => {
		const host = makeHost(await makeDir());
		let populated = false;
		const service = { list: () => (populated ? fakeKnowledge.list() : []), search: fakeKnowledge.search } as unknown as KnowledgeService;
		await host.load({ name: "knowledge", setup: (ctx) => registerKnowledge(ctx, service) }, "builtin");
		expect((await host.collectContext({ prompt: "x", cwd: "/w", runtime: "pi" })).static.sections).toEqual({});
		expect(await toolOf(host, "knowledge_search").execute("1", { query: "q" }, undefined, undefined, toolCtx("/w"))).toEqual({
			content: [{ type: "text", text: "No populated knowledge base is available." }],
			details: { hits: [] },
		});

		populated = true; // the list is read per run, not captured at load
		const { handlers } = await replay(host);
		const event = { type: "before_agent_start", messageType: "user", prompt: "q", systemPromptOptions: { sections: {} as Record<string, string>, promptGuidelines: [] as string[] } };
		expect(await handlers[0]!.fn(event, { cwd: "/w" })).toBeUndefined();
		expect(event.systemPromptOptions.sections.knowledge).toContain("- kb1: Docs");
	});
});

describe("connectors", () => {
	it("registers its tools and lists connections in static.sections.connectors", async () => {
		const dataDir = await makeDir();
		const dir = join(dataDir, "plugin-data", "connectors");
		const host = makeHost(dataDir);
		// Prepared before the plugin opens the same vault.
		const vault = await openVault(dir);
		const record = await vault.add({ provider: "github", label: "me", authKind: "token", policy: "confirm", config: {}, secrets: { token: "ghp_x", values: {} } });
		await host.load(connectors, "builtin");
		expect(host.list()[0]).toMatchObject({ name: "connectors", status: "loaded" });
		expect(host.tools.map((t) => t.tool.name)).toEqual(["connector_list", "connector_describe", "connector_call"]);
		expect(toolOf(host, "connector_call").promptSnippet).toBe("connector_call: act on connected services (GitHub, Jira, Outlook, Teams, databases)");

		const got = await host.collectContext({ prompt: "x", cwd: "/w", runtime: "pi" });
		expect(got).toEqual({
			static: {
				sections: {
					connectors: `# Connected services\nThe user has connected these third-party services. Use connector_describe / connector_call; never ask the user to paste credentials.\n- ${record.id}: github "me" (writes: confirm)`,
				},
				guidelines: [],
			},
			turn: [],
		});

		const list = textOf(await toolOf(host, "connector_list").execute("1", {}, undefined, undefined, toolCtx("/w")));
		expect(list).toContain(`${record.id}  github  "me"`);
		expect(list).not.toContain("ghp_x");
		await expect(toolOf(host, "connector_describe").execute("2", { provider: "nope" }, undefined, undefined, toolCtx("/w"))).rejects.toThrow(/Unknown provider nope/);
		expect(textOf(await toolOf(host, "connector_describe").execute("3", { provider: "github" }, undefined, undefined, toolCtx("/w")))).toContain("name");
	});

	it("contributes no section while nothing is connected", async () => {
		const host = makeHost(await makeDir());
		await host.load(connectors, "builtin");
		expect((await host.collectContext({ prompt: "x", cwd: "/w", runtime: "pi" })).static.sections).toEqual({});
		expect(textOf(await toolOf(host, "connector_list").execute("1", {}, undefined, undefined, toolCtx("/w")))).toBe("No connections. The user can add one in Settings → Connectors.");
	});

	it("asks for confirmation through the neutral tool context only when someone can answer", async () => {
		const dataDir = await makeDir();
		const host = makeHost(dataDir);
		const vault = await openVault(join(dataDir, "plugin-data", "connectors"));
		const record = await vault.add({ provider: "github", label: "me", authKind: "token", policy: "confirm", config: {}, secrets: { token: "ghp_x", values: {} } });
		await host.load(connectors, "builtin");
		const confirm = vi.fn(async () => false);
		const call = toolOf(host, "connector_call");
		const write = { connection: record.id, operation: "create_issue", params: { repo: "octo/cat", title: "t" } };
		// With a UI the user is asked, and a refusal stops the write before any request goes out.
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be reached"));
		await expect(call.execute("1", write, undefined, undefined, toolCtx("/w", { hasUI: true, ui: { ...toolCtx("/w").ui, confirm } }))).rejects.toThrow("用户拒绝了该写操作");
		expect(confirm).toHaveBeenCalledWith("允许写入第三方服务？", expect.stringContaining("create_issue"));
		expect(fetchSpy).not.toHaveBeenCalled();

		// Unattended: nobody to ask, so the write is refused without a dialog.
		confirm.mockClear();
		await expect(call.execute("2", write, undefined, undefined, toolCtx("/w", { hasUI: false, ui: { ...toolCtx("/w").ui, confirm } }))).rejects.toThrow("当前没有可交互的界面");
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe("workbench", () => {
	it("registers open_file and adds its guideline through static.guidelines", async () => {
		const dataDir = await makeDir();
		const host = makeHost(dataDir);
		await host.load(workbench, "builtin");

		const got = await host.collectContext({ prompt: "x", cwd: "/w", runtime: "pi" });
		expect(got.static.sections).toEqual({});
		expect(got.turn).toEqual([]);
		expect(got.static.guidelines).toEqual([
			`Use ${OPEN_FILE_TOOL} to show the user a file in the app's side viewer when they ask to see it or when pointing at a specific spot; it is not needed for reading a file yourself.`,
		]);

		const project = join(dataDir, "proj");
		await mkdir(project);
		await writeFile(join(project, "a.ts"), "const a = 1;\n");
		const tool = toolOf(host, OPEN_FILE_TOOL);
		expect(tool).toMatchObject({ label: "查看文件", promptSnippet: `${OPEN_FILE_TOOL}: show a file to the user in the app's side viewer` });
		const opened = await tool.execute("1", { path: "a.ts", line: 3 }, undefined, undefined, toolCtx(project));
		expect(textOf(opened)).toMatch(/^Opened .*a\.ts at line 3 in the viewer\.$/);
		expect(opened.details).toMatchObject({ line: 3, path: expect.stringContaining("a.ts") });
		await expect(tool.execute("2", { path: join(tmpdir(), "elsewhere.txt") }, undefined, undefined, toolCtx(project))).rejects.toThrow();
	});

	it("reaches PI as a guideline pushed by the bridge", async () => {
		const host = makeHost(await makeDir());
		await host.load(workbench, "builtin");
		const { handlers } = await replay(host);
		const event = { type: "before_agent_start", messageType: "user", prompt: "", systemPromptOptions: { sections: {} as Record<string, string>, promptGuidelines: ["old"] } };
		await handlers[0]!.fn(event, { cwd: "/w" });
		expect(event.systemPromptOptions.promptGuidelines).toHaveLength(2);
		expect(event.systemPromptOptions.promptGuidelines[1]).toContain(OPEN_FILE_TOOL);
		expect(event.systemPromptOptions.sections).toEqual({});
	});
});

describe("todos", () => {
	it("registers todo_write with its guidelines, and `details.todos` survives the PI adapter", async () => {
		const host = makeHost(await makeDir());
		await host.load(todos, "builtin");
		const tool = toolOf(host, TODO_TOOL);
		expect(tool.promptGuidelines).toHaveLength(4);
		expect(tool.label).toBe("任务清单");

		const { tools } = await replay(host);
		const res = await tools[0].execute("1", { todos: [{ content: "a", status: "in_progress" }] }, undefined, undefined, { cwd: "/w", hasUI: false, ui: {} });
		expect(res.details).toEqual({ todos: [{ content: "a", status: "in_progress" }] });
		expect(res.content[0].text).toContain("Task list updated (0/1 done; now: a).");
		await expect(tools[0].execute("2", { todos: [] }, undefined, undefined, undefined)).rejects.toThrow(/empty/);
	});
});

describe("ssh", () => {
	it("registers its four tools", async () => {
		const host = makeHost(await makeDir());
		await host.load(ssh, "builtin");
		expect(host.tools.map((t) => t.tool.name)).toEqual(["ssh_hosts", "ssh_exec", "ssh_upload", "ssh_download"]);
		expect(textOf(await toolOf(host, "ssh_hosts").execute("1", {}, undefined, undefined, toolCtx("/w")))).toBe("尚未配置任何 SSH 主机。");
		await expect(toolOf(host, "ssh_exec").execute("2", { host: "nope", command: "ls" }, undefined, undefined, toolCtx("/w"))).rejects.toThrow(/没有名为 nope 的 SSH 主机/);
		expect(toolOf(host, "ssh_exec").parameters).toMatchObject({ type: "object", properties: { host: { type: "string" }, command: { type: "string", maxLength: 20000 } } });
	});
});

describe("automations", () => {
	it("registers its three tools on the server host", async () => {
		const host = makeHost(await makeDir());
		await host.load(automations, "builtin");
		expect(host.list()[0]).toMatchObject({ name: "automations", status: "loaded" });
		expect(host.tools.map((t) => t.tool.name)).toEqual(["automation_create", "automation_list", "automation_delete"]);
		expect(textOf(await toolOf(host, "automation_list").execute("1", {}, undefined, undefined, toolCtx("/w")))).toBe("No automations.");
		await expect(
			toolOf(host, "automation_create").execute("2", { name: "n", prompt: "p", schedule: { type: "interval", minutes: 30 } }, undefined, undefined, toolCtx(join(tmpdir(), "not-a-workspace"))),
		).rejects.toThrow("当前目录不是已添加的工作区，请先在侧栏添加");
	});

	it("stays inert in the TUI, as before", async () => {
		const host = makeHost(await makeDir(), "tui");
		await host.load(automations, "builtin");
		expect(host.tools).toEqual([]);
	});
});
