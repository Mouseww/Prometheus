// A Claude Code session driven through the host's RPC surface: create, chat, list, close, reopen (resume), delete.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@prometheus/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrometheusHost } from "../src/host.ts";
import memory from "../../../plugins/memory/src/index.ts";
import veil from "../../../plugins/veil/src/index.ts";
import todos from "../../../plugins/todos/src/index.ts";
import { FakeLlm } from "./support/fake-llm.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const llm = new FakeLlm();
let root: string;
let cwd: string;
let host: PrometheusHost;
let previous: string | undefined;
let events: { sessionId: string; event: SessionEvent }[] = [];

async function settled(id: string, timeoutMs = 60_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (events.some((e) => e.sessionId === id && e.event.type === "agent_settled")) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("did not settle");
}

beforeAll(async () => {
	await llm.start();
	root = await mkdtemp(join(tmpdir(), "prometheus-hostcc-"));
	cwd = join(root, "work");
	await mkdir(cwd);
	previous = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = join(root, "agent");
	host = await PrometheusHost.create({
		dataDir: join(root, "data"),
		cwd,
		builtinPlugins: [memory, todos, veil],
		listener: {
			event: (sessionId, event) => void events.push({ sessionId, event }),
			uiRequest: () => {},
			uiResolved: () => {},
			sessionsChanged: () => {},
			gatewaysChanged: () => {},
			pluginsChanged: () => {},
			pluginNotify: () => {},
		},
	});
	await host.call("gateway.save", {
		gateway: { id: "fake", name: "fake", format: "anthropic-messages", baseUrl: llm.baseUrl, auth: { type: "native" }, apiKey: "k", models: [{ id: "fake-model", name: "fake" }] },
	});
}, 90_000);

afterAll(async () => {
	await host?.dispose();
	await llm.stop();
	if (previous === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previous;
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("Claude Code through the host", { timeout: 120_000 }, () => {
	it("lists runtimes with capabilities", async () => {
		const list = await host.call("runtime.list", {});
		expect(list.map((r) => r.kind)).toEqual(["pi", "claude-code", "codex"]);
		expect(list[1]!.health.available).toBe(true);
		expect(list[1]!.capabilities.followUpQueue).toBe(false);
		const models = await host.call("runtime.models", { runtime: "claude-code", gateway: { mode: "prometheus", gatewayId: "fake", model: { provider: "fake", id: "fake-model" } } });
		expect(models.map((m) => m.id)).toEqual(["fake-model"]);
	});

	it("creates, chats, lists, closes, resumes and deletes", async () => {
		const gateway = { mode: "prometheus" as const, gatewayId: "fake", model: { provider: "fake", id: "fake-model" } };
		const snap = await host.call("session.create", { cwd, name: "cc one", runtime: "claude-code", gateway });
		expect(snap.runtime).toBe("claude-code");
		expect(snap.capabilities.steering).toBe(true);
		expect(snap.model).toEqual(gateway.model);

		// an empty session is listed, with its name
		let list = await host.call("session.list", {});
		expect(list.find((s) => s.id === snap.id)).toMatchObject({ name: "cc one", runtime: "claude-code", messageCount: 0 });

		llm.enqueue({ blocks: [{ type: "text", text: "first answer" }] });
		await host.call("chat.prompt", { sessionId: snap.id, text: "remember the number 42" });
		await settled(snap.id);
		list = await host.call("session.list", {});
		const entry = list.find((s) => s.id === snap.id)!;
		expect(entry.firstMessage).toContain("remember the number 42");
		expect(entry.messageCount).toBeGreaterThan(1);

		await host.call("session.close", { sessionId: snap.id });
		const reopened = await host.call("session.open", { sessionId: snap.id });
		expect(reopened.runtime).toBe("claude-code");
		const text = JSON.stringify(reopened.messages);
		expect(text).toContain("remember the number 42");
		expect(text).toContain("first answer");

		// the resumed session continues the same conversation
		events = [];
		llm.enqueue({ blocks: [{ type: "text", text: "second answer" }] });
		await host.call("chat.prompt", { sessionId: snap.id, text: "what number?" });
		await settled(snap.id);
		const last = llm.requests.at(-1)!;
		expect(JSON.stringify(last.body.messages)).toContain("remember the number 42");

		await host.call("session.delete", { sessionId: snap.id });
		list = await host.call("session.list", {});
		expect(list.find((s) => s.id === snap.id)).toBeUndefined();
	});

	it("real plugins: a saved memory reaches the next turn, and todo_write feeds the todo panel", async () => {
		const gateway = { mode: "prometheus" as const, gatewayId: "fake", model: { provider: "fake", id: "fake-model" } };
		const snap = await host.call("session.create", { cwd, runtime: "claude-code", gateway });
		await host.call("permission.set", { sessionId: snap.id, mode: "bypassPermissions" });
		events = [];
		llm.enqueue(
			{ blocks: [{ type: "tool_use", name: "mcp__prometheus__memory_save", input: { content: "the user prefers tabs over spaces" } }] },
			{ blocks: [{ type: "tool_use", name: "mcp__prometheus__todo_write", input: { todos: [{ content: "write it", status: "in_progress", activeForm: "Writing it" }] } }] },
			{ blocks: [{ type: "text", text: "saved" }] },
			{ blocks: [{ type: "text", text: "noted" }] },
		);
		await host.call("chat.prompt", { sessionId: snap.id, text: "remember my style" });
		await settled(snap.id);
		const names = events.map((e) => e.event).filter((e) => e.type === "tool_execution_end").map((e: any) => e.toolName);
		expect(names).toEqual(["memory_save", "todo_write"]);
		expect(events.filter((e) => e.event.type === "tool_execution_end" && (e.event as any).isError).map((e) => JSON.stringify(e.event)).join(" | ")).toBe("");

		events = [];
		await host.call("chat.prompt", { sessionId: snap.id, text: "tabs or spaces for formatting?" });
		await settled(snap.id);
		const last = llm.requests.at(-1)!;
		expect(JSON.stringify(last.body.messages)).toContain("prefers tabs over spaces");
		await host.call("session.delete", { sessionId: snap.id });
	});

	it("veil: secrets are replaced before they reach the model and restored in the reply", async () => {
		const gateway = { mode: "prometheus" as const, gatewayId: "fake", model: { provider: "fake", id: "fake-model" } };
		const snap = await host.call("session.create", { cwd, runtime: "claude-code", gateway });
		events = [];
		const secret = ["138", "0013", "8000"].join(""); // built at runtime so the literal is not itself a phone number
		// the model repeats whatever it was sent
		llm.enqueue({ blocks: (req) => [{ type: "text", text: `you said: ${req.lastUser}` }] });
		await host.call("chat.prompt", { sessionId: snap.id, text: `call me on ${secret}` });
		await settled(snap.id);
		const sent = llm.requests.find((r) => r.lastUser.includes("call me on"))!;
		expect(sent.lastUser).not.toContain(secret);
		const reply = JSON.stringify(events.map((e) => e.event).filter((e) => e.type === "message_end").at(-1));
		expect(reply).toContain(secret);
		await host.call("session.delete", { sessionId: snap.id });
	});
});
