// A Codex session driven through the host's RPC surface: create, chat, close, reopen (resume), delete.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@prometheus/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrometheusHost } from "../src/host.ts";
import { FakeResponsesLlm } from "./support/fake-llm.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const llm = new FakeResponsesLlm();
let root: string;
let cwd: string;
let host: PrometheusHost;
let previous: string | undefined;
let events: { sessionId: string; event: SessionEvent }[] = [];
let available = false;

async function settled(id: string, timeoutMs = 90_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (events.some((e) => e.sessionId === id && e.event.type === "agent_settled")) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("did not settle");
}

beforeAll(async () => {
	await llm.start();
	root = await mkdtemp(join(tmpdir(), "prometheus-hostcodex-"));
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
		gateway: { id: "fake", name: "fake", format: "openai-responses", baseUrl: `${llm.baseUrl}/v1`, auth: { type: "bearer" }, apiKey: "k", models: [{ id: "fake-model", name: "fake" }] },
	});
	available = (await host.call("runtime.list", {})).find((r) => r.kind === "codex")?.health.available === true;
}, 90_000);

afterAll(async () => {
	await host?.dispose();
	await llm.stop();
	if (previous === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previous;
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("Codex through the host", { timeout: 180_000 }, () => {
	it("creates, chats, closes, resumes and deletes", async (ctx) => {
		if (!available) ctx.skip();
		const gateway = { mode: "prometheus" as const, gatewayId: "fake", model: { provider: "fake", id: "fake-model" } };
		const snap = await host.call("session.create", { cwd, name: "codex one", runtime: "codex", gateway });
		expect(snap.runtime).toBe("codex");
		await host.call("permission.set", { sessionId: snap.id, mode: "bypassPermissions" });

		llm.enqueue({ blocks: [{ type: "text", text: "first answer" }] });
		await host.call("chat.prompt", { sessionId: snap.id, text: "remember the number 42" });
		await settled(snap.id);
		let list = await host.call("session.list", {});
		expect(list.find((s) => s.id === snap.id)).toMatchObject({ name: "codex one", runtime: "codex" });

		await host.call("session.close", { sessionId: snap.id });
		const reopened = await host.call("session.open", { sessionId: snap.id });
		const text = JSON.stringify(reopened.messages);
		expect(text).toContain("remember the number 42");
		expect(text).toContain("first answer");

		events = [];
		llm.enqueue({ blocks: [{ type: "text", text: "second answer" }] });
		await host.call("chat.prompt", { sessionId: snap.id, text: "what number?" });
		await settled(snap.id);
		expect(llm.requests.at(-1)!.inputText).toContain("remember the number 42");

		await host.call("session.delete", { sessionId: snap.id });
		list = await host.call("session.list", {});
		expect(list.find((s) => s.id === snap.id)).toBeUndefined();
	});
});
