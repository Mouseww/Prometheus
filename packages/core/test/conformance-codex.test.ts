// P5: Codex (`codex app-server`) -> gateway relay -> scripted fake Responses LLM.
// Needs the codex CLI on PATH; the suite skips itself when it is missing.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginTool } from "@prometheus/plugin-sdk";
import type { GatewayConfig, SessionEvent } from "@prometheus/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ToolBus } from "../src/agent/bus/tool-bus.ts";
import { CodexRuntime } from "../src/agent/codex/codex-runtime.ts";
import { GatewayRelay, type RelayExchange } from "../src/agent/relay/gateway-relay.ts";
import type { RuntimeServices, RuntimeSession } from "../src/agent/types.ts";
import { PermissionGate } from "../src/permission-gate.ts";
import { UIBridge } from "../src/ui-bridge.ts";
import { FakeResponsesLlm } from "./support/fake-llm.ts";

const REAL_KEY = "real-upstream-key";
const llm = new FakeResponsesLlm();
let relay: GatewayRelay;
let bus: ToolBus;
let runtime: CodexRuntime;
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

async function settle(timeoutMs = 90_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (events.some((e) => e.type === "agent_settled")) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`did not settle; events: ${events.map((e) => e.type).join(",")}`);
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "prometheus-codex-"));
	cwd = join(root, "work");
	await mkdir(cwd);
	await llm.start();
	relay = new GatewayRelay({ onExchange: (e) => exchanges.push(e) });
	await relay.start();
	bus = new ToolBus();
	await bus.start();
	gateway = { id: "up", name: "up", format: "openai-responses", baseUrl: `${llm.baseUrl}/v1`, auth: { type: "bearer" }, apiKey: REAL_KEY, models: [{ id: "fake-model", name: "fake" }] };
	const services: RuntimeServices = {
		bus,
		relay,
		plugins: {
			externalView: async () => ({ tools: [{ plugin: "test", tool: echoTool }] }),
			collectContextExternal: async (req: { prompt: string }) => ({
				static: { sections: { knowledge: "KB-LIST-MARKER" }, guidelines: [] },
				turn: req.prompt ? [`TURN-MARKER for: ${req.prompt}`] : [],
			}),
		} as never,
		gateway: (id) => (id === "up" ? gateway : undefined),
		dataDir: root,
		log: { info: () => {}, warn: () => {} },
	};
	runtime = new CodexRuntime(async () => services);
	available = (await runtime.probe()).available;
}, 60_000);

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
}, 60_000);

const find = <T extends SessionEvent["type"]>(type: T) => events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

describe("conformance harness on Codex", { timeout: 120_000 }, () => {
	it("lists Codex skills for the slash menu without failing", async () => {
		const list = await session!.commands();
		expect(Array.isArray(list)).toBe(true);
		expect(list.every((c) => c.source === "skill")).toBe(true);
	});

	it("plain text turn: wire events, relay-only credentials, plugin context in the request", async () => {
		llm.enqueue({ blocks: [{ type: "text", text: "hello from the fake model" }] });
		await session!.prompt({ text: "say hi" }, "send");
		await settle();

		const types = events.map((e) => e.type);
		expect(types.slice(0, 3)).toEqual(["agent_start", "message_start", "message_end"]);
		expect(types).toContain("message_update");
		expect(types.at(-1)).toBe("agent_settled");
		expect(JSON.stringify(find("message_end").at(-1)?.message)).toContain("hello from the fake model");

		const req = llm.requests.find((r) => r.lastUser.includes("say hi"))!;
		expect(req).toBeDefined();
		// the relay swapped the session token for the real key
		expect(req.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
		expect(req.instructions + req.inputText).toContain("KB-LIST-MARKER");
		expect(req.lastUser).toContain("TURN-MARKER for: say hi");
		expect(req.toolNames.join(",")).toContain("echo_tool");
		expect(exchanges.every((e) => e.sessionId === session!.id)).toBe(true);
	});

	it("a Prometheus tool round-trips through the bus with its canonical name and details", async () => {
		llm.enqueue({ blocks: [{ type: "mcp", tool: "echo_tool", input: { text: "ping" } }] }, { blocks: [{ type: "text", text: "done" }] });
		await session!.prompt({ text: "use the tool" }, "send");
		await settle();
		const start = find("tool_execution_start");
		const end = find("tool_execution_end");
		expect(start.map((e) => e.toolName)).toEqual(["echo_tool"]);
		expect(end).toHaveLength(1);
		expect(end[0]!.isError).toBe(false);
		expect(JSON.stringify(end[0]!.result)).toContain("echo:ping");
		expect(JSON.stringify(end[0]!.result)).toContain("echoed");
		expect(start[0]!.toolCallId).toBe(end[0]!.toolCallId);
	});

	it("plan mode: exit_plan_mode asks the user, and approval leaves plan mode", async () => {
		gate.setMode("plan");
		llm.enqueue({ blocks: [{ type: "mcp", tool: "exit_plan_mode", input: { plan: "1. do it" } }] }, { blocks: [{ type: "text", text: "starting" }] });
		const prev = gate.ask;
		gate.ask = async (p) => {
			asked.push(p);
			return p.kind === "plan" ? "default" : "allow";
		};
		await session!.prompt({ text: "plan it" }, "send");
		await settle();
		gate.ask = prev;
		expect(asked.some((p: any) => p.kind === "plan")).toBe(true);
		expect(gate.mode).toBe("default");
		expect(find("tool_execution_end").at(-1)!.isError).toBe(false);
		gate.setMode("bypassPermissions");
	});

	it("a shell command is normalized to bash and reports its output", async () => {
		llm.enqueue({ blocks: [{ type: "shell", command: "echo from-codex-shell" }] }, { blocks: [{ type: "text", text: "ok" }] });
		await session!.prompt({ text: "run it" }, "send");
		await settle();
		const start = find("tool_execution_start");
		expect(start[0]?.toolName).toBe("bash");
		expect(JSON.stringify(start[0]?.args)).toContain("echo from-codex-shell");
		const end = find("tool_execution_end");
		expect(end[0]?.isError).toBe(false);
		expect(JSON.stringify(end[0]?.result)).toContain("from-codex-shell");
	});

	it("abort during streaming settles as aborted", async () => {
		llm.enqueue({ blocks: [{ type: "text", text: "a long answer that keeps streaming slowly" }], delayMs: 1500 });
		await session!.prompt({ text: "slow one" }, "send");
		await new Promise((r) => setTimeout(r, 1200));
		await session!.abort();
		await settle();
		expect(find("agent_settled")[0]?.aborted).toBe(true);
	});

	it("an upstream error surfaces and the session stays usable", async () => {
		llm.enqueue({ status: 400 });
		await session!.prompt({ text: "break" }, "send");
		await settle();
		expect(exchanges.map((e) => e.status)).toContain(400);
		expect(find("message_end").some((e) => (e.message as { stopReason?: string }).stopReason === "error")).toBe(true);
		events = [];
		llm.enqueue({ blocks: [{ type: "text", text: "back again" }] });
		await session!.prompt({ text: "again" }, "send");
		await settle();
		expect(JSON.stringify(find("message_end").at(-1)?.message)).toContain("back again");
	});

	it("approvals go through the permission gate: a refusal is reported as an error result", async () => {
		await session!.setPermissionMode("default");
		gate.ask = async (p) => {
			asked.push(p);
			return "deny";
		};
		llm.enqueue({ blocks: [{ type: "shell", command: "echo nope > nope.txt" }] }, { blocks: [{ type: "text", text: "understood" }] });
		await session!.prompt({ text: "write a file" }, "send");
		await settle();
		expect(asked.length).toBeGreaterThan(0);
		const end = find("tool_execution_end");
		expect(end[0]?.isError).toBe(true);
		// allowing it lets the command run
		events = [];
		asked.length = 0;
		gate.ask = async (p) => {
			asked.push(p);
			return "allow";
		};
		llm.enqueue({ blocks: [{ type: "shell", command: "echo yes > yes.txt" }] }, { blocks: [{ type: "text", text: "written" }] });
		await session!.prompt({ text: "write another file" }, "send");
		await settle();
		expect(asked.length).toBeGreaterThan(0);
		expect(find("tool_execution_end")[0]?.isError).toBe(false);
		await session!.setPermissionMode("bypassPermissions");
	});
});
