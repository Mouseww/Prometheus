import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { definePlugin, type PluginContext } from "@prometheus/plugin-sdk";
import type { UIRequest } from "@prometheus/protocol";
import { describe, expect, it } from "vitest";
import { BadgeStore } from "../src/agent/session-badges.ts";
import { retargetTranscript } from "../src/agent/pi/transcript.ts";
import { PrometheusHost } from "../src/host.ts";
import { PluginHost } from "../src/plugin-host.ts";

const request = { id: "r1", method: "confirm", title: "t", message: "m" } as UIRequest;

describe("plugin ui request events", () => {
	it("fans out requests and resolutions, swallows listener errors and unsubscribes on disable", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "plugui-"));
		const disabled = new Set<string>();
		const host = new PluginHost({ host: "server", dataDir, agentDir: join(dataDir, "agent"), cwd: dataDir, settings: () => ({}), gateways: () => [], isDisabled: (id) => disabled.has(id), setDisabled: async (id, d) => void (d ? disabled.add(id) : disabled.delete(id)) });
		const seen: string[] = [];
		await host.load(definePlugin({ name: "bad", setup: (ctx) => void ctx.events.onUiRequest(() => { throw new Error("boom"); }) }), "builtin");
		await host.load(
			definePlugin({
				name: "opt",
				optional: true,
				setup: (ctx) => {
					ctx.events.onUiRequest((id, r) => void seen.push(`req:${id}:${r.id}`));
					ctx.events.onUiResolved((id, rid) => void seen.push(`res:${id}:${rid}`));
				},
			}),
			"builtin",
		);
		expect(host.hasUiListeners).toBe(true);
		host.emitUiRequest("s1", request);
		host.emitUiResolved("s1", "r1");
		expect(seen).toEqual(["req:s1:r1", "res:s1:r1"]);
		await host.setEnabled("builtin:opt", false);
		host.emitUiRequest("s1", request);
		expect(seen).toHaveLength(2);
	});

	it("unsubscribe functions work", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "plugui-"));
		const host = new PluginHost({ host: "server", dataDir, agentDir: join(dataDir, "agent"), cwd: dataDir, settings: () => ({}), gateways: () => [] });
		let n = 0;
		let off: () => void = () => {};
		await host.load(definePlugin({ name: "a", setup: (ctx) => void (off = ctx.events.onUiRequest(() => void n++)) }), "builtin");
		host.emitUiRequest("s", request);
		off();
		host.emitUiRequest("s", request);
		expect(n).toBe(1);
	});
});

describe("wsRoute registration", () => {
	it("prefixes the plugin path and records the auth mode", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "plugws-"));
		const host = new PluginHost({ host: "server", dataDir, agentDir: join(dataDir, "agent"), cwd: dataDir, settings: () => ({}), gateways: () => [] });
		await host.load(
			definePlugin({
				name: "team",
				setup: (ctx) => {
					ctx.wsRoute("/ws", () => {}, { auth: "public" });
					ctx.wsRoute("/room/*", () => {});
					expect(() => ctx.wsRoute("bad", () => {})).toThrow();
				},
			}),
			"builtin",
		);
		expect(host.wsRoutes.map((r) => [r.path, r.auth])).toEqual([
			["/plugins/team/ws", "public"],
			["/plugins/team/room/*", "host"],
		]);
	});
});

describe("badge store and transcript helpers", () => {
	it("persists badges, clears them and ignores no-op writes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "badge-"));
		const file = join(dir, "badges.json");
		const store = new BadgeStore(file);
		expect(store.set("a", { text: "待审批", tone: "warn" })).toBe(true);
		expect(store.set("a", { text: "待审批", tone: "warn" })).toBe(false);
		await store.flush();
		const again = new BadgeStore(file);
		await again.load();
		expect(again.get("a")).toEqual({ text: "待审批", tone: "warn" });
		expect(again.set("a", undefined)).toBe(true);
		expect(again.set("a", undefined)).toBe(false);
		await again.flush();
		expect(JSON.parse(await readFile(file, "utf8")).badges).toEqual({});
	});

	it("retargets the header only and rejects non-session text", () => {
		const text = [JSON.stringify({ type: "session", version: 3, id: "old", timestamp: "t", cwd: "/old", parentSession: "p" }), JSON.stringify({ type: "message", id: "m1", parentId: null })].join("\n");
		const lines = retargetTranscript(text, "new", "/new").trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual({ type: "session", version: 3, id: "new", timestamp: "t", cwd: "/new" });
		expect(lines[1]).toBe(JSON.stringify({ type: "message", id: "m1", parentId: null }));
		expect(() => retargetTranscript("not json", "n", "/n")).toThrow();
		expect(() => retargetTranscript(JSON.stringify({ type: "message" }), "n", "/n")).toThrow();
		expect(() => retargetTranscript("", "n", "/n")).toThrow();
	});
});

describe("plugin session control through the host", () => {
	it("imports and exports a transcript, owns it, badges it, and refuses prompts on a hub", async () => {
		const root = await mkdtemp(join(tmpdir(), "prometheus-ops-"));
		const cwd = join(root, "work");
		const other = join(root, "other");
		await mkdir(cwd);
		await mkdir(other);
		const previous = process.env.PI_CODING_AGENT_DIR;
		const previousRole = process.env.PROMETHEUS_ROLE;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		let ctxRef: PluginContext | undefined;
		let changed = 0;
		const make = () =>
			PrometheusHost.create({
				dataDir: join(root, "data"),
				cwd,
				builtinPlugins: [
					definePlugin({
						name: "spy",
						setup: (ctx) => {
							ctxRef = ctx;
							ctx.events.onSessionsChanged(() => void changed++);
						},
					}),
				],
				listener: { event: () => {}, uiRequest: () => {}, uiResolved: () => {}, sessionsChanged: () => {}, gatewaysChanged: () => {}, pluginsChanged: () => {}, pluginNotify: () => {} },
			});
		let host = await make();
		try {
			const sm = SessionManager.create(cwd);
			sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello team" }], timestamp: Date.now() });
			const sourceId = sm.getSessionId();
			const exported = await ctxRef?.sessions.exportTranscript(sourceId);
			expect(exported?.format).toBe("pi-jsonl");
			expect(exported?.content).toContain("hello team");
			expect(await ctxRef?.sessions.exportTranscript("nope")).toBeUndefined();

			const before = changed;
			const imported = await ctxRef?.sessions.importTranscript({ cwd: other, content: exported?.content ?? "", name: "from hub", owner: "ann", runtime: "pi" });
			expect(imported?.sessionId).toBeTruthy();
			expect(imported?.sessionId).not.toBe(sourceId);
			expect(changed).toBeGreaterThan(before);
			const info = await ctxRef?.sessions.info(imported?.sessionId ?? "");
			expect(info).toMatchObject({ cwd: expect.stringContaining("other"), owner: "ann", name: "from hub" });
			expect(info?.firstMessage).toContain("hello team");
			expect(host.sessionOwner(imported?.sessionId ?? "")).toBe("ann");
			const labelled = await ctxRef?.sessions.importTranscript({ cwd: other, content: exported?.content ?? "", name: "标题", workspaceName: "团队/工作区: 标题" });
			expect(labelled?.sessionId).toBeTruthy();
			expect(((await ctxRef?.workspaces()) ?? []).some((w) => w.name === "团队/工作区: 标题")).toBe(true);
			await expect(ctxRef?.sessions.importTranscript({ cwd: other, content: "garbage" }) as Promise<unknown>).rejects.toThrow();
			await expect(ctxRef?.sessions.importTranscript({ cwd: join(root, "missing"), content: exported?.content ?? "" }) as Promise<unknown>).rejects.toThrow();

			const id = imported?.sessionId ?? "";
			await ctxRef?.sessions.setBadge(id, { text: "团队：待审批", tone: "warn" });
			expect((await ctxRef?.sessions.info(id))?.badge).toEqual({ text: "团队：待审批", tone: "warn" });
			await expect(ctxRef?.sessions.setBadge("nope", { text: "x", tone: "info" }) as Promise<unknown>).rejects.toThrow();
			await host.dispose();
			expect(existsSync(join(root, "data", "sessions", "badges.json"))).toBe(true);
			host = await make();
			expect((await ctxRef?.sessions.info(id))?.badge?.text).toBe("团队：待审批");
			await ctxRef?.sessions.setBadge(id, undefined);
			expect((await ctxRef?.sessions.info(id))?.badge).toBeUndefined();

			await expect(ctxRef?.sessions.prompt(id, "  ") as Promise<unknown>).rejects.toThrow();
			process.env.PROMETHEUS_ROLE = "hub";
			await expect(ctxRef?.sessions.prompt(id, "hi", { actor: "bob" }) as Promise<unknown>).rejects.toThrow();
			await expect(ctxRef?.sessions.respond(id, "r", { cancelled: true }) as Promise<unknown>).rejects.toThrow();
		} finally {
			if (previousRole === undefined) delete process.env.PROMETHEUS_ROLE;
			else process.env.PROMETHEUS_ROLE = previousRole;
			await host.dispose();
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}, 60_000);
});
