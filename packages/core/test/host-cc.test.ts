// A Claude Code session driven through the host's RPC surface: create, chat, list, close, reopen (resume), delete.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@prometheus/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrometheusHost } from "../src/host.ts";
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
		expect(list.map((r) => r.kind)).toEqual(["pi", "claude-code"]);
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
});
