import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@prometheus/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrometheusHost } from "../src/host.ts";
import { identityMayCall, IDENTITY_READ_ONLY_METHODS, SESSION_WRITE_METHODS } from "../src/session-access.ts";
import { rpcMethodNames } from "./support/rpc-methods.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const owner: Caller = { identity: { userId: "owner" } };
const delegate: Caller = { identity: { userId: "hub", actsFor: ["owner"] } };
const stranger: Caller = { identity: { userId: "mallory" } };

describe("identityMayCall", () => {
	it("gives the server owner every method and a delegate only reads and session writes", () => {
		for (const method of rpcMethodNames()) {
			expect(identityMayCall({ userId: "owner" }, "owner", method), method).toBe(true);
			const delegateMay = IDENTITY_READ_ONLY_METHODS.has(method) || SESSION_WRITE_METHODS.has(method);
			expect(identityMayCall({ userId: "hub", actsFor: ["owner"] }, "owner", method), method).toBe(delegateMay);
		}
	});

	it("denies the dangerous methods to a delegate by name", () => {
		for (const m of ["plugin.call", "plugin.install", "plugin.setEnabled", "plugin.remove", "settings.set", "gateway.save", "gateway.delete", "gateway.list", "workspace.add", "workspace.remove", "system.openIn", "system.open", "agent.install", "agent.save", "agent.syncSessions", "session.create", "message.fork", "fs.dirs", "fs.pick", "fs.mkdir", "kb.ingest", "network.set", "runtime.env"]) {
			expect(identityMayCall({ userId: "hub", actsFor: ["owner"] }, "owner", m), m).toBe(false);
		}
	});

	it("is the old behaviour when the policy names no owner", () => {
		for (const method of rpcMethodNames()) expect(identityMayCall({ userId: "anyone" }, undefined, method), method).toBe(true);
	});

	it("keeps the read-only list to methods that exist and are not writes", () => {
		const all = new Set(rpcMethodNames());
		for (const m of IDENTITY_READ_ONLY_METHODS) {
			expect(all.has(m), `${m} is not an RPC method`).toBe(true);
			expect(SESSION_WRITE_METHODS.has(m), `${m} is also a session write`).toBe(false);
		}
	});
});

describe("identities against a server with a serverOwner", () => {
	let root: string;
	let cwd: string;
	let host: PrometheusHost;
	let previous: string | undefined;
	const sessionsChanged: string[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "prometheus-identity-"));
		cwd = join(root, "work");
		await mkdir(cwd);
		await mkdir(join(root, "data"));
		await writeFile(join(root, "data", "policy.json"), JSON.stringify({ serverOwner: "owner", forbiddenModes: ["bypassPermissions"] }));
		previous = process.env[AGENT_DIR_ENV];
		process.env[AGENT_DIR_ENV] = join(root, "agent");
		host = await PrometheusHost.create({
			dataDir: join(root, "data"),
			cwd,
			listener: { event: () => {}, uiRequest: () => {}, uiResolved: () => {}, sessionsChanged: () => void sessionsChanged.push("x"), gatewaysChanged: () => {}, pluginsChanged: () => {}, pluginNotify: () => {} },
		});
	}, 60_000);

	afterAll(async () => {
		await host?.dispose();
		if (previous === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previous;
		if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("refuses a delegate every method outside the read-only list and the session writes", async () => {
		await expect(host.call("plugin.call", { plugin: "x", method: "y" } as never, delegate)).rejects.toMatchObject({ code: "identityForbidden" });
		await expect(host.call("settings.set", {} as never, delegate)).rejects.toMatchObject({ code: "identityForbidden" });
		await expect(host.call("gateway.save", {} as never, delegate)).rejects.toMatchObject({ code: "identityForbidden" });
		await expect(host.call("workspace.add", { path: cwd }, delegate)).rejects.toMatchObject({ code: "identityForbidden" });
		await expect(host.call("system.openIn", {} as never, delegate)).rejects.toMatchObject({ code: "identityForbidden" });
		await expect(host.call("agent.install", {} as never, delegate)).rejects.toMatchObject({ code: "identityForbidden" });
		await expect(host.call("session.create", { cwd }, delegate)).rejects.toMatchObject({ code: "identityForbidden" });
		await expect(host.call("session.list", {}, delegate)).resolves.toBeDefined();
		await expect(host.call("workspace.list", {}, delegate)).resolves.toBeDefined();
	});

	it("refuses an unrelated identity the same way", async () => {
		await expect(host.call("settings.set", {} as never, stranger)).rejects.toMatchObject({ code: "identityForbidden" });
	});

	it("lets the owner identity and the machine's own user through", async () => {
		const snap = await host.call("session.create", { cwd }, owner);
		expect(snap.owner).toBe("owner");
		await expect(host.call("session.rename", { sessionId: snap.id, name: "a" }, delegate)).resolves.toBeNull();
		await expect(host.call("session.rename", { sessionId: snap.id, name: "b" })).resolves.toBeNull();
		await host.call("session.delete", { sessionId: snap.id });
	});

	it("needs a string sessionId for identity callers on a write method", async () => {
		for (const method of SESSION_WRITE_METHODS) {
			for (const params of [{}, { sessionId: 5 }, { sessionId: null }, undefined, { sessionId: { x: 1 } }]) {
				await expect(host.call(method as never, params as never, owner), `${method} ${JSON.stringify(params)}`).rejects.toMatchObject({ code: "invalidParams" });
			}
		}
	});

	it("gives sessions created with no caller identity to the serverOwner", async () => {
		const snap = await host.call("session.create", { cwd });
		expect(snap.owner).toBe("owner");
		expect(host.sessionOwner(snap.id)).toBe("owner");
		await expect(host.call("chat.abort", { sessionId: snap.id }, stranger)).rejects.toMatchObject({ code: "sessionForbidden" });
		await host.call("session.delete", { sessionId: snap.id });
	});

	it("clamps the mode through the policy when switching runtime", async () => {
		const snap = await host.call("session.create", { cwd });
		// A session restored before the policy banned the mode keeps it until something asks to change it.
		const live = (host as unknown as { live: Map<string, { gate: { mode: string } }> }).live.get(snap.id);
		if (!live) throw new Error("session is not live");
		live.gate.mode = "bypassPermissions";
		const next = await host.call("session.switchRuntime", { sessionId: snap.id, runtime: "pi" });
		const nextLive = (host as unknown as { live: Map<string, { gate: { mode: string } }> }).live.get(next.id);
		expect(nextLive?.gate.mode).toBe("default");
		await host.call("session.delete", { sessionId: next.id });
	});
});
