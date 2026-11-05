import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Caller } from "@prometheus/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OwnerStore } from "../src/agent/session-owners.ts";
import { PrometheusHost } from "../src/host.ts";
import { canAct, SESSION_WRITE_METHODS } from "../src/session-access.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

describe("canAct", () => {
	it("follows the truth table", () => {
		expect(canAct(undefined, undefined)).toBe(true);
		expect(canAct({ userId: "a" }, undefined)).toBe(true);
		expect(canAct(undefined, "o")).toBe(true);
		expect(canAct({ userId: "o" }, "o")).toBe(true);
		expect(canAct({ userId: "h", actsFor: ["o"] }, "o")).toBe(true);
		expect(canAct({ userId: "x" }, "o")).toBe(false);
		expect(canAct({ userId: "x", actsFor: ["y"] }, "o")).toBe(false);
	});
});

describe("OwnerStore", () => {
	it("persists owners and forgets deleted ones", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owners-"));
		const file = join(dir, "sessions", "owners.json");
		const a = new OwnerStore(file);
		a.set("s1", "u1");
		a.set("s2", "u2");
		a.delete("s2");
		await a.flush();
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, owners: { s1: "u1" } });
		const b = new OwnerStore(file);
		await b.load();
		expect(b.get("s1")).toBe("u1");
		expect(b.get("s2")).toBeUndefined();
		await rm(dir, { recursive: true, force: true });
	});
	it("starts empty on a corrupt file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "owners-"));
		const file = join(dir, "owners.json");
		await mkdir(dir, { recursive: true });
		await import("node:fs/promises").then((fs) => fs.writeFile(file, "{nope"));
		const s = new OwnerStore(file);
		await s.load();
		expect(s.get("x")).toBeUndefined();
		await rm(dir, { recursive: true, force: true });
	});
});

describe("session owners in the host", () => {
	let root: string;
	let cwd: string;
	let host: PrometheusHost;
	let previous: string | undefined;
	const alice: Caller = { identity: { userId: "alice" } };
	const bob: Caller = { identity: { userId: "bob" } };

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "prometheus-owner-"));
		cwd = join(root, "work");
		await mkdir(cwd);
		previous = process.env[AGENT_DIR_ENV];
		process.env[AGENT_DIR_ENV] = join(root, "agent");
		host = await PrometheusHost.create({
			dataDir: join(root, "data"),
			cwd,
			listener: { event: () => {}, uiRequest: () => {}, uiResolved: () => {}, sessionsChanged: () => {}, gatewaysChanged: () => {}, pluginsChanged: () => {}, pluginNotify: () => {} },
		});
	}, 60_000);

	afterAll(async () => {
		await host?.dispose();
		if (previous === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previous;
		if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("records no owner without an identity", async () => {
		const snap = await host.call("session.create", { cwd });
		expect(snap.owner).toBeUndefined();
		expect(host.sessionOwner(snap.id)).toBeUndefined();
		await host.call("session.delete", { sessionId: snap.id });
	});

	it("records the creator, lists it, and drops it on delete", async () => {
		const snap = await host.call("session.create", { cwd }, alice);
		expect(snap.owner).toBe("alice");
		const opened = await host.call("session.open", { sessionId: snap.id });
		expect(opened.owner).toBe("alice");
		await host.call("session.rename", { sessionId: snap.id, name: "mine" }, alice);
		await host.call("session.delete", { sessionId: snap.id }, alice);
		expect(host.sessionOwner(snap.id)).toBeUndefined();
	});

	it("refuses every write method from a non-owner but lets them read", async () => {
		const snap = await host.call("session.create", { cwd }, alice);
		for (const method of SESSION_WRITE_METHODS) {
			await expect(host.call(method as never, { sessionId: snap.id } as never, bob), method).rejects.toMatchObject({ code: "sessionForbidden" });
		}
		await expect(host.call("chat.prompt", { sessionId: snap.id, text: "hi" }, bob)).rejects.toMatchObject({ code: "sessionForbidden" });
		await expect(host.call("session.open", { sessionId: snap.id }, bob)).resolves.toMatchObject({ id: snap.id });
		await expect(host.call("session.stats", { sessionId: snap.id }, bob)).resolves.toBeDefined();
		// The machine's own user (no identity) and a delegate may act.
		await expect(host.call("session.rename", { sessionId: snap.id, name: "x" })).resolves.toBeNull();
		await expect(host.call("session.rename", { sessionId: snap.id, name: "y" }, { identity: { userId: "hub", actsFor: ["alice"] } })).resolves.toBeNull();
		await host.call("session.delete", { sessionId: snap.id });
	});

	it("gives a fork to the forker, or keeps the source owner without an identity", async () => {
		const sm = SessionManager.create(cwd);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "q" }], timestamp: 1000 });
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "a" }], api: "anthropic-messages", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 2000 });
		const id = sm.getSessionId();
		await host.call("session.open", { sessionId: id });
		await host.call("session.rename", { sessionId: id, name: "Base" });
		const ref = { index: 1, role: "assistant" as const, timestamp: 2000 };
		// Fork of an unowned session by Bob is Bob's.
		const byBob = await host.call("message.fork", { sessionId: id, ref }, bob);
		expect(byBob.snapshot.owner).toBe("bob");
		expect((await host.call("session.list", {})).find((x) => x.id === byBob.snapshot.id)?.owner).toBe("bob");
		// Fork of Bob's fork without an identity keeps Bob.
		await host.call("session.open", { sessionId: byBob.snapshot.id });
		const inherited = await host.call("message.fork", { sessionId: byBob.snapshot.id, ref: { index: 1, role: "assistant", timestamp: 2000 } });
		expect(inherited.snapshot.owner).toBe("bob");
		// Alice may fork Bob's session (read-only source) and owns the result.
		const byAlice = await host.call("message.fork", { sessionId: byBob.snapshot.id, ref: { index: 1, role: "assistant", timestamp: 2000 } }, alice);
		expect(byAlice.snapshot.owner).toBe("alice");
	});
});
