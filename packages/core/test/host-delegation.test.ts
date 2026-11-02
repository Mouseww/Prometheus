// Plugin-facing session APIs of the host: openSession, sessionAccess and the access cap on delegated runs.
// No model is configured, so a run ends in "error"; the point here is what access it was given.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrometheusHost } from "../src/host.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
let root: string;
let cwd: string;
let host: PrometheusHost;
let previousAgentDir: string | undefined;
type Plugins = {
	openSession(o: { cwd: string; name?: string }): Promise<{ sessionId: string }>;
	sessionAccess(id: string): string;
	sessionExists(id: string): Promise<boolean>;
	runAgent(o: Record<string, unknown>): Promise<{ sessionId: string; status: string; access: string }>;
};
const plugins = () => (host as unknown as { runtime: { plugins: Plugins } }).runtime.plugins;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "prometheus-deleg-"));
	cwd = join(root, "work");
	await mkdir(cwd);
	previousAgentDir = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = join(root, "agent");
	host = await PrometheusHost.create({
		dataDir: join(root, "data"),
		cwd,
		listener: { event: () => {}, uiRequest: () => {}, uiResolved: () => {}, sessionsChanged: () => {}, gatewaysChanged: () => {}, pluginsChanged: () => {}, pluginNotify: () => {} },
	});
}, 60_000);

afterAll(async () => {
	await host?.dispose();
	if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previousAgentDir;
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("openSession", () => {
	it("creates a live, named chat in the given folder and registers the folder", async () => {
		const { sessionId } = await plugins().openSession({ cwd, name: "  Personal  " });
		const snap = await host.call("session.open", { sessionId });
		expect(snap.name).toBe("Personal");
		expect(snap.isStreaming).toBe(false);
		expect((await host.call("workspace.list", {})).some((w) => w.path.toLowerCase() === cwd.toLowerCase())).toBe(true);
	});

	it("refuses a folder that does not exist", async () => {
		await expect(plugins().openSession({ cwd: join(root, "nope") })).rejects.toMatchObject({ code: "workdirNotFound" });
	});
});

describe("sessionExists", () => {
	it("knows chats that were opened and rejects ids it has never seen", async () => {
		const { sessionId } = await plugins().openSession({ cwd });
		expect(await plugins().sessionExists(sessionId)).toBe(true);
		expect(await plugins().sessionExists("nope")).toBe(false);
	});
});

describe("sessionAccess and the delegation cap", () => {
	it("follows the permission mode of the parent chat; unknown parents can only read", async () => {
		const { sessionId } = await plugins().openSession({ cwd });
		expect(plugins().sessionAccess(sessionId)).toBe("readonly");
		await host.call("permission.set", { sessionId, mode: "acceptEdits" });
		expect(plugins().sessionAccess(sessionId)).toBe("edits");
		await host.call("permission.set", { sessionId, mode: "bypassPermissions" });
		expect(plugins().sessionAccess(sessionId)).toBe("full");
		expect(plugins().sessionAccess("does-not-exist")).toBe("readonly");
	});

	it("a delegated run never gets more than its parent may do", async () => {
		const { sessionId } = await plugins().openSession({ cwd });
		const low = await plugins().runAgent({ cwd, prompt: "x", access: "full", parentSessionId: sessionId, timeoutMs: 2000 });
		expect(low.access).toBe("readonly");
		await host.call("permission.set", { sessionId, mode: "acceptEdits" });
		const mid = await plugins().runAgent({ cwd, prompt: "x", access: "full", parentSessionId: sessionId, timeoutMs: 2000 });
		expect(mid.access).toBe("edits");
		const orphan = await plugins().runAgent({ cwd, prompt: "x", access: "edits", parentSessionId: "ghost", timeoutMs: 2000 });
		expect(orphan.access).toBe("readonly");
		const plain = await plugins().runAgent({ cwd, prompt: "x", access: "edits", timeoutMs: 2000 });
		expect(plain.access).toBe("edits");
	}, 30_000);

	it("a run that continues an existing chat leaves that chat attended afterwards", async () => {
		const { sessionId } = await plugins().openSession({ cwd });
		const r = await plugins().runAgent({ cwd, prompt: "x", access: "readonly", sessionId, timeoutMs: 2000 });
		expect(r.sessionId).toBe(sessionId);
		// still open, and its own ceiling is back to its mode (default -> readonly) rather than a leftover unattended value
		expect(plugins().sessionAccess(sessionId)).toBe("readonly");
		await host.call("permission.set", { sessionId, mode: "acceptEdits" });
		expect(plugins().sessionAccess(sessionId)).toBe("edits");
	}, 30_000);
});
