// Runs the neutral plugin bridge inside a REAL PI session (no model, no network): a PluginHost's
// dynamicExtension() is loaded by PI's DefaultResourceLoader, and the same code path PI walks before
// each prompt (emit before_agent_start, then build the system prompt sections) is driven directly.
// `session.prompt()` itself needs a model, so the test calls the extension runner and PI's prompt
// preparation instead; those are the two places a bad plugin contribution could break every prompt.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PluginTool } from "@prometheus/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PluginHost } from "../src/plugin-host.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

let root: string;
let previousAgentDir: string | undefined;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "plugin-pi-"));
	await mkdir(join(root, "work"));
	previousAgentDir = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = join(root, "agent");
});

afterAll(async () => {
	if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previousAgentDir;
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const echoTool: PluginTool = {
	name: "neutral_echo",
	description: "echoes",
	parameters: { type: "object", properties: { q: { type: "string" } } },
	execute: async (_id, params) => ({ content: [{ type: "text", text: `echo ${params?.q}` }] }),
};

describe("neutral plugin API inside a real PI session", () => {
	it("registers the tool and survives bad section keys when PI builds the system prompt", async () => {
		const cwd = join(root, "work");
		const agentDir = join(root, "agent");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const host = new PluginHost({ host: "server", dataDir: join(root, "data"), agentDir, cwd, settings: () => ({}), gateways: () => [] });
		await host.load(
			{
				name: "demo",
				setup(ctx) {
					ctx.tools.register(echoTool);
					ctx.context.provide(() => ({
						static: {
							// PI would throw on every one of these but `memory`.
							sections: { memory: "remember pnpm", "Bad Key": "x", preamble: "hijack", rules: "hijack", turn_context: "hijack" },
							guidelines: ["be kind"],
						},
						turn: "hit: coffee",
					}));
				},
			},
			"builtin",
		);

		const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
		const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [host.dynamicExtension()] });
		await loader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: loader,
		});
		try {
			await session.bindExtensions({ mode: "rpc" });

			// The neutral tool is a real PI tool and it runs.
			expect(session.getAllTools().map((t) => t.name)).toContain("neutral_echo");

			// What PI does before every prompt: run before_agent_start handlers over the base prompt options.
			const internals = session as unknown as {
				_baseSystemPromptOptions: unknown;
				_preparePromptAndToolLoadout(options: any, messages?: unknown[]): { sections?: Record<string, string | null> } | undefined;
			};
			const result = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "coffee please" } as never, internals._baseSystemPromptOptions as never);
			const options = result.systemPromptOptions;
			expect(options.sections).toMatchObject({ memory: "remember pnpm", turn_context: "hit: coffee" });
			expect(Object.keys(options.sections).sort()).toEqual(["memory", "turn_context"]);
			expect(options.promptGuidelines).toContain("be kind");

			// Building the prompt sections (which validates names) must not throw, and carries our sections.
			const patch = internals._preparePromptAndToolLoadout(options, []);
			expect(patch?.sections?.memory).toContain("remember pnpm");
			expect(patch?.sections?.turn_context).toContain("hit: coffee");
			expect(patch?.sections?.rules).toContain("be kind");
			expect(patch?.sections?.rules).not.toContain("hijack");

			// Control: this is the failure the host guards against. A raw bad key makes PI reject the prompt.
			expect(() => internals._preparePromptAndToolLoadout({ ...options, sections: { ...options.sections, "Bad Key": "x" } }, [])).toThrow(/Invalid system prompt section name/);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("[plugin:demo]"));
		} finally {
			session.dispose();
			warn.mockRestore();
		}
	}, 60_000);

	it("folds neutral sections into the prompt a legacy (modes-like) handler freezes", async () => {
		const cwd = join(root, "work");
		const agentDir = join(root, "agent");
		const host = new PluginHost({ host: "server", dataDir: join(root, "data-order"), agentDir, cwd, settings: () => ({}), gateways: () => [] });
		// Loaded first, as `modes` would be ahead of a later-listed plugin: it must still run after the bridge.
		await host.load(
			{ name: "modes-like", setup: (ctx) => ctx.extension((pi) => void pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n|X` }))) },
			"builtin",
		);
		await host.load({ name: "neutral", setup: (ctx) => ctx.context.provide(() => ({ static: { sections: { memory: "remember pnpm" } } })) }, "builtin");

		const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
		const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [host.dynamicExtension()] });
		await loader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: loader,
		});
		try {
			await session.bindExtensions({ mode: "rpc" });
			const internals = session as unknown as { _baseSystemPromptOptions: unknown };
			const result = await session.extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "hi" } as never, internals._baseSystemPromptOptions as never);
			const frozen = (result.systemPromptOptions as { forceSystemPrompt?: string }).forceSystemPrompt;
			expect(frozen).toContain("remember pnpm");
			expect(frozen?.endsWith("|X")).toBe(true);
		} finally {
			session.dispose();
		}
	}, 60_000);
});
