// A real ACP agent: Qwen Code (`qwen --acp`) -> gateway relay -> scripted fake Chat Completions LLM.
// Needs the qwen CLI on PATH (or PROMETHEUS_TEST_QWEN); the suite skips itself when it is missing.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginTool } from "@prometheus/plugin-sdk";
import type { GatewayConfig, SessionEvent } from "@prometheus/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AcpRuntime } from "../src/agent/acp/acp-runtime.ts";
import { ToolBus } from "../src/agent/bus/tool-bus.ts";
import { GatewayRelay, type RelayExchange } from "../src/agent/relay/gateway-relay.ts";
import type { RuntimeServices, RuntimeSession } from "../src/agent/types.ts";
import { PermissionGate } from "../src/permission-gate.ts";
import { UIBridge } from "../src/ui-bridge.ts";
import { type FakeCompletionsBlock, FakeCompletionsLlm, type RecordedCompletionsRequest } from "./support/fake-llm.ts";

const REAL_KEY = "real-upstream-key";
const llm = new FakeCompletionsLlm();
let relay: GatewayRelay;
let bus: ToolBus;
let runtime: AcpRuntime;
let services: RuntimeServices;
let root: string;
let cwd: string;
let gateway: GatewayConfig;
const exchanges: RelayExchange[] = [];
let events: SessionEvent[] = [];
let session: RuntimeSession | undefined;
let gate: PermissionGate;
let available = false;
const asked: unknown[] = [];

const echoTool: PluginTool = {
	name: "echo_tool",
	description: "Echo text back",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	annotations: { readOnlyHint: true },
	async execute(_id, params) {
		return { content: [{ type: "text", text: `echo:${params.text}` }], details: { echoed: params.text } };
	},
};

/** The model's side of each scripted exchange, chosen by what it was asked. */
function reply(req: RecordedCompletionsRequest): FakeCompletionsBlock[] {
	const user = req.lastUser;
	if (user.startsWith("[tool_output]")) {
		// Qwen Code keeps MCP tools behind tool_search / tool_call: look the tool up, then call it through the proxy.
		const found = /"?name"?\s*[:=]\s*"?([\w-]*echo_tool)/.exec(user);
		if (user.includes("<functions>") && found) return [{ type: "tool", name: "tool_call", input: { name: found[1], arguments: { text: "ping" } } }];
		return [{ type: "text", text: "done with the tool" }];
	}
	if (user.includes("use the tool")) {
		const name = req.toolNames.find((n) => n.endsWith("echo_tool"));
		if (name) return [{ type: "tool", name, input: { text: "ping" } }];
		return [{ type: "tool", name: "tool_search", input: { query: "echo_tool" } }];
	}
	if (user.includes("run a command")) {
		const name = req.toolNames.find((n) => /shell|bash|command/i.test(n)) ?? "run_shell_command";
		return [{ type: "tool", name, input: { command: "touch qwen-made.txt", description: "make a file" } }];
	}
	if (user.includes("say hi")) return [{ type: "text", text: "hello from the fake model" }];
	return [{ type: "text", text: "ok" }];
}

async function settle(count = 1, timeoutMs = 90_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (events.filter((e) => e.type === "agent_settled").length >= count) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`did not settle; events: ${events.map((e) => e.type).join(",")}`);
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "prometheus-qwen-"));
	cwd = join(root, "work");
	await mkdir(cwd);
	await llm.start();
	relay = new GatewayRelay({ onExchange: (e) => exchanges.push(e) });
	await relay.start();
	bus = new ToolBus();
	await bus.start();
	gateway = { id: "up", name: "up", format: "openai-completions", baseUrl: `${llm.baseUrl}/v1`, auth: { type: "bearer" }, apiKey: REAL_KEY, models: [{ id: "fake-model", name: "fake", contextWindow: 100_000 }] };
	services = {
		bus,
		relay,
		plugins: {
			externalView: async () => ({ tools: [{ plugin: "test", tool: echoTool }] }),
			collectContextExternal: async (req: { prompt: string }) => ({ static: { sections: { knowledge: "KB-LIST-MARKER" }, guidelines: [] }, turn: req.prompt ? [`TURN-MARKER for: ${req.prompt}`] : [] }),
		} as never,
		gateway: (id) => (id === "up" ? gateway : undefined),
		dataDir: root,
		log: { info: (m) => process.env.DEBUG_ACP && console.log(m), warn: (m) => process.env.DEBUG_ACP && console.log(m) },
	};
	// Qwen keeps its settings and sessions in the home directory: give the tests their own.
	const home = join(root, "home");
	await mkdir(home);
	const env = { ...process.env, HOME: home, USERPROFILE: home };
	runtime = new AcpRuntime(async () => services, () => ({ id: "qwen", name: "Qwen Code", command: process.env.PROMETHEUS_TEST_QWEN || "qwen", args: ["--acp"], env }));
	available = (await runtime.probe()).available;
}, 120_000);

afterAll(async () => {
	await session?.dispose();
	await bus?.stop();
	await relay?.stop();
	await llm.stop();
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

beforeEach(async (ctx) => {
	if (!available) ctx.skip();
	llm.reset();
	llm.enqueue(...Array.from({ length: 40 }, () => ({ blocks: reply })));
	events = [];
	exchanges.length = 0;
	asked.length = 0;
	if (!session) {
		gate = new PermissionGate();
		gate.mode = "bypassPermissions";
		gate.ask = async (p) => {
			asked.push(p);
			return "allow";
		};
		session = await runtime.create({
			cwd,
			gateway: { mode: "prometheus", gatewayId: "up", model: { provider: "up", id: "fake-model" } },
			permission: gate,
			ui: new UIBridge({ request: () => {}, resolved: () => {} }),
			hooks: { event: (e) => void events.push(e) },
		});
	}
}, 120_000);

const find = <T extends SessionEvent["type"]>(type: T) => events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

describe("conformance harness on Qwen Code (ACP)", { timeout: 180_000 }, () => {
	it("plain text turn through the relay with Prometheus context", async () => {
		await session!.prompt({ text: "say hi" }, "send");
		await settle();
		expect(session!.lastReply()).toContain("hello from the fake model");
		const req = llm.requests.find((r) => r.lastUser.includes("say hi"));
		expect(req).toBeDefined();
		expect(req!.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
		expect(req!.inputText).toContain("KB-LIST-MARKER");
		expect(req!.inputText).toContain("TURN-MARKER for: say hi");
		// MCP tools are offered directly or behind Qwen Code's tool_search
		expect(req!.toolNames.some((n) => n.endsWith("echo_tool") || n === "tool_search")).toBe(true);
		expect(exchanges.length).toBeGreaterThan(0);
		expect(exchanges.every((e) => e.sessionId === session!.id)).toBe(true);
		expect(JSON.stringify(session!.messages())).not.toContain("TURN-MARKER");
	});

	it("a Prometheus tool round-trips through the bus with its canonical name", async () => {
		await session!.prompt({ text: "use the tool" }, "send");
		await settle();
		const start = find("tool_execution_start").filter((e) => e.toolName === "echo_tool");
		const end = find("tool_execution_end").filter((e) => e.toolName === "echo_tool");
		expect(start).toHaveLength(1);
		expect(end).toHaveLength(1);
		expect(end[0]!.toolCallId).toBe(start[0]!.toolCallId);
		expect(JSON.stringify(end[0]!.result)).toContain("echo:ping");
		expect(session!.lastReply()).toContain("done with the tool");
	});

	it("a shell command asks the gate and is shown as bash", async () => {
		await session!.setPermissionMode("default");
		await session!.prompt({ text: "run a command" }, "send");
		await settle();
		await session!.setPermissionMode("bypassPermissions");
		expect(asked.length).toBeGreaterThan(0);
		const start = find("tool_execution_start");
		expect(start.some((e) => e.toolName === "bash" && JSON.stringify(e.args).includes("qwen-made.txt"))).toBe(true);
	});
});
