// P4: Claude Code (Claude Agent SDK, bundled CLI) -> gateway relay -> scripted fake LLM.
// Mirrors conformance-pi.test.ts: the same scenarios must give the same wire events.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginTool } from "@prometheus/plugin-sdk";
import type { GatewayConfig, SessionEvent } from "@prometheus/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ToolBus } from "../src/agent/bus/tool-bus.ts";
import { ClaudeCodeRuntime } from "../src/agent/claude-code/cc-runtime.ts";
import { GatewayRelay, type RelayExchange } from "../src/agent/relay/gateway-relay.ts";
import type { RuntimeServices, RuntimeSession } from "../src/agent/types.ts";
import { PermissionGate } from "../src/permission-gate.ts";
import { UIBridge } from "../src/ui-bridge.ts";
import { FakeLlm } from "./support/fake-llm.ts";

const REAL_KEY = "real-upstream-key";
const llm = new FakeLlm();
let relay: GatewayRelay;
let bus: ToolBus;
let runtime: ClaudeCodeRuntime;
let root: string;
let cwd: string;
let gateway: GatewayConfig;
const exchanges: RelayExchange[] = [];
let events: SessionEvent[] = [];
let session: RuntimeSession;
let gate: PermissionGate;
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

async function settle(timeoutMs = 60_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (events.some((e) => e.type === "agent_settled")) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`did not settle; events: ${events.map((e) => e.type).join(",")}`);
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "prometheus-cc-"));
	cwd = join(root, "work");
	await mkdir(cwd);
	await writeFile(join(cwd, "hello.txt"), "hello file\n");
	await llm.start();
	relay = new GatewayRelay({ onExchange: (e) => exchanges.push(e) });
	await relay.start();
	bus = new ToolBus();
	await bus.start();
	gateway = {
		id: "up",
		name: "up",
		format: "anthropic-messages",
		baseUrl: llm.baseUrl,
		auth: { type: "native" },
		apiKey: REAL_KEY,
		models: [{ id: "fake-model", name: "fake" }],
	};
	const services: RuntimeServices = {
		bus,
		relay,
		plugins: {
			externalView: async () => ({ tools: [{ plugin: "test", tool: echoTool }] }),
			collectContextExternal: async (req: { prompt: string }) => ({
				static: { sections: { knowledge: "KB-LIST-MARKER" }, guidelines: ["be brief"] },
				turn: req.prompt ? [`TURN-MARKER for: ${req.prompt}`] : [],
			}),
		} as never,
		gateway: (id) => (id === "up" ? gateway : undefined),
		dataDir: root,
		log: { info: () => {}, warn: () => {} },
	};
	runtime = new ClaudeCodeRuntime(async () => services);
}, 60_000);

afterAll(async () => {
	await session?.dispose();
	await bus?.stop();
	await relay?.stop();
	await llm.stop();
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

beforeEach(async () => {
	llm.reset();
	events = [];
	exchanges.length = 0;
	asked.length = 0;
	if (!session) {
		const ui = new UIBridge({ request: () => {}, resolved: () => {} });
		gate = new PermissionGate();
		gate.ask = async (p) => {
			asked.push(p);
			return "allow";
		};
		session = await runtime.create({
			cwd,
			gateway: { mode: "prometheus", gatewayId: "up", model: { provider: "up", id: "fake-model" } },
			permission: gate,
			ui,
			hooks: { event: (e) => void events.push(e) },
		});
	}
});

const find = <T extends SessionEvent["type"]>(type: T) => events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

describe("conformance harness on Claude Code", { timeout: 90_000 }, () => {
	it("probes as available", async () => {
		expect((await runtime.probe()).available).toBe(true);
	});

	it("lists Claude Code's own commands and skills for the slash menu", async () => {
		const list = await session.commands();
		expect(list.length).toBeGreaterThan(0);
		expect(list.some((c) => c.name === "compact")).toBe(true);
	});

	it("plain text turn: wire events, relay-only credentials, plugin context in the request", async () => {
		llm.enqueue({ blocks: [{ type: "text", text: "hello from the fake model" }] });
		await session.prompt({ text: "say hi" }, "send");
		await settle();

		const types = events.map((e) => e.type);
		expect(types.slice(0, 3)).toEqual(["agent_start", "message_start", "message_end"]); // the user message first
		expect(types).toContain("agent_start");
		expect(types).toContain("message_update");
		expect(types.at(-1)).toBe("agent_settled");
		expect(JSON.stringify(find("message_end").at(-1)?.message)).toContain("hello from the fake model");

		const req = llm.requests.find((r) => r.lastUser.includes("say hi"))!;
		expect(req).toBeDefined();
		// real key injected by the relay, session token never reaches upstream
		expect(req.headers["x-api-key"]).toBe(REAL_KEY);
		// static context in the system prompt, turn context next to the user message
		expect(req.system).toContain("KB-LIST-MARKER");
		expect(JSON.stringify(req.body.messages)).toContain("TURN-MARKER for: say hi");
		// Prometheus tools are offered under their MCP names
		const names = (req.body.tools ?? []).map((t: any) => t.name);
		expect(names).toContain("mcp__prometheus__echo_tool");
		expect(names).not.toContain("Task");
		expect(exchanges.every((e) => e.sessionId === session.id)).toBe(true);
	});

	it("a Prometheus tool round-trips through the bus with canonical name and details", async () => {
		llm.enqueue({ blocks: [{ type: "tool_use", name: "mcp__prometheus__echo_tool", input: { text: "ping" } }] }, { blocks: [{ type: "text", text: "done" }] });
		await session.prompt({ text: "use the tool" }, "send");
		await settle();
		const start = find("tool_execution_start");
		const end = find("tool_execution_end");
		expect(start.map((e) => e.toolName)).toEqual(["echo_tool"]);
		expect(end).toHaveLength(1);
		expect(end[0]!.toolName).toBe("echo_tool");
		expect(end[0]!.isError).toBe(false);
		expect(JSON.stringify(end[0]!.result)).toContain("echo:ping");
		expect(JSON.stringify(end[0]!.result)).toContain("echoed");
		// ids correlate with the model's tool_use block
		expect(start[0]!.toolCallId).toBe(end[0]!.toolCallId);
		expect(start[0]!.toolCallId).toMatch(/^toolu_/);
	});

	it("a native tool is normalized (bash) and goes through the permission gate", async () => {
		await session.setPermissionMode("default");
		llm.enqueue({ blocks: [{ type: "tool_use", name: "Bash", input: { command: "echo from-bash > out.txt", description: "write" } }] }, { blocks: [{ type: "text", text: "ok" }] });
		await session.prompt({ text: "run bash" }, "send");
		await settle();
		const start = find("tool_execution_start");
		expect(start[0]?.toolName, events.map((e) => e.type + (e.type.startsWith("tool") ? ":" + (e as any).toolName : "")).join(",") + " | " + JSON.stringify(llm.requests.map((r) => r.lastUser.slice(0, 200)))).toBe("bash");
		expect((start[0]?.args as any).command).toContain("echo from-bash");
		expect(asked.length).toBeGreaterThan(0);
		expect(find("tool_execution_end")[0]?.isError).toBe(false);
	});

	it("a refused native tool is blocked and reported as an error result", async () => {
		gate.ask = async () => "deny";
		llm.enqueue({ blocks: [{ type: "tool_use", name: "Bash", input: { command: "echo nope > nope.txt" } }] }, { blocks: [{ type: "text", text: "understood" }] });
		await session.prompt({ text: "try bash" }, "send");
		await settle();
		const end = find("tool_execution_end");
		expect(end[0]?.isError).toBe(true);
		const second = llm.requests.at(-1)!;
		expect(second.lastUser).toContain("denied");
	});

	it("abort during streaming settles as aborted", async () => {
		llm.enqueue({ blocks: [{ type: "text", text: "a long answer that keeps streaming slowly" }], delayMs: 1500 });
		await session.prompt({ text: "slow one" }, "send");
		await new Promise((r) => setTimeout(r, 1200));
		await session.abort();
		await settle();
		expect(find("agent_settled")[0]?.aborted).toBe(true);
	});

	it("an upstream error surfaces as an error message and the session stays usable", async () => {
		llm.enqueue({ status: 400 });
		await session.prompt({ text: "break" }, "send");
		await settle();
		expect(exchanges.map((e) => e.status)).toContain(400);
		events = [];
		llm.enqueue({ blocks: [{ type: "text", text: "back again" }] });
		await session.prompt({ text: "again" }, "send");
		await settle();
		expect(JSON.stringify(find("message_end").at(-1)?.message)).toContain("back again");
	});

	it("plan mode: writes are refused, ExitPlanMode asks for approval and switches mode", async () => {
		await session.setPermissionMode("plan");
		gate.ask = async (p: any) => {
			asked.push(p);
			return p.kind === "plan" ? "acceptEdits" : "allow";
		};
		llm.enqueue(
			{ blocks: [{ type: "text", text: "1. do the thing" }, { type: "tool_use", name: "Write", input: { file_path: join(cwd, "plan-blocked.txt"), content: "x" } }] },
			{ blocks: [{ type: "tool_use", name: "ExitPlanMode", input: {} }] },
			{ blocks: [{ type: "text", text: "planned" }] },
		);
		await session.prompt({ text: "plan something" }, "send");
		await settle();
		const ends = find("tool_execution_end");
		expect(ends[0]?.isError, JSON.stringify([asked, ends.map((e) => [e.toolName, e.isError, e.result]), events.map((e) => e.type)])).toBe(true);
		expect(asked.some((p: any) => p.kind === "plan" && p.plan.includes("do the thing")), JSON.stringify([asked, ends.map((e) => [e.toolName, e.isError, e.result])])).toBe(true);
		expect(gate.mode).toBe("acceptEdits");
		await session.setPermissionMode("default");
	});

	it("a message sent while a turn runs is merged into it (steering)", async () => {
		llm.enqueue({ blocks: [{ type: "text", text: "working on it for a while" }], delayMs: 600 }, { blocks: [{ type: "text", text: "and the steer was seen" }] });
		await session.prompt({ text: "start long" }, "send");
		await new Promise((r) => setTimeout(r, 300));
		const disposition = await session.prompt({ text: "also include PINEAPPLE" }, "steer");
		expect(disposition).toBe("queued");
		await settle();
		// give a trailing queued turn time to finish too
		await new Promise((r) => setTimeout(r, 1500));
		expect(JSON.stringify(llm.requests.map((r) => r.body.messages))).toContain("PINEAPPLE");
	});
});
