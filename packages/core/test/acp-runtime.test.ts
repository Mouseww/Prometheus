// ACP runtime against a scripted agent (test/support/fake-acp-agent.mjs): handshake, streaming, tool calls,
// the single permission gate, Prometheus tools over the bus (HTTP and the stdio bridge), queueing, abort, resume.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginTool } from "@prometheus/plugin-sdk";
import type { SessionEvent } from "@prometheus/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpRuntime } from "../src/agent/acp/acp-runtime.ts";
import { acpMirrorPath } from "../src/agent/acp/acp-session.ts";
import { canonicalAcpTool, stripHidden } from "../src/agent/acp/acp-mapper.ts";
import { ToolBus } from "../src/agent/bus/tool-bus.ts";
import { GatewayRelay } from "../src/agent/relay/gateway-relay.ts";
import type { RuntimeServices, RuntimeSession } from "../src/agent/types.ts";
import { PermissionGate } from "../src/permission-gate.ts";
import { UIBridge } from "../src/ui-bridge.ts";

const AGENT = fileURLToPath(new URL("./support/fake-acp-agent.mjs", import.meta.url));

let root: string;
let cwd: string;
let bus: ToolBus;
let relay: GatewayRelay;
let services: RuntimeServices;
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

function runtime(env: Record<string, string> = {}): AcpRuntime {
	return new AcpRuntime(async () => services, () => ({ id: "fake", name: "Fake Agent", command: AGENT, args: [], env: { ...process.env, ...env } }));
}

interface Harness {
	session: RuntimeSession;
	events: SessionEvent[];
	gate: PermissionGate;
}

async function open(rt: AcpRuntime, mode: "default" | "bypassPermissions" = "bypassPermissions", answer: "allow" | "deny" = "allow"): Promise<Harness> {
	const events: SessionEvent[] = [];
	const gate = new PermissionGate();
	gate.mode = mode;
	gate.ask = async (p) => {
		asked.push(p);
		return answer;
	};
	const session = await rt.create({ cwd, permission: gate, ui: new UIBridge({ request: () => {}, resolved: () => {} }), hooks: { event: (e) => void events.push(e) } });
	return { session, events, gate };
}

async function settle(h: Harness, count = 1, timeoutMs = 20_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (h.events.filter((e) => e.type === "agent_settled").length >= count) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`did not settle; events: ${h.events.map((e) => e.type).join(",")}`);
}

const of = <T extends SessionEvent["type"]>(h: Harness, type: T) => h.events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "prometheus-acp-"));
	cwd = join(root, "work");
	await mkdir(cwd);
	bus = new ToolBus();
	await bus.start();
	relay = new GatewayRelay({});
	await relay.start();
	services = {
		bus,
		relay,
		plugins: {
			externalView: async () => ({ tools: [{ plugin: "test", tool: echoTool }] }),
			collectContextExternal: async (req: { prompt: string }) => ({ static: { sections: { knowledge: "KB-LIST-MARKER" }, guidelines: [] }, turn: req.prompt ? [`TURN-MARKER for: ${req.prompt}`] : [] }),
		} as never,
		gateway: () => undefined,
		dataDir: root,
		log: { info: () => {}, warn: () => {} },
	};
});

afterAll(async () => {
	await bus?.stop();
	await relay?.stop();
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("ACP mapping helpers", () => {
	it("normalizes the agent's tool kinds to the tools Prometheus renders", () => {
		expect(canonicalAcpTool({ toolCallId: "1", kind: "execute", title: "ls", rawInput: { command: "ls -la" } })).toEqual({ name: "bash", args: { command: "ls -la" } });
		expect(canonicalAcpTool({ toolCallId: "1", kind: "read", locations: [{ path: "/a.ts" }] }).args.path).toBe("/a.ts");
		expect(canonicalAcpTool({ toolCallId: "1", kind: "edit", content: [{ type: "diff", path: "/a", oldText: "x", newText: "y" }] })).toEqual({ name: "edit", args: { path: "/a", edits: [{ oldText: "x", newText: "y" }] } });
		expect(canonicalAcpTool({ toolCallId: "1", kind: "edit", content: [{ type: "diff", path: "/b", oldText: null, newText: "z" }] })).toEqual({ name: "write", args: { path: "/b", content: "z" } });
		expect(canonicalAcpTool({ toolCallId: "1", kind: "fetch", rawInput: { url: "https://x" } }).name).toBe("web_fetch");
		expect(canonicalAcpTool({ toolCallId: "1", kind: "search", rawInput: { pattern: "foo" } }).name).toBe("grep");
	});

	it("drops the context Prometheus sent beside a prompt", () => {
		expect(stripHidden("<prometheus-context>\nsecret\n</prometheus-context>\n\nhello")).toBe("hello");
		expect(stripHidden("<previous_conversation>\nold\n</previous_conversation>\nhi")).toBe("hi");
	});
});

describe("ACP runtime with a scripted agent", { timeout: 60_000 }, () => {
	it("probes the agent with an initialize handshake", async () => {
		expect(await runtime().probe()).toMatchObject({ available: true, version: "9.9.9" });
		const missing = new AcpRuntime(async () => services, () => ({ id: "x", name: "X", command: "definitely-not-an-acp-agent-xyz", args: [], env: { ...process.env } }));
		expect(await missing.probe()).toMatchObject({ available: false, missing: true });
	});

	it("streams thoughts and text, and lists the agent's models and commands", async () => {
		const rt = runtime();
		const h = await open(rt);
		await h.session.prompt({ text: "hello" }, "send");
		await settle(h);
		const types = h.events.map((e) => e.type);
		expect(types[0]).toBe("agent_start");
		expect(types.at(-1)).toBe("agent_settled");
		const msgs = h.session.messages();
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
		expect(JSON.stringify(msgs[1])).toContain("thinking about it");
		expect(h.session.lastReply()).toBe("Hi there");
		const models = await rt.listAllModels([]);
		expect(models.map((m) => m.id)).toEqual(["default", "m1", "m2"]);
		expect(h.session.commands()).toEqual([{ name: "compress", description: "Compress the context", source: "prompt" }]);
		await h.session.dispose();
	});

	it("sends static and turn context hidden beside the prompt, keeps the agent in its asking mode, applies the model", async () => {
		const h = await open(runtime());
		await h.session.setModel({ provider: "acp", id: "m2" });
		await h.session.prompt({ text: "echo context", context: "<previous_conversation>\nHANDOFF\n</previous_conversation>" }, "send");
		await settle(h);
		const reply = h.session.lastReply();
		expect(reply).toContain("KB-LIST-MARKER");
		expect(reply).toContain("TURN-MARKER for: echo context");
		expect(reply).toContain("HANDOFF");
		expect(reply).toContain("MODE:default");
		expect(reply).toContain("MODEL:m2");
		// what the user wrote is shown without the context
		expect(JSON.stringify(h.session.messages()[0])).not.toContain("TURN-MARKER");
		// the static context goes with the first prompt only
		await h.session.prompt({ text: "echo context again" }, "send");
		await settle(h, 2);
		expect(h.session.lastReply()).not.toContain("KB-LIST-MARKER");
		await h.session.dispose();
	});

	it("asks the gate before the agent runs a command; a refusal fails the tool", async () => {
		asked.length = 0;
		const h = await open(runtime(), "default", "deny");
		await h.session.prompt({ text: "run bash" }, "send");
		await settle(h);
		expect(asked.length).toBe(1);
		const start = of(h, "tool_execution_start");
		expect(start[0]).toMatchObject({ toolName: "bash", args: { command: "touch made.txt" } });
		expect(of(h, "tool_execution_end")[0]?.isError).toBe(true);
		expect(h.session.lastReply()).toBe("could not run it");
		h.gate.mode = "bypassPermissions";
		await h.session.prompt({ text: "run bash" }, "send");
		await settle(h, 2);
		expect(asked.length).toBe(1);
		expect(of(h, "tool_execution_end")[1]?.isError).toBe(false);
		expect(JSON.stringify(of(h, "tool_execution_end")[1]?.result)).toContain("hi");
		await h.session.dispose();
	});

	it("shows a new file as a write with its content", async () => {
		const h = await open(runtime());
		await h.session.prompt({ text: "write file" }, "send");
		await settle(h);
		expect(of(h, "tool_execution_start")[0]).toMatchObject({ toolName: "write", args: { path: "/tmp/a.txt", content: "new content" } });
		await h.session.dispose();
	});

	for (const http of [true, false]) {
		it(`a Prometheus tool round-trips through the bus (${http ? "HTTP" : "stdio bridge"}) without a second permission prompt`, async () => {
			asked.length = 0;
			const h = await open(runtime({ FAKE_ACP_HTTP: http ? "1" : "0" }), "default", "allow");
			await h.session.prompt({ text: "use tool" }, "send");
			await settle(h);
			expect(asked.length).toBe(0);
			const start = of(h, "tool_execution_start");
			const end = of(h, "tool_execution_end");
			expect(start.map((e) => e.toolName)).toEqual(["echo_tool"]);
			expect(start[0]!.args).toEqual({ text: "ping" });
			expect(end).toHaveLength(1);
			expect(end[0]!.toolCallId).toBe(start[0]!.toolCallId);
			expect(JSON.stringify(end[0]!.result)).toContain("echoed");
			expect(h.session.lastReply()).toBe("tool done");
			await h.session.dispose();
		});
	}

	it("feeds the agent's plan to the todo panel", async () => {
		const h = await open(runtime());
		await h.session.prompt({ text: "make a plan" }, "send");
		await settle(h);
		const end = of(h, "tool_execution_end").find((e) => e.toolName === "todo_write");
		expect((end?.result as any).details.todos.map((t: any) => t.status)).toEqual(["completed", "in_progress"]);
		await h.session.dispose();
	});

	it("queues a prompt sent during a turn, and abort cancels the turn", async () => {
		const h = await open(runtime());
		await h.session.prompt({ text: "slow" }, "send");
		expect(await h.session.prompt({ text: "hello" }, "send")).toBe("queued");
		expect(h.session.snapshotState().queue.followUp).toEqual(["hello"]);
		await new Promise((r) => setTimeout(r, 200));
		await h.session.abort();
		await settle(h);
		expect(of(h, "agent_settled")[0]?.aborted).toBe(true);
		// abort drops what was queued
		expect(h.session.snapshotState().queue.followUp).toEqual([]);
		await h.session.prompt({ text: "slow" }, "send");
		await h.session.prompt({ text: "hello" }, "send");
		await new Promise((r) => setTimeout(r, 100));
		await h.session.waitForIdle().catch(() => undefined);
		await settle(h, 3);
		expect(h.session.lastReply()).toBe("Hi there");
		await h.session.dispose();
	});

	it("restarts a crashed agent on the next prompt and reloads its session", async () => {
		const h = await open(runtime());
		await h.session.prompt({ text: "crash" }, "send");
		await settle(h);
		expect(h.session.messages().at(-1)).toMatchObject({ stopReason: "error" });
		await h.session.prompt({ text: "hello" }, "send");
		await settle(h, 2);
		expect(h.session.lastReply()).toBe("Hi there");
		await h.session.dispose();
	});

	it("resumes a closed chat with the transcript Prometheus kept", async () => {
		const rt = runtime();
		const h = await open(rt);
		await h.session.prompt({ text: "hello" }, "send");
		await settle(h);
		const ref = h.session.ref();
		await h.session.dispose();
		const events: SessionEvent[] = [];
		const resumed = await rt.resume({ ...ref, cwd }, { permission: new PermissionGate(), ui: new UIBridge({ request: () => {}, resolved: () => {} }), hooks: { event: (e) => void events.push(e) } });
		expect(resumed.messages().map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
		expect(resumed.nativeId).toBe(ref.nativeId);
		await resumed.dispose();
		// without Prometheus' copy, the agent's own replay is used (and the hidden context stays hidden)
		await rm(acpMirrorPath(root, ref.id), { force: true });
		const replayed = await rt.resume({ ...ref, cwd }, { permission: new PermissionGate(), ui: new UIBridge({ request: () => {}, resolved: () => {} }) });
		const text = JSON.stringify(replayed.messages());
		expect(text).toContain("earlier question");
		expect(text).toContain("earlier answer");
		expect(text).not.toContain("hidden");
		await replayed.dispose();
	});
});
