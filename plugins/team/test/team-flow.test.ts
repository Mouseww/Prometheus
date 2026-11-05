import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { gitOk } from "../../../packages/hub/test/git-helpers.ts";
import type { ExtensionAPI } from "@prometheus/plugin-sdk";
import { type Member, startMember, startTeamWorld, type TeamWorld, waitFor } from "./harness.ts";

const T = 180_000;
// Git processes pile up when several suites run side by side; every test here talks to real git and a real Hub.
vi.setConfig({ testTimeout: T });
let tw: TeamWorld;
let alice: Member;
let bob: Member;
let dan: Member;

beforeAll(async () => {
	tw = await startTeamWorld();
	alice = await startMember(tw, "alice@corp.test");
	bob = await startMember(tw, "bob@corp.test");
	dan = await startMember(tw, "dan@corp.test");
}, T);
afterAll(async () => {
	await Promise.all([alice.stop(), bob.stop(), dan.stop()]);
	await tw.stop();
});

const api = <A = any>(who: "alice" | "bob" | "dan", method: string, path: string, body?: unknown) => tw.world.t.api<A>(method, path, { token: tw.world[who].token, body });
const hubSession = async (id: string) => (await api("alice", "GET", `/api/sessions/${id}`)).data;

async function startSession(m: Member, title: string) {
	const r = await m.ctx.call("session.start", { workspaceId: tw.world.wsId, title });
	return r as { sessionId: string; hubSessionId: string; worktree: string; branch: string };
}

describe("relay from the Hub", () => {
	let s: Awaited<ReturnType<typeof startSession>>;

	beforeAll(async () => {
		s = await startSession(alice, "relay target");
		await waitFor(() => alice.api.socket.connected, "Alice 的 Hub 连接");
		await api("alice", "POST", `/api/sessions/${s.hubSessionId}/grants`, { userId: tw.world.bob.userId });
	}, T);

	it("runs a granted teammate's prompt, respond and abort on the mapped session", async () => {
		const prompt = await api("bob", "POST", `/api/sessions/${s.hubSessionId}/actions`, { type: "prompt", text: "请继续" });
		expect(prompt.status).toBe(200);
		expect(alice.ctx.calls.at(-1)).toEqual({ kind: "prompt", sessionId: s.sessionId, text: "请继续", actor: "Bob" });

		const respond = await api("bob", "POST", `/api/sessions/${s.hubSessionId}/actions`, { type: "respond", requestId: "perm-9", response: { value: "allow" } });
		expect(respond.status).toBe(200);
		expect(alice.ctx.calls.at(-1)).toEqual({ kind: "respond", sessionId: s.sessionId, requestId: "perm-9", response: { value: "allow" } });

		const abort = await api("bob", "POST", `/api/sessions/${s.hubSessionId}/actions`, { type: "abort" });
		expect(abort.status).toBe(200);
		expect(alice.ctx.calls.at(-1)).toEqual({ kind: "abort", sessionId: s.sessionId });
	});

	it("refuses a relay for a local session that is not in the team mapping", async () => {
		const before = alice.ctx.calls.length;
		await api("alice", "PATCH", `/api/sessions/${s.hubSessionId}`, { localSessionId: "personal-session" });
		const r = await api("bob", "POST", `/api/sessions/${s.hubSessionId}/actions`, { type: "prompt", text: "sneak in" });
		expect(r.status).toBe(502);
		expect(r.code).toBe("relayFailed");
		expect(r.body).toMatchObject({ error: { message: expect.stringContaining("不是团队会话") } });
		expect(alice.ctx.calls.length).toBe(before);
		await api("alice", "PATCH", `/api/sessions/${s.hubSessionId}`, { localSessionId: s.sessionId });
	});

	it("an ungranted member cannot send actions at all", async () => {
		const r = await api("dan", "POST", `/api/sessions/${s.hubSessionId}/actions`, { type: "abort" });
		expect(r.status).toBe(403);
	});

	it("republishes subscribed Hub topics to the plugin stream", async () => {
		const topic = `workspace:${tw.world.wsId}`;
		await alice.ctx.call("hub.subscribe", { topic });
		await expect(alice.ctx.call("hub.subscribe", { topic: "bad topic!" })).rejects.toThrow(/topic/);
		await api("bob", "POST", `/api/workspaces/${tw.world.wsId}/sessions`, { localSessionId: "bobs-local", serverId: "srv-bob", title: "bob's", branch: `session/${tw.world.bob.userId}/stream`, baseCommit: "a".repeat(40) });
		const hit = await waitFor(() => alice.ctx.published.find((p) => p.topic === `hub:${topic}` && (p.data as { kind?: string }).kind === "session.created"), "stream publish");
		expect((hit.data as { session: { title: string } }).session.title).toBe("bob's");

		await alice.ctx.call("hub.unsubscribe", { topic });
		const seen = alice.ctx.published.length;
		await api("bob", "POST", `/api/workspaces/${tw.world.wsId}/sessions`, { localSessionId: "bobs-local-2", serverId: "srv-bob", title: "second", branch: `session/${tw.world.bob.userId}/stream2`, baseCommit: "a".repeat(40) });
		await new Promise((r) => setTimeout(r, 300));
		expect(alice.ctx.published.slice(seen).some((p) => p.topic === `hub:${topic}`)).toBe(false);
	});

	it("reconnects after the connection drops", async () => {
		const socket = alice.api.socket as unknown as { socket: { close(): void } | undefined };
		socket.socket?.close();
		await waitFor(() => !alice.api.socket.connected, "断开");
		await waitFor(() => alice.api.socket.connected, "重连", 10_000);
	});
});

describe("fork", () => {
	it("copies a teammate's session: snapshot files, transcript, new branch, Hub link", async () => {
		const s = await startSession(alice, "to be forked");
		await writeFile(join(s.worktree, "wip.txt"), "alice's uncommitted work\n");
		const transcript = '{"type":"session","id":"x"}\n{"type":"message","text":"history"}\n';
		alice.ctx.transcripts.set(s.sessionId, transcript);
		alice.ctx.emit.session(s.sessionId, { type: "agent_start" });
		alice.ctx.emit.session(s.sessionId, { type: "agent_end", willRetry: false });
		await alice.api.mirror.idle();
		const snapshot = (await waitFor(async () => (await hubSession(s.hubSessionId)).snapshotCommit, "snapshot")) as string;

		const forked = await bob.ctx.call("session.fork", { hubSessionId: s.hubSessionId });
		expect(forked.branch).toMatch(new RegExp(`^session/${tw.world.bob.userId}/`));
		expect(await gitOk(["rev-parse", "HEAD"], { cwd: forked.worktree })).toBe(snapshot);
		// (git may check files out with CRLF on Windows)
		expect((await readFile(join(forked.worktree, "wip.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("alice's uncommitted work\n");
		expect(await gitOk(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: forked.worktree })).toBe(forked.branch);

		expect(bob.ctx.imported).toHaveLength(1);
		expect(bob.ctx.imported[0]).toMatchObject({ cwd: forked.worktree, content: transcript, sessionId: forked.sessionId });

		const hub = (await api("bob", "GET", `/api/sessions/${forked.hubSessionId}`)).data;
		expect(hub).toMatchObject({ ownerUserId: tw.world.bob.userId, forkedFromSessionId: s.hubSessionId, localSessionId: forked.sessionId, branch: forked.branch });
		expect(bob.api.state.get().sessions[forked.sessionId]).toMatchObject({ hubSessionId: forked.hubSessionId, worktree: forked.worktree, branch: forked.branch });
		// The new session is mirrored from now on.
		bob.ctx.emit.session(forked.sessionId, { type: "agent_start" });
		await bob.api.mirror.idle();
		expect((await api("bob", "GET", `/api/sessions/${forked.hubSessionId}/events`)).data.items.map((e: { kind: string }) => e.kind)).toEqual(["agent_start"]);
	});
});

describe("submit and binary conflicts", () => {
	it("commits for real, pushes the branch and opens a merge request; skipReview needs a reviewer", async () => {
		const s = await startSession(alice, "feature");
		await writeFile(join(s.worktree, "feature.txt"), "hello\n");
		await writeFile(join(s.worktree, "debug.log"), "noise\n");
		const mr = (await alice.ctx.call("session.submit", { sessionId: s.sessionId, title: "Add feature", description: "details" })) as any;
		expect(mr).toMatchObject({ status: "open", title: "Add feature", description: "details", branch: s.branch, sessionId: s.hubSessionId });
		const head = await gitOk(["rev-parse", "HEAD"], { cwd: s.worktree });
		expect(mr.headCommit).toBe(head);
		expect(await gitOk(["log", "-1", "--format=%s", "HEAD"], { cwd: s.worktree })).toBe("Add feature");
		expect(await gitOk(["--git-dir", tw.world.repoPath, "rev-parse", `refs/heads/${s.branch}`])).toBe(head);
		expect(await gitOk(["--git-dir", tw.world.repoPath, "ls-tree", "-r", "--name-only", head])).not.toContain("debug.log");
		expect(await gitOk(["status", "--porcelain"], { cwd: s.worktree })).toBe("");

		const s2 = await startSession(alice, "skip");
		await writeFile(join(s2.worktree, "skip.txt"), "x\n");
		await expect(alice.ctx.call("session.submit", { sessionId: s2.sessionId, title: "Skip", skipReview: true })).rejects.toThrow(/跳过审核/);

		const s3 = await startSession(dan, "admin change");
		await writeFile(join(s3.worktree, "admin.txt"), "x\n");
		const merged = (await dan.ctx.call("session.submit", { sessionId: s3.sessionId, title: "Admin change", skipReview: true })) as any;
		expect(merged).toMatchObject({ status: "merged", skippedReview: true });
		expect(await gitOk(["--git-dir", tw.world.repoPath, "show", "refs/heads/main:admin.txt"])).toBe("x");
	});

	// Each round changes the file differently on both sides (the previous round's merge is now the team's version).
	it.each([
		["mine", Buffer.from([9, 9, 9, 0]), Buffer.from([7, 7, 7, 0])],
		["team", Buffer.from([6, 6, 6, 0]), Buffer.from([8, 8, 8, 0])],
	] as const)("resolveBinary keep %s settles a binary conflict and refreshes the request", async (keep, mineBytes, teamBytes) => {
		const expected = keep === "mine" ? mineBytes : teamBytes;
		const mine = await startSession(alice, `conflict ${keep}`);
		const team = await startSession(dan, `team side ${keep}`);
		const asset = (s: { worktree: string }) => join(s.worktree, "asset.bin");
		await writeFile(asset(mine), mineBytes);
		await writeFile(asset(team), teamBytes);
		const first = (await dan.ctx.call("session.submit", { sessionId: team.sessionId, title: `Team asset ${keep}`, skipReview: true })) as any;
		expect(first.status).toBe("merged");

		const conflicted = (await alice.ctx.call("session.submit", { sessionId: mine.sessionId, title: `My asset ${keep}` })) as any;
		expect(conflicted.status).toBe("conflict");
		expect(conflicted.conflictFiles).toMatchObject([{ path: "asset.bin", binary: true }]);

		await expect(alice.ctx.call("session.resolveBinary", { mergeRequestId: conflicted.id, path: "../outside", keep })).rejects.toThrow(/路径/);
		const r = (await alice.ctx.call("session.resolveBinary", { mergeRequestId: conflicted.id, path: "asset.bin", keep })) as any;
		expect(r.committed).toBe(true);
		expect(r.mergeRequest.status).toBe("open");
		expect(Buffer.compare(await readFile(asset(mine)), expected)).toBe(0);
		const onHub = await gitOk(["--git-dir", tw.world.repoPath, "rev-parse", `refs/heads/${mine.branch}:asset.bin`]);
		expect(onHub).toBe(await gitOk(["rev-parse", "HEAD:asset.bin"], { cwd: mine.worktree }));
		expect(await gitOk(["status", "--porcelain"], { cwd: mine.worktree })).toBe("");
	}, T);
});

describe("team model provider", () => {
	it("registers a `team` PI provider that reads the live token from the plugin's token file", async () => {
		const gw = await tw.world.t.api("POST", "/api/admin/gateways", {
			token: tw.world.root.token,
			body: { scope: "platform", name: "Main", format: "openai", baseUrl: "https://api.example.com/v1/", apiKey: "sk-test-key-123456", models: [{ id: "gpt-a", name: "GPT A" }, "gpt-b"] },
		});
		expect(gw.status).toBe(201);
		const m = await startMember(tw, "alice@corp.test");
		try {
			const registered: { name: string; config: any }[] = [];
			const removed: string[] = [];
			const pi = { registerProvider: (name: string, config: unknown) => void registered.push({ name, config }), unregisterProvider: (name: string) => void removed.push(name) } as unknown as ExtensionAPI;
			// The handoff read-only guard registers first, the provider factory second.
			expect(m.ctx.factories).toHaveLength(2);
			await m.api.provider.refreshModels();
			await m.ctx.factories[1]!(pi);

			const last = () => registered.at(-1)!;
			expect(last().name).toBe("team");
			expect(last().config.baseUrl).toBe(`${tw.hubUrl}/plugins/team/llm/openai`);
			expect(last().config.models.map((x: { id: string }) => x.id)).toEqual(["gpt-a", "gpt-b"]);
			expect(last().config.models[0]).toMatchObject({ api: "openai-completions", baseUrl: `${tw.hubUrl}/plugins/team/llm/openai` });
			expect(last().config.apiKey.startsWith("!")).toBe(true);
			const run = () => execSync(last().config.apiKey.slice(1), { encoding: "utf8" }).trim();
			const token = await m.api.client.ensureToken();
			expect(run()).toBe(token);

			// A refreshed token changes the command text (PI caches by it) and the file the command reads.
			const firstKey = last().config.apiKey;
			const fresh = await m.api.client.ensureToken(true);
			expect(fresh).not.toBe(token);
			expect(last().config.apiKey).not.toBe(firstKey);
			expect(run()).toBe(fresh);
			expect(existsSync(join(m.ctx.dataDir, "team", "access-token"))).toBe(true);

			await m.ctx.call("logout");
			expect(removed).toContain("team");
			expect(await m.ctx.call("status")).toMatchObject({ loggedIn: false });
			expect(existsSync(join(m.ctx.dataDir, "team", "access-token"))).toBe(false);
		} finally {
			await m.stop();
		}
	});
});
