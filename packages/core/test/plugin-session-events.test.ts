import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { definePlugin, type PluginContext } from "@prometheus/plugin-sdk";
import type { SessionEvent, SessionSummary } from "@prometheus/protocol";
import { describe, expect, it } from "vitest";
import { PrometheusHost } from "../src/host.ts";
import { PluginHost } from "../src/plugin-host.ts";

async function makeHost() {
	const dataDir = await mkdtemp(join(tmpdir(), "plugsess-"));
	return new PluginHost({ host: "server", dataDir, agentDir: join(dataDir, "agent"), cwd: dataDir, settings: () => ({}), gateways: () => [] });
}

const event: SessionEvent = { type: "agent_start" } as SessionEvent;

describe("plugin session events", () => {
	it("delivers events to every listener, even when one throws", async () => {
		const host = await makeHost();
		const seen: string[] = [];
		await host.load(definePlugin({ name: "a", setup: (ctx) => ctx.events.onSession(() => { throw new Error("boom"); }) && undefined }), "builtin");
		await host.load(definePlugin({ name: "b", setup: (ctx) => void ctx.events.onSession((id, e, info) => void seen.push(`${id}:${e.type}:${info.owner ?? "-"}:${info.cwd}`)) }), "builtin");
		await host.load(definePlugin({ name: "c", setup: (ctx) => void ctx.events.onSession(async () => { throw new Error("async boom"); }) }), "builtin");
		expect(host.hasSessionListeners).toBe(true);
		host.emitSession("s1", event, { owner: "u1", cwd: "/w" });
		host.emitSession("s2", event, { cwd: "/x" });
		expect(seen).toEqual(["s1:agent_start:u1:/w", "s2:agent_start:-:/x"]);
	});

	it("tells listeners the session list changed, and survives a throwing one", async () => {
		const host = await makeHost();
		let n = 0;
		await host.load(definePlugin({ name: "a", setup: (ctx) => void ctx.events.onSessionsChanged(() => { throw new Error("boom"); }) }), "builtin");
		await host.load(definePlugin({ name: "b", setup: (ctx) => void ctx.events.onSessionsChanged(() => void n++) }), "builtin");
		host.emitSessionsChanged();
		expect(n).toBe(1);
	});

	it("stops delivering after the plugin is disabled or unloaded", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "plugsess-"));
		const disabled = new Set<string>();
		const host = new PluginHost({ host: "server", dataDir, agentDir: join(dataDir, "agent"), cwd: dataDir, settings: () => ({}), gateways: () => [], isDisabled: (id) => disabled.has(id), setDisabled: async (id, d) => void (d ? disabled.add(id) : disabled.delete(id)) });
		let n = 0;
		await host.load(definePlugin({ name: "opt", optional: true, setup: (ctx) => void ctx.events.onSession(() => void n++) }), "builtin");
		host.emitSession("s", event, { cwd: "" });
		expect(n).toBe(1);
		await host.setEnabled("builtin:opt", false);
		expect(host.hasSessionListeners).toBe(false);
		host.emitSession("s", event, { cwd: "" });
		expect(n).toBe(1);
		await host.setEnabled("builtin:opt", true);
		host.emitSession("s", event, { cwd: "" });
		expect(n).toBe(2);
	});

	it("the unsubscribe function works", async () => {
		const host = await makeHost();
		let off: () => void = () => {};
		let n = 0;
		await host.load(definePlugin({ name: "a", setup: (ctx) => void (off = ctx.events.onSession(() => void n++)) }), "builtin");
		host.emitSession("s", event, { cwd: "" });
		off();
		host.emitSession("s", event, { cwd: "" });
		expect(n).toBe(1);
	});
});

describe("plugin session events through the host", () => {
	it("a plugin sees real events, the owner, and session info; a throwing plugin changes nothing for clients", async () => {
		const root = await mkdtemp(join(tmpdir(), "prometheus-ps-"));
		const cwd = join(root, "work");
		await mkdir(cwd);
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		const received: { id: string; type: string; owner?: string; cwd: string }[] = [];
		let changed = 0;
		let ctxRef: PluginContext | undefined;
		const clientEvents: string[] = [];
		const host = await PrometheusHost.create({
			dataDir: join(root, "data"),
			cwd,
			builtinPlugins: [
				definePlugin({
					name: "spy",
					setup: (ctx) => {
						ctxRef = ctx;
						ctx.events.onSession((id, e, info) => void received.push({ id, type: e.type, ...info }));
						ctx.events.onSessionsChanged(() => void changed++);
					},
				}),
				definePlugin({ name: "bad", setup: (ctx) => void ctx.events.onSession(() => { throw new Error("boom"); }) }),
			],
			listener: { event: (_id, e) => void clientEvents.push(e.type), uiRequest: () => {}, uiResolved: () => {}, sessionsChanged: () => {}, gatewaysChanged: () => {}, pluginsChanged: () => {}, pluginNotify: () => {} },
		});
		try {
			const snap = await host.call("session.create", { cwd }, { identity: { userId: "ann" } });
			expect(changed).toBeGreaterThan(0);
			await host.call("permission.set", { sessionId: snap.id, mode: "acceptEdits" });
			const mine = received.filter((r) => r.id === snap.id);
			expect(mine.some((r) => r.type === "permission_mode_changed")).toBe(true);
			expect(mine.every((r) => r.owner === "ann" || r.owner === undefined)).toBe(true);
			expect(mine.find((r) => r.type === "permission_mode_changed")).toMatchObject({ owner: "ann", cwd: expect.any(String) });
			expect(clientEvents).toContain("permission_mode_changed");
			const sm = SessionManager.create(cwd);
			sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
			const info: SessionSummary | undefined = await ctxRef?.sessions.info(sm.getSessionId());
			expect(info?.id).toBe(sm.getSessionId());
			expect(await ctxRef?.sessions.info("nope")).toBeUndefined();
		} finally {
			await host.dispose();
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}, 60_000);
});
