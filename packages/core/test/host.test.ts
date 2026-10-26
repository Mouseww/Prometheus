// Characterization tests for PrometheusHost's RPC surface. They pin CURRENT behavior ahead of the
// AgentRuntime refactor (docs/agent-runtime.md §3); no model or network is involved.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@prometheus/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrometheusHost } from "../src/host.ts";

// PI's getAgentDir() reads this; it decides where sessions, auth.json, models.json and settings.json live.
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

let root: string;
let cwd: string;
let host: PrometheusHost;
let previousAgentDir: string | undefined;
const events: { sessionId: string; event: SessionEvent }[] = [];
let sessionsChanged = 0;

/** Writes a session file the way PI does once a conversation exists (an empty session is never written). */
function seedSession(text: string): { id: string; file: string } {
	const sm = SessionManager.create(cwd);
	sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	const file = sm.getSessionFile();
	if (!file) throw new Error("seeded session has no file");
	return { id: sm.getSessionId(), file };
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "prometheus-host-"));
	cwd = join(root, "work");
	await mkdir(cwd);
	previousAgentDir = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = join(root, "agent");
	host = await PrometheusHost.create({
		dataDir: join(root, "data"),
		cwd,
		listener: {
			event: (sessionId, event) => void events.push({ sessionId, event }),
			uiRequest: () => {},
			uiResolved: () => {},
			sessionsChanged: () => void sessionsChanged++,
			gatewaysChanged: () => {},
			pluginsChanged: () => {},
			pluginNotify: () => {},
		},
	});
}, 60_000);

afterAll(async () => {
	await host?.dispose();
	if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previousAgentDir;
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("PrometheusHost RPC (characterization)", () => {
	it("rejects unknown methods", async () => {
		await expect(host.call("no.such.method" as never, {} as never)).rejects.toMatchObject({ code: "notFound" });
	});

	it("session.create returns a full snapshot of a new, idle session", async () => {
		const before = sessionsChanged;
		const snap = await host.call("session.create", { cwd, name: "  First  " });
		expect(Object.keys(snap).sort()).toEqual(
			[
				"availableThinkingLevels",
				"cwd",
				"id",
				"isStreaming",
				"messages",
				"model",
				"name",
				"pendingUI",
				"permissionMode",
				"capabilities",
				"runtime",
				"queue",
				"statuses",
				"subagents",
				"thinkingLevel",
				"widgets",
				"workspaceId",
			].sort(),
		);
		expect(typeof snap.id).toBe("string");
		expect(snap.id.length).toBeGreaterThan(0);
		expect(snap.name).toBe("First");
		expect(typeof snap.workspaceId).toBe("string");
		expect(snap.messages).toEqual([]);
		expect(snap.isStreaming).toBe(false);
		expect(snap.permissionMode).toBe("default");
		expect(snap.queue).toEqual({ steering: [], followUp: [] });
		expect(snap.pendingUI).toEqual([]);
		expect(snap.subagents).toEqual([]);
		expect(Array.isArray(snap.availableThinkingLevels)).toBe(true);
		expect(sessionsChanged).toBeGreaterThan(before);
	});

	it("session.create rejects a missing working directory", async () => {
		await expect(host.call("session.create", { cwd: join(root, "missing") })).rejects.toMatchObject({ code: "workdirNotFound" });
	});

	it("session.list omits a fresh empty session (PI writes no file until a message exists)", async () => {
		const snap = await host.call("session.create", { cwd });
		const list = await host.call("session.list", {});
		expect(list.some((s) => s.id === snap.id)).toBe(false);
	});

	it("session.list includes a session that has a file on disk", async () => {
		const seeded = seedSession("hello from disk");
		const list = await host.call("session.list", {});
		const hit = list.find((s) => s.id === seeded.id);
		expect(hit).toMatchObject({ id: seeded.id, messageCount: 1, firstMessage: "hello from disk", live: false, running: false, archived: false });
	});

	it("session.open returns the same session, live or from disk", async () => {
		const created = await host.call("session.create", { cwd, name: "reopen" });
		const again = await host.call("session.open", { sessionId: created.id });
		expect(again.id).toBe(created.id);
		expect(again.name).toBe("reopen");

		const seeded = seedSession("open me");
		const opened = await host.call("session.open", { sessionId: seeded.id });
		expect(opened.id).toBe(seeded.id);
		expect(opened.messages).toHaveLength(1);
		expect((await host.call("session.open", { sessionId: seeded.id })).id).toBe(seeded.id);
		expect((await host.call("session.list", {})).find((s) => s.id === seeded.id)?.live).toBe(true);
	});

	it("session.open of an unknown id fails with sessionNotFound", async () => {
		await expect(host.call("session.open", { sessionId: "does-not-exist" })).rejects.toMatchObject({ code: "sessionNotFound" });
	});

	it("session.rename trims the name; it shows in snapshots and, for saved sessions, in the list", async () => {
		const created = await host.call("session.create", { cwd });
		expect(await host.call("session.rename", { sessionId: created.id, name: "  Renamed  " })).toBeNull();
		expect((await host.call("session.open", { sessionId: created.id })).name).toBe("Renamed");

		const seeded = seedSession("rename me");
		await host.call("session.rename", { sessionId: seeded.id, name: "Saved name" });
		expect((await host.call("session.list", {})).find((s) => s.id === seeded.id)?.name).toBe("Saved name");
	});

	it("tools.list is non-empty and hides exit_plan_mode", async () => {
		const { id } = await host.call("session.create", { cwd });
		const tools = await host.call("tools.list", { sessionId: id });
		expect(tools.length).toBeGreaterThan(0);
		for (const t of tools) {
			expect(typeof t.name).toBe("string");
			expect(typeof t.description).toBe("string");
			expect(typeof t.active).toBe("boolean");
		}
		expect(tools.map((t) => t.name)).not.toContain("exit_plan_mode");
	});

	it("session-scoped calls require the session to be open", async () => {
		await expect(host.call("tools.list", { sessionId: "not-open" })).rejects.toMatchObject({ code: "sessionNotOpen" });
	});

	it("commands.list returns an array of commands", async () => {
		const { id } = await host.call("session.create", { cwd });
		const commands = await host.call("commands.list", { sessionId: id });
		expect(Array.isArray(commands)).toBe(true);
		for (const c of commands) expect(["extension", "prompt", "skill"]).toContain(c.source);
	});

	it("permission.set emits permission_mode_changed and toggles exit_plan_mode in the context", async () => {
		const { id } = await host.call("session.create", { cwd });
		const toolTokens = async () => (await host.call("session.stats", { sessionId: id })).breakdown.tools;
		const base = await toolTokens();

		expect(await host.call("permission.set", { sessionId: id, mode: "plan" })).toBeNull();
		expect(events).toContainEqual({ sessionId: id, event: { type: "permission_mode_changed", mode: "plan" } });
		expect((await host.call("session.open", { sessionId: id })).permissionMode).toBe("plan");
		// exit_plan_mode is hidden from tools.list, but becoming active adds its definition to the context.
		expect(await toolTokens()).toBeGreaterThan(base);
		expect((await host.call("tools.list", { sessionId: id })).map((t) => t.name)).not.toContain("exit_plan_mode");

		await host.call("permission.set", { sessionId: id, mode: "default" });
		expect(events).toContainEqual({ sessionId: id, event: { type: "permission_mode_changed", mode: "default" } });
		expect(await toolTokens()).toBe(base);

		await expect(host.call("permission.set", { sessionId: id, mode: "bogus" as never })).rejects.toMatchObject({ code: "unknownPermissionMode" });
	});

	it("session.stats reports an estimated context for an empty session", async () => {
		const { id } = await host.call("session.create", { cwd });
		const stats = await host.call("session.stats", { sessionId: id });
		expect(stats.contextEstimated).toBe(true);
		expect(stats.breakdown.user).toBe(0);
		expect(stats.breakdown.assistant).toBe(0);
		expect(stats.breakdown.system).toBeGreaterThan(0);
		expect(stats.totalCost).toBe(0);
		expect(stats.inputTokens).toBe(0);
		expect(stats.outputTokens).toBe(0);
	});

	it("settings.get returns the host settings object", async () => {
		const settings = await host.call("settings.get", {});
		expect(typeof settings.autoCompaction).toBe("boolean");
		expect(settings.workspaceRoot).toBe("");
	});

	it("session.delete removes a saved session and its file", async () => {
		const seeded = seedSession("delete me");
		await host.call("session.open", { sessionId: seeded.id });
		expect((await host.call("session.list", {})).some((s) => s.id === seeded.id)).toBe(true);
		expect(await host.call("session.delete", { sessionId: seeded.id })).toBeNull();
		expect(existsSync(seeded.file)).toBe(false);
		expect((await host.call("session.list", {})).some((s) => s.id === seeded.id)).toBe(false);
		await expect(host.call("tools.list", { sessionId: seeded.id })).rejects.toMatchObject({ code: "sessionNotOpen" });
	});

	it("message.fork resumes the new session from its fork, names it \"(fork)\" and returns the editor text", async () => {
		const sm = SessionManager.create(cwd);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "question" }], timestamp: 1000 });
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer" }], api: "anthropic-messages", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 2000 });
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "follow up" }], timestamp: 3000 });
		const id = sm.getSessionId();
		await host.call("session.open", { sessionId: id });
		await host.call("session.rename", { sessionId: id, name: "Base" });

		const atReply = await host.call("message.fork", { sessionId: id, ref: { index: 1, role: "assistant", timestamp: 2000 } });
		expect(atReply.snapshot.id).not.toBe(id);
		expect(atReply.snapshot.name).toBe("Base (fork)");
		expect(atReply.snapshot.messages).toHaveLength(2);
		expect(atReply.editorText).toBeUndefined();

		const atUser = await host.call("message.fork", { sessionId: id, ref: { index: 2, role: "user", timestamp: 3000 } });
		expect(atUser.editorText).toBe("follow up");
		expect(atUser.snapshot.messages).toHaveLength(2);
		expect(atUser.snapshot.id).not.toBe(atReply.snapshot.id);
	});

	it("session.delete of a never-saved session closes it; it cannot be reopened", async () => {
		const { id } = await host.call("session.create", { cwd });
		expect(await host.call("session.delete", { sessionId: id })).toBeNull();
		await expect(host.call("tools.list", { sessionId: id })).rejects.toMatchObject({ code: "sessionNotOpen" });
		await expect(host.call("session.open", { sessionId: id })).rejects.toMatchObject({ code: "sessionNotFound" });
	});
});
