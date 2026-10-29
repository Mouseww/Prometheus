// OpenCode server mode: chats attach to one long-lived `opencode serve` (the user's own, reached by URL, or one
// Prometheus starts on a fixed port) instead of a process each. The server's own provider talks to a scripted fake
// LLM. Needs the opencode CLI (PATH or PROMETHEUS_TEST_OPENCODE); the suite skips itself when it is missing.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginTool } from "@prometheus/plugin-sdk";
import type { AgentServer, SessionEvent } from "@prometheus/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolBus } from "../src/agent/bus/tool-bus.ts";
import { OpenCodeRuntime } from "../src/agent/opencode/opencode-runtime.ts";
import { OpenCodeServer } from "../src/agent/opencode/opencode-server.ts";
import { sessionPermissions } from "../src/agent/opencode/opencode-session.ts";
import { GatewayRelay } from "../src/agent/relay/gateway-relay.ts";
import type { RuntimeServices, RuntimeSession } from "../src/agent/types.ts";
import { normalizeServer } from "../src/config.ts";
import { PermissionGate } from "../src/permission-gate.ts";
import { UIBridge } from "../src/ui-bridge.ts";
import { FakeCompletionsLlm } from "./support/fake-llm.ts";

const llm = new FakeCompletionsLlm();
const SECRET = "server-secret-for-tests";
let root: string;
let cwd: string;
let bus: ToolBus;
let relay: GatewayRelay;
let services: RuntimeServices;
let external: OpenCodeServer | undefined;
let env: Record<string, string>;
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

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const port = (s.address() as { port: number }).port;
			s.close(() => resolve(port));
		});
	});
}

interface Harness {
	session: RuntimeSession;
	events: SessionEvent[];
	gate: PermissionGate;
}

async function open(rt: OpenCodeRuntime): Promise<Harness> {
	const events: SessionEvent[] = [];
	const gate = new PermissionGate();
	gate.mode = "bypassPermissions";
	gate.ask = async (p) => {
		asked.push(p);
		return "allow";
	};
	const session = await rt.create({ cwd, permission: gate, ui: new UIBridge({ request: () => {}, resolved: () => {} }), hooks: { event: (e) => void events.push(e) } });
	return { session, events, gate };
}

async function settle(h: Harness, count = 1, timeoutMs = 90_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (h.events.filter((e) => e.type === "agent_settled").length >= count) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`did not settle; events: ${h.events.map((e) => e.type).join(",")}`);
}

const of = <T extends SessionEvent["type"]>(h: Harness, type: T) => h.events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "prometheus-ocserver-"));
	cwd = join(root, "work");
	await mkdir(cwd);
	await llm.start();
	bus = new ToolBus();
	await bus.start();
	relay = new GatewayRelay({});
	await relay.start();
	services = {
		bus,
		relay,
		plugins: { externalView: async () => ({ tools: [{ plugin: "test", tool: echoTool }] }), collectContextExternal: async () => ({ static: { sections: {}, guidelines: [] }, turn: [] }) } as never,
		gateway: () => undefined,
		dataDir: root,
		log: { info: () => {}, warn: () => {} },
	};
	// The user's server: its own provider (the fake LLM) and its own data directories.
	env = {
		XDG_DATA_HOME: join(root, "xdg", "data"),
		XDG_CONFIG_HOME: join(root, "xdg", "config"),
		XDG_STATE_HOME: join(root, "xdg", "state"),
		XDG_CACHE_HOME: join(root, "xdg", "cache"),
		OPENCODE_DISABLE_AUTOUPDATE: "1",
		OPENCODE_CONFIG_CONTENT: JSON.stringify({
			autoupdate: false,
			share: "disabled",
			model: "fake/fake-model",
			provider: { fake: { npm: "@ai-sdk/openai-compatible", name: "Fake", options: { baseURL: `${llm.baseUrl}/v1`, apiKey: "k" }, models: { "fake-model": { name: "Fake Model", tool_call: true, limit: { context: 100000, output: 4096 } } } } },
		}),
	};
	const probe = new OpenCodeRuntime(async () => services, () => process.env.PROMETHEUS_TEST_OPENCODE || undefined, () => env);
	available = (await probe.probe()).available;
	if (!available) return;
	external = new OpenCodeServer({ env: { ...process.env, ...env }, cwd: root, executable: process.env.PROMETHEUS_TEST_OPENCODE || undefined, port: await freePort(), secret: SECRET, events: false, onEvent: () => {}, onExit: () => {} });
	await external.start();
}, 120_000);

afterAll(async () => {
	await external?.close();
	await bus?.stop();
	await relay?.stop();
	await llm.stop();
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("agent server settings", () => {
	it("keeps a URL or a port, and rejects what cannot work", () => {
		expect(normalizeServer({ url: "127.0.0.1:4096/" })).toEqual({ url: "http://127.0.0.1:4096" });
		expect(normalizeServer({ port: 4096, username: " me " })).toEqual({ port: 4096, username: "me" });
		expect(normalizeServer({ url: "", port: undefined })).toBeUndefined();
		expect(() => normalizeServer({ port: 70000 })).toThrow();
		expect(() => normalizeServer({ url: "ftp://x" })).toThrow();
	});

	it("limits each chat on a shared server to its own Prometheus tools", () => {
		const rules = sessionPermissions(["prometheus-other_echo_tool"]);
		expect(rules.at(-1)).toEqual({ permission: "prometheus-other_echo_tool", pattern: "*", action: "deny" });
		expect(rules.find((r) => r.permission === "bash")?.action).toBe("ask");
	});
});

describe("OpenCode server mode", { timeout: 180_000 }, () => {
	it("attaches to a running server by URL: chats share it, see only their own tools, and ask through the gate", async (ctx) => {
		if (!available) ctx.skip();
		const server: AgentServer = { url: external!.endpoint.url, password: SECRET };
		const rt = new OpenCodeRuntime(async () => services, () => process.env.PROMETHEUS_TEST_OPENCODE || undefined, () => env, () => server);
		expect(await rt.probe()).toMatchObject({ available: true });
		const wrong = new OpenCodeRuntime(async () => services, () => undefined, () => env, () => ({ url: server.url, password: "nope" }));
		expect(await wrong.probe()).toMatchObject({ available: false });
		const models = await rt.listAllModels([]);
		expect(models.some((m) => m.id === "fake/fake-model")).toBe(true);

		const a = await open(rt);
		const b = await open(rt);
		llm.reset();
		llm.enqueue({ blocks: [{ type: "text", text: "hello from the server" }] });
		await a.session.prompt({ text: "say hi" }, "send");
		await settle(a);
		expect(a.session.lastReply()).toContain("hello from the server");
		const req = llm.requests.find((r) => r.lastUser.includes("say hi"))!;
		// both chats registered a tool bus on the server, but each prompt offers only the chat's own
		const mine = req.toolNames.filter((n) => n.startsWith("prometheus-") && n.endsWith("_echo_tool"));
		expect(mine).toHaveLength(1);
		expect(new Set(req.toolNames.filter((n) => n.startsWith("prometheus-")).map((n) => n.split("_")[0])).size).toBe(1);

		// the model calls this chat's tool: it runs on the bus and shows under its own name
		llm.enqueue({ blocks: [{ type: "tool", name: mine[0]!, input: { text: "ping" } }] }, { blocks: [{ type: "text", text: "done" }] });
		await a.session.prompt({ text: "use the tool" }, "send");
		await settle(a, 2);
		expect(of(a, "tool_execution_start").map((e) => e.toolName)).toContain("echo_tool");
		expect(JSON.stringify(of(a, "tool_execution_end").find((e) => e.toolName === "echo_tool")?.result)).toContain("echo:ping");

		// a shell command on the shared server still reaches this chat's gate
		a.gate.mode = "default";
		asked.length = 0;
		llm.enqueue({ blocks: [{ type: "tool", name: "bash", input: { command: "echo yes > shared.txt", description: "write" } }] }, { blocks: [{ type: "text", text: "written" }] });
		await a.session.prompt({ text: "write a file" }, "send");
		await settle(a, 3);
		expect(asked.length).toBeGreaterThan(0);

		// closing a chat leaves the server running for the other one
		await a.session.dispose();
		llm.enqueue({ blocks: [{ type: "text", text: "still here" }] });
		await b.session.prompt({ text: "are you there" }, "send");
		await settle(b);
		expect(b.session.lastReply()).toContain("still here");
		await b.session.dispose();
		await rt.dispose();
	});

	it("starts one server on a fixed port and shares it between chats", async (ctx) => {
		if (!available) ctx.skip();
		const port = await freePort();
		const rt = new OpenCodeRuntime(async () => services, () => process.env.PROMETHEUS_TEST_OPENCODE || undefined, () => env, () => ({ port, password: SECRET }));
		const a = await open(rt);
		const b = await open(rt);
		// both chats are on the server at that port, reachable by other clients with the same credentials
		const client = new OpenCodeServer({ env: {}, cwd, attach: { url: `http://127.0.0.1:${port}`, authorization: `Basic ${Buffer.from(`opencode:${SECRET}`).toString("base64")}` }, events: false, onEvent: () => {}, onExit: () => {} });
		await client.start();
		const list = await client.request<any[]>("GET", "/session");
		const ids = list.map((s) => s.id);
		expect(ids).toContain(a.session.nativeId);
		expect(ids).toContain(b.session.nativeId);
		await client.close();
		await a.session.dispose();
		await b.session.dispose();
		await rt.dispose();
		// the server Prometheus started stops with the runtime
		const after = await fetch(`http://127.0.0.1:${port}/global/health`).then(() => "up", () => "down");
		expect(after).toBe("down");
	});
});
