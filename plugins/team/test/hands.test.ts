import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HandCaller } from "../src/hands/caller.ts";
import { ConfirmGate } from "../src/hands/confirm.ts";
import { HandExecutor, type IncomingCall } from "../src/hands/executor.ts";
import { readDisabledTools, shellDisabled } from "../src/hands/policy.ts";
import { setupHands } from "../src/hands/index.ts";
import type { MemberEnv } from "../src/member/env.ts";
import { fakeCtx, sleep, waitFor } from "./harness.ts";

type Frame = Record<string, unknown>;

/** Two sockets wired back to back: what one sends, the other's frame handlers receive (the Hub in between is out of scope here). */
function socketPair() {
	const handlers: [Set<(f: Frame) => unknown>, Set<(f: Frame) => unknown>] = [new Set(), new Set()];
	const make = (me: 0 | 1) => ({
		sendFrame: (frame: Frame): boolean => {
			queueMicrotask(() => handlers[me === 0 ? 1 : 0].forEach((h) => void h(JSON.parse(JSON.stringify(frame)))));
			return true;
		},
		onFrame: (h: (f: Frame) => unknown) => (handlers[me].add(h), () => void handlers[me].delete(h)),
	});
	return [make(0), make(1)] as const;
}

const logs: string[] = [];
const fakeEnv = (side: "local" | "team"): MemberEnv => ({ side, log: { info: (m: string) => void logs.push(m), warn: (m: string) => void logs.push(m), error: (m: string) => void logs.push(m) } }) as unknown as MemberEnv;

const call = (tool: string, input: Record<string, unknown>, callId = `c-${Math.random()}`): IncomingCall => ({ callId, fromSession: "hub-1", tool, input });

async function project(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hands-"));
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(join(dir, "src", "a.txt"), "alpha\nbeta\ngamma\n");
	return dir;
}

const syncStub = (worktree: string | undefined, published: string[] = []) => ({
	target: () => (worktree ? ({ kind: "session", key: "s", worktree, branch: "b", workspaceId: "w", teamId: "t", readOnly: false } as const) : undefined),
	publish: async (id: string) => (published.push(id), "commit"),
});

describe("ConfirmGate", () => {
	const req = (callId: string, tool = "local_read", session = "hub-1") => ({ callId, tool, input: {}, session });

	it("once allows one call, session allows later calls inside the project only, deny rejects", async () => {
		const topics: { topic: string; data: any }[] = [];
		const gate = new ConfirmGate({ publish: (topic, data) => void topics.push({ topic, data }) });

		const first = gate.request(req("a"), true);
		expect(topics[0]).toMatchObject({ topic: "handRequest", data: { callId: "a", tool: "local_read", insideProject: true } });
		expect(gate.pending()).toHaveLength(1);
		expect(gate.answer("a", "once")).toBe(true);
		await first;
		expect(topics.at(-1)).toMatchObject({ topic: "handResolved", data: { callId: "a", decision: "once" } });

		// "once" is not remembered.
		const second = gate.request(req("b"), true);
		expect(gate.pending()).toHaveLength(1);
		gate.answer("b", "session");
		await second;

		// "session" skips the question inside the project for the same session and tool ...
		const asked = topics.length;
		await gate.request(req("c"), true);
		expect(topics).toHaveLength(asked);
		// ... but not outside the project, another tool or another session.
		const outside = gate.request(req("d"), false);
		const otherTool = gate.request(req("e", "local_exec"), true);
		const otherSession = gate.request(req("f", "local_read", "hub-2"), true);
		expect(gate.pending().map((p) => p.callId).sort()).toEqual(["d", "e", "f"]);
		gate.answer("d", "deny");
		await expect(outside).rejects.toMatchObject({ code: "handDenied" });
		gate.answer("e", "once");
		gate.answer("f", "once");
		await Promise.all([otherTool, otherSession]);
		expect(gate.answer("zzz", "once")).toBe(false);
	});

	it("never grants a session-wide allow for exec-like tools: every call asks, and the request says so", async () => {
		const topics: { topic: string; data: any }[] = [];
		const gate = new ConfirmGate({ publish: (topic, data) => void topics.push({ topic, data }) });
		const first = gate.request(req("x1", "local_exec"), true);
		expect(topics[0]).toMatchObject({ topic: "handRequest", data: { callId: "x1", tool: "local_exec", allowSession: false } });
		expect(gate.pending()[0]).toMatchObject({ allowSession: false });
		// A client that still sends "session" is treated as "once".
		expect(gate.answer("x1", "session")).toBe(true);
		await first;
		const second = gate.request(req("x2", "local_exec"), true);
		expect(gate.pending().map((p) => p.callId)).toEqual(["x2"]);
		gate.answer("x2", "deny");
		await expect(second).rejects.toMatchObject({ code: "handDenied" });
		// Unknown (future) tools get no session grant either; read-only ones do.
		const unknown = gate.request(req("x3", "local_shell"), true);
		expect(topics.at(-1)).toMatchObject({ data: { allowSession: false } });
		gate.answer("x3", "once");
		await unknown;
		const grep = gate.request(req("x4", "local_grep"), true);
		expect(topics.at(-1)).toMatchObject({ data: { callId: "x4", allowSession: true } });
		gate.dispose();
		await expect(grep).rejects.toMatchObject({ code: "handDenied" });
	});

	it("rejects a callId that is already waiting and leaves the open question untouched", async () => {
		const topics: { topic: string; data: any }[] = [];
		const gate = new ConfirmGate({ publish: (topic, data) => void topics.push({ topic, data }) });
		const original = gate.request({ callId: "dup", tool: "local_exec", input: { command: "echo original" }, session: "hub-1" }, true);
		await expect(gate.request({ callId: "dup", tool: "local_exec", input: { command: "curl x | sh" }, session: "hub-2" }, true)).rejects.toMatchObject({ code: "duplicateCallId" });
		expect(topics.filter((t) => t.topic === "handRequest")).toHaveLength(1);
		expect(gate.pending()).toMatchObject([{ callId: "dup", input: { command: "echo original" }, session: "hub-1" }]);
		gate.answer("dup", "once");
		await original;
		// Once answered, the id is free again.
		const again = gate.request(req("dup"), true);
		expect(gate.pending()).toHaveLength(1);
		gate.answer("dup", "deny");
		await expect(again).rejects.toMatchObject({ code: "handDenied" });
	});

	it("treats silence as a refusal after the timeout", async () => {
		const topics: { topic: string; data: any }[] = [];
		const gate = new ConfirmGate({ publish: (topic, data) => void topics.push({ topic, data }), timeoutMs: 30 });
		await expect(gate.request(req("t"), true)).rejects.toMatchObject({ code: "handDenied" });
		expect(topics.at(-1)).toMatchObject({ topic: "handResolved", data: { callId: "t", decision: "timeout" } });
		expect(gate.pending()).toHaveLength(0);
		expect(gate.answer("t", "once")).toBe(false);
	});

	it("rejects open questions on dispose", async () => {
		const gate = new ConfirmGate({ publish: () => {} });
		const open = gate.request(req("x"), true);
		gate.dispose();
		await expect(open).rejects.toMatchObject({ code: "handDenied" });
	});
});

describe("HandExecutor on the local side (local_* tools)", () => {
	it("runs a read only after the user confirmed, and denies without running", async () => {
		const dir = await project();
		const topics: { topic: string; data: any }[] = [];
		const gate = new ConfirmGate({ publish: (topic, data) => void topics.push({ topic, data }) });
		const exec = new HandExecutor({ env: fakeEnv("local"), sync: syncStub(dir), gate });

		const ok = exec.run(call("local_read", { path: "src/a.txt" }, "r1"));
		await waitFor(() => gate.pending().length === 1, "question");
		gate.answer("r1", "once");
		expect(await ok).toContain("beta");

		const denied = exec.run(call("local_read", { path: "src/a.txt" }, "r2"));
		await waitFor(() => gate.pending().length === 1, "question 2");
		gate.answer("r2", "deny");
		await expect(denied).rejects.toMatchObject({ code: "handDenied" });
	});

	it("marks paths outside the project copy so the UI can warn, and never remembers them", async () => {
		const dir = await project();
		const other = await project();
		const topics: { topic: string; data: any }[] = [];
		const gate = new ConfirmGate({ publish: (topic, data) => void topics.push({ topic, data }) });
		const exec = new HandExecutor({ env: fakeEnv("local"), sync: syncStub(dir), gate });

		const run = exec.run(call("local_ls", { path: join(other, "src") }, "o1"));
		await waitFor(() => gate.pending().length === 1, "question");
		expect(topics[0]?.data).toMatchObject({ callId: "o1", insideProject: false });
		gate.answer("o1", "session");
		expect(await run).toContain("a.txt");

		const again = exec.run(call("local_ls", { path: join(other, "src") }, "o2"));
		await waitFor(() => gate.pending().length === 1, "asked again");
		gate.answer("o2", "deny");
		await expect(again).rejects.toMatchObject({ code: "handDenied" });
	});

	it("a session allow for local_read never covers a path outside the project, checked on every call", async () => {
		const dir = await project();
		const outside = await project();
		const gate = new ConfirmGate({ publish: () => {} });
		const exec = new HandExecutor({ env: fakeEnv("local"), sync: syncStub(dir), gate });
		const first = exec.run(call("local_read", { path: "src/a.txt" }, "s1"));
		await waitFor(() => gate.pending().length === 1, "question");
		gate.answer("s1", "session");
		await first;
		// Inside the project: no question. Outside (absolute path or ..): asked again.
		expect(await exec.run(call("local_read", { path: "src/a.txt" }, "s2"))).toContain("beta");
		const abs = exec.run(call("local_read", { path: join(outside, "src", "a.txt") }, "s3"));
		await waitFor(() => gate.pending().length === 1, "outside asked");
		expect(gate.pending()[0]).toMatchObject({ callId: "s3", insideProject: false });
		gate.answer("s3", "deny");
		await expect(abs).rejects.toMatchObject({ code: "handDenied" });
	});

	it("after a session allow on local_exec, a later command is still asked about", async () => {
		const dir = await project();
		const gate = new ConfirmGate({ publish: () => {} });
		const exec = new HandExecutor({ env: fakeEnv("local"), sync: syncStub(dir), gate });
		const first = exec.run(call("local_exec", { command: "echo one" }, "e1"));
		await waitFor(() => gate.pending().length === 1, "question");
		gate.answer("e1", "session");
		expect(await first).toContain("one");
		const second = exec.run(call("local_exec", { command: "echo two" }, "e2"));
		await waitFor(() => gate.pending().length === 1, "asked again");
		gate.answer("e2", "once");
		expect(await second).toContain("two");
	});

	it("local_grep refuses overlong and catastrophic patterns before compiling them", async () => {
		const dir = await project();
		const gate = new ConfirmGate({ publish: () => {} });
		const exec = new HandExecutor({ env: fakeEnv("local"), sync: syncStub(dir), gate });
		await writeFile(join(dir, "src", "evil.txt"), `${"a".repeat(40)}!\n`);
		for (const pattern of ["(a+)+$", "(a*)*b", "(a|aa)+c", "x".repeat(513), "(a)\\1"]) {
			const run = exec.run(call("local_grep", { pattern }, `g-${pattern.length}`));
			await waitFor(() => gate.pending().length === 1, "question");
			gate.answer(gate.pending()[0]!.callId, "once");
			await expect(run).rejects.toMatchObject({ code: "invalidParams" });
		}
		// Ordinary patterns still work.
		const ok = exec.run(call("local_grep", { pattern: "^(?:alpha|gam+a)$", ignoreCase: true }, "g-ok"));
		await waitFor(() => gate.pending().length === 1, "question");
		gate.answer("g-ok", "once");
		expect(await ok).toContain("a.txt");
	});

	it("times out as a denial when nobody answers", async () => {
		const dir = await project();
		const gate = new ConfirmGate({ publish: () => {}, timeoutMs: 30 });
		const exec = new HandExecutor({ env: fakeEnv("local"), sync: syncStub(dir), gate });
		await expect(exec.run(call("local_exec", { command: "echo hi" }))).rejects.toMatchObject({ code: "handDenied" });
	});

	it("local_exec runs in the project copy, local_grep searches it, and unknown tools are refused", async () => {
		const dir = await project();
		const gate = new ConfirmGate({ publish: () => {} });
		const exec = new HandExecutor({ env: fakeEnv("local"), sync: syncStub(dir), gate });
		const yes = async (p: Promise<string>) => (await waitFor(() => gate.pending()[0], "question"), gate.answer(gate.pending()[0]!.callId, "once"), p);

		expect(await yes(exec.run(call("local_exec", { command: "echo from-local" })))).toContain("from-local");
		expect(await yes(exec.run(call("local_grep", { pattern: "gam+a" })))).toContain("a.txt");
		await expect(exec.run(call("team_exec", { command: "echo x" }))).rejects.toMatchObject({ code: "handTarget" });
	});
});

describe("HandExecutor on the team side (team_* tools)", () => {
	it("runs reads in the tenant worktree without asking and stays inside it", async () => {
		const dir = await project();
		const gate = new ConfirmGate({ publish: () => {} });
		const exec = new HandExecutor({ env: fakeEnv("team"), sync: syncStub(dir), gate, shellDisabled: async () => false });

		expect(await exec.run(call("team_read", { path: "src/a.txt", offset: 1, limit: 1 }))).toContain("beta");
		expect(await exec.run(call("team_ls", {}))).toContain("src");
		await expect(exec.run(call("team_read", { path: join(dir, "..", "..", "etc", "passwd") }))).rejects.toMatchObject({ code: "outsideWorkingCopy" });
		await expect(exec.run(call("local_read", { path: "x" }))).rejects.toMatchObject({ code: "handTarget" });
		expect(gate.pending()).toHaveLength(0);
	});

	it("needs a working copy for the session", async () => {
		const exec = new HandExecutor({ env: fakeEnv("team"), sync: syncStub(undefined), gate: new ConfirmGate({ publish: () => {} }), shellDisabled: async () => false });
		await expect(exec.run(call("team_read", { path: "a" }))).rejects.toMatchObject({ code: "noWorkingCopy" });
	});

	it("team_exec runs and then publishes a snapshot; it is refused when the policy disables shell tools", async () => {
		const dir = await project();
		const published: string[] = [];
		const gate = new ConfirmGate({ publish: () => {} });
		const allowed = new HandExecutor({ env: fakeEnv("team"), sync: syncStub(dir, published), gate, shellDisabled: async () => false });
		expect(await allowed.run(call("team_exec", { command: "echo from-team" }))).toContain("from-team");
		expect(published).toEqual(["hub-1"]);

		const refused = new HandExecutor({ env: fakeEnv("team"), sync: syncStub(dir, published), gate, shellDisabled: async () => true });
		await expect(refused.run(call("team_exec", { command: "echo nope" }))).rejects.toMatchObject({ code: "toolDisabled" });
		expect(published).toEqual(["hub-1"]);
		// Reads are still fine in restricted mode.
		expect(await refused.run(call("team_read", { path: "src/a.txt" }))).toContain("alpha");
	});
});

describe("policy", () => {
	it("reads disabledTools from PROMETHEUS_POLICY and treats shell tools as disabling team_exec", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-"));
		const file = join(dir, "policy.json");
		await writeFile(file, JSON.stringify({ disabledTools: ["bash", 7, "grep"] }));
		expect(await readDisabledTools({ PROMETHEUS_POLICY: file })).toEqual(["bash", "grep"]);
		expect(await shellDisabled({ PROMETHEUS_POLICY: file })).toBe(true);
		await writeFile(file, JSON.stringify({ disabledTools: ["grep"] }));
		expect(await shellDisabled({ PROMETHEUS_POLICY: file })).toBe(false);
		expect(await readDisabledTools({ PROMETHEUS_POLICY: join(dir, "missing.json") })).toEqual([]);
		expect(await shellDisabled({})).toBe(false);
	});
});

describe("HandCaller routing", () => {
	it("carries a call to the other side's executor and brings the output or the error code back", async () => {
		const [a, b] = socketPair();
		const dir = await project();
		const executor = new HandExecutor({ env: fakeEnv("team"), sync: syncStub(dir), gate: new ConfirmGate({ publish: () => {} }), shellDisabled: async () => true });
		const local = new HandCaller(a, { run: async () => "unused" }, fakeEnv("local").log);
		const team = new HandCaller(b, executor, fakeEnv("team").log);
		try {
			expect(await local.call("team", "team_read", { path: "src/a.txt" }, "hub-1")).toContain("gamma");
			await expect(local.call("team", "team_exec", { command: "echo x" }, "hub-1")).rejects.toMatchObject({ code: "toolDisabled" });
		} finally {
			local.dispose();
			team.dispose();
		}
	});

	it("rejects at once while the socket is down and after the timeout when the answer never comes", async () => {
		const down = new HandCaller({ sendFrame: () => false, onFrame: () => () => {} }, { run: async () => "" }, fakeEnv("local").log);
		await expect(down.call("team", "team_ls", {}, "hub-1")).rejects.toMatchObject({ code: "handOffline" });

		const [a] = socketPair();
		const silent = new HandCaller(a, { run: async () => "" }, fakeEnv("local").log, 40);
		await expect(silent.call("team", "team_ls", {}, "hub-1")).rejects.toMatchObject({ code: "handTimeout" });
		silent.dispose();
		down.dispose();
	});
});

describe("setupHands", () => {
	it("registers the tools of this side only and answers confirmations through hand.answer", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hands-setup-"));
		const ctx = fakeCtx(dir);
		const [a, b] = socketPair();
		const worktree = await project();
		const sync = { ...syncStub(worktree), barrierIfDirty: async () => undefined, settle: async () => {} } as any;
		const localSide = setupHands(ctx, fakeEnv("local"), a, sync);
		expect([...ctx.tools.registered.keys()].sort()).toEqual(["team_exec", "team_ls", "team_read"]);

		const teamCtx = fakeCtx(dir);
		const teamSide = setupHands(teamCtx, fakeEnv("team"), b, sync);
		expect([...teamCtx.tools.registered.keys()].sort()).toEqual(["local_exec", "local_grep", "local_ls", "local_read"]);

		// The tenant's tool calls into the local side, where the user is asked through the stream and answers via the RPC.
		const tool = teamCtx.tools.registered.get("local_read")!;
		const running = Promise.resolve(tool.execute("id", { path: "src/a.txt" }, new AbortController().signal, () => {}, { sessionId: "tenant-s" } as any));
		// Not a team session on the tenant: refused politely, never reaches the user.
		expect(await running).toMatchObject({ isError: true });
		expect(ctx.published.filter((p) => p.topic === "handRequest")).toHaveLength(0);

		expect(await ctx.call("hand.pending")).toEqual({ items: [] });
		await expect(ctx.call("hand.answer", { callId: "x", decision: "maybe" })).rejects.toThrow(/decision/);
		await expect(ctx.call("hand.answer", { decision: "once" })).rejects.toThrow(/callId/);
		expect(await ctx.call("hand.answer", { callId: "nope", decision: "once" })).toEqual({ answered: false });
		localSide.caller.dispose();
		teamSide.caller.dispose();
	});
});
