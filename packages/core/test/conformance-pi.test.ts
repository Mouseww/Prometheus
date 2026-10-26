// P3 acceptance (docs/agent-runtime.md §13): the conformance harness runs end to end against PI.
// PI -> gateway relay -> scripted fake LLM. The relay injects the real key; PI only ever holds a session token.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@prometheus/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GatewayRelay, type RelayExchange } from "../src/agent/relay/gateway-relay.ts";
import { PrometheusHost } from "../src/host.ts";
import memory from "../../../plugins/memory/src/index.ts";
import todos from "../../../plugins/todos/src/index.ts";
import { FakeLlm } from "./support/fake-llm.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const REAL_KEY = "sk-REAL-UPSTREAM-KEY";

let root: string;
let host: PrometheusHost;
let previousAgentDir: string | undefined;
const llm = new FakeLlm();
let relay: GatewayRelay;
const exchanges: RelayExchange[] = [];
let events: { sessionId: string; event: SessionEvent }[] = [];
let sessionId: string;
let token: string;

async function idle(id: string, timeoutMs = 20_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (events.some((e) => e.sessionId === id && e.event.type === "agent_settled")) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`session did not settle; events: ${events.map((e) => e.event.type).join(",")}`);
}

beforeAll(async () => {
	await llm.start();
	relay = new GatewayRelay({ onExchange: (e) => exchanges.push(e) });
	await relay.start();

	root = await mkdtemp(join(tmpdir(), "prometheus-conf-"));
	const cwd = join(root, "work");
	await mkdir(cwd);
	previousAgentDir = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = join(root, "agent");

	const upstreamGateway = {
		id: "up",
		name: "up",
		format: "anthropic-messages" as const,
		baseUrl: llm.baseUrl,
		auth: { type: "native" as const },
		apiKey: REAL_KEY,
		models: [{ id: "fake-model", name: "fake" }],
	};
	const grant = relay.grant("conf", "up", () => upstreamGateway);
	token = grant.token;

	host = await PrometheusHost.create({
		dataDir: join(root, "data"),
		cwd,
		builtinPlugins: [memory, todos],
		listener: {
			event: (id, event) => void events.push({ sessionId: id, event }),
			uiRequest: () => {},
			uiResolved: () => {},
			sessionsChanged: () => {},
			gatewaysChanged: () => {},
			pluginsChanged: () => {},
			pluginNotify: () => {},
		},
	});
	// PI sees the relay as an ordinary gateway whose key is the session token.
	await host.call("gateway.save", {
		gateway: { id: "via-relay", name: "via-relay", format: "anthropic-messages", baseUrl: grant.baseUrl, auth: { type: "native" }, apiKey: token, models: [{ id: "fake-model", name: "fake" }] },
	});
	const snap = await host.call("session.create", { cwd, name: "conf" });
	sessionId = snap.id;
	await host.call("model.set", { sessionId, model: { provider: "via-relay", id: "fake-model" } });
	await host.call("permission.set", { sessionId, mode: "bypassPermissions" }).catch(() => undefined);
}, 90_000);

afterAll(async () => {
	await host?.dispose();
	await relay?.stop();
	await llm.stop();
	if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previousAgentDir;
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
	llm.reset();
	events = [];
	exchanges.length = 0;
});

describe("conformance harness on PI", { timeout: 40_000 }, () => {
	it("plain text turn streams through the relay and the real key never leaves it", async () => {
		llm.enqueue({ blocks: [{ type: "text", text: "hello from the fake model" }] });
		await host.call("chat.prompt", { sessionId, text: "say hi" });
		await idle(sessionId);

		const types = events.map((e) => e.event.type);
		expect(types).toContain("message_update");
		const ended = events.map((e) => e.event).filter((e): e is Extract<SessionEvent, { type: "message_end" }> => e.type === "message_end");
		expect(JSON.stringify(ended.at(-1)?.message)).toContain("hello from the fake model");

		expect(llm.requests).toHaveLength(1);
		expect(llm.requests[0]!.headers["x-api-key"]).toBe(REAL_KEY);
		expect(JSON.stringify(llm.requests[0]!.headers)).not.toContain(token);
		expect(llm.requests[0]!.lastUser).toContain("say hi");
		expect(exchanges.map((e) => e.status)).toEqual([200]);
		expect(exchanges[0]).toMatchObject({ sessionId: "conf", gatewayId: "up" });
	});

	it("a Prometheus tool round-trips and the system prompt carries plugin context", async () => {
		llm.enqueue(
			{ blocks: [{ type: "tool_use", name: "todo_write", input: { todos: [{ content: "write tests", status: "in_progress" }] } }] },
			{ blocks: [{ type: "text", text: "done" }] },
		);
		await host.call("chat.prompt", { sessionId, text: "plan it" });
		await idle(sessionId);

		const toolEnd = events.map((e) => e.event).find((e): e is Extract<SessionEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end");
		expect(toolEnd?.toolName).toBe("todo_write");
		expect(toolEnd?.isError, JSON.stringify(toolEnd?.result)).toBe(false);
		// the second upstream request carries the tool result back
		expect(llm.requests).toHaveLength(2);
		expect(llm.requests[1]!.lastUser).toContain("[tool_result]");
		// tools declared to the model include the neutral plugin tools
		const names = (llm.requests[0]!.body.tools ?? []).map((t: any) => t.name);
		expect(names).toContain("todo_write");
		expect(names).toContain("memory_search");
	});

	it("an upstream error surfaces and the relay reports the status", async () => {
		llm.enqueue({ status: 400 });
		await host.call("chat.prompt", { sessionId, text: "fail please" });
		await idle(sessionId);
		expect(exchanges.map((e) => e.status)).toContain(400);
	});

	it("abort during streaming stops the turn", async () => {
		llm.enqueue({ blocks: [{ type: "text", text: "a long answer that keeps streaming" }], delayMs: 800 });
		await host.call("chat.prompt", { sessionId, text: "slow" });
		await new Promise((r) => setTimeout(r, 300));
		await host.call("chat.abort", { sessionId });
		await idle(sessionId);
		const settled = events.map((e) => e.event).find((e): e is Extract<SessionEvent, { type: "agent_settled" }> => e.type === "agent_settled");
		expect(settled?.aborted).toBe(true);
	});

	it("saved memory reaches the next upstream request as turn context", async () => {
		llm.enqueue(
			{ blocks: [{ type: "tool_use", name: "memory_save", input: { content: "the user prefers tabs over spaces" } }] },
			{ blocks: [{ type: "text", text: "saved" }] },
			{ blocks: [{ type: "text", text: "noted" }] },
		);
		await host.call("chat.prompt", { sessionId, text: "remember my style" });
		await idle(sessionId);
		events = [];
		await host.call("chat.prompt", { sessionId, text: "tabs or spaces for formatting?" });
		await idle(sessionId);
		const last = llm.requests.at(-1)!;
		expect(JSON.stringify(last.body)).toContain("prefers tabs over spaces");
	});
});
