import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { gitOk } from "../../../packages/hub/test/git-helpers.ts";
import { HubClient, jwtExpiryMs } from "../src/member/hub-client.ts";
import { openStateStore } from "../src/member/state.ts";
import { fakeCtx, freshIpFetch, type Member, PASSWORD, startMember, startTeamWorld, type TeamWorld, waitFor } from "./harness.ts";

const T = 120_000;
vi.setConfig({ testTimeout: T });
let tw: TeamWorld;
let alice: Member;

beforeAll(async () => {
	tw = await startTeamWorld();
	alice = await startMember(tw, "alice@corp.test");
}, T);
afterAll(async () => {
	await alice.stop();
	await tw.stop();
});

const hubSessions = async (token = tw.world.alice.token) => (await tw.world.t.api("GET", `/api/workspaces/${tw.world.wsId}/sessions`, { token })).data as any[];
const hubSession = async (id: string, token = tw.world.alice.token) => (await tw.world.t.api("GET", `/api/sessions/${id}`, { token })).data;
const hubEvents = async (id: string) => (await tw.world.t.api("GET", `/api/sessions/${id}/events?limit=1000`, { token: tw.world.alice.token })).data.items as { seq: number; kind: string; payload: any }[];

describe("login and tokens", () => {
	it("logs in, keeps team.json and the token file, and reports status", async () => {
		const status = await alice.ctx.call("status");
		expect(status).toMatchObject({ connected: true, loggedIn: true, hubUrl: tw.hubUrl, user: { id: tw.world.alice.userId } });
		const state = JSON.parse(await readFile(join(alice.ctx.dataDir, "team", "team.json"), "utf8"));
		expect(state.refreshToken).toBeTruthy();
		expect(state.userId).toBe(tw.world.alice.userId);
		const file = await readFile(join(alice.ctx.dataDir, "team", "access-token"), "utf8");
		expect(jwtExpiryMs(file)).toBeGreaterThan(Date.now());
		expect(file).toBe(await alice.api.client.ensureToken());
	});

	it("rejects a wrong password and a bad address without touching the stored login", async () => {
		const other = await startMember(tw, "alice@corp.test", { login: false });
		await expect(other.ctx.call("login", { hubUrl: tw.hubUrl, email: "alice@corp.test", password: "wrong-password-123" })).rejects.toThrow(/邮箱或密码错误/);
		await expect(other.ctx.call("login", { hubUrl: "ftp://x", email: "a@b.c", password: "x" })).rejects.toThrow(/http/);
		expect(await other.ctx.call("status")).toMatchObject({ loggedIn: false });
		await other.stop();
	});

	it("refreshes the access token shortly before it expires and rotates the refresh token", async () => {
		const dir = join(alice.root, "refresh-case");
		await mkdir(dir, { recursive: true });
		const state = await openStateStore(dir);
		let offset = 0;
		const client = new HubClient({ state, log: alice.ctx.log, fetch: freshIpFetch, now: () => Date.now() + offset });
		await client.login(tw.hubUrl, "dan@corp.test", PASSWORD);
		const first = await client.ensureToken();
		const firstRefresh = state.get().refreshToken;
		expect(await client.ensureToken()).toBe(first);

		offset = 14.5 * 60_000; // inside the 60 second margin
		const second = await client.ensureToken();
		expect(second).not.toBe(first);
		expect(state.get().refreshToken).not.toBe(firstRefresh);
		expect(readFileSync(client.tokenFile, "utf8")).toBe(second);
		client.dispose();
	});

	it("hub.request forwards with the bearer token, refreshes once on a 401 and returns the envelope", async () => {
		const me = await alice.ctx.call("hub.request", { method: "GET", path: "/me" });
		expect(me.ok).toBe(true);
		expect(me.data.user.id).toBe(tw.world.alice.userId);

		let rejected = 0;
		const m = await startMember(tw, "bob@corp.test", {
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				if (String(input).endsWith("/api/me") && rejected === 0 && headers.get("authorization")) {
					rejected++;
					return Promise.resolve(new Response(JSON.stringify({ ok: false, error: { code: "invalidToken", message: "过期" } }), { status: 401 }));
				}
				return freshIpFetch(input, init);
			},
		});
		const before = m.api.state.get().refreshToken;
		const reply = await m.ctx.call("hub.request", { method: "GET", path: "/me" });
		expect(rejected).toBe(1);
		expect(reply.ok).toBe(true);
		expect(m.api.state.get().refreshToken).not.toBe(before);

		const missing = await m.ctx.call("hub.request", { method: "GET", path: "/does-not-exist" });
		expect(missing).toMatchObject({ ok: false, error: { code: "notFound" } });
		await expect(m.ctx.call("hub.request", { method: "GET", path: "//evil.example/x" })).rejects.toThrow(/path/);
		await expect(m.ctx.call("hub.request", { method: "TRACE", path: "/me" })).rejects.toThrow(/method/);
		await m.stop();
	});
});

describe("checkout, start and mirroring", () => {
	let localId: string;
	let hubId: string;
	let worktree: string;

	it("checkout clones into <team>/<workspace>/.repo with the token only in transient headers", async () => {
		const r = await alice.ctx.call("workspace.checkout", { workspaceId: tw.world.wsId });
		expect(r.repoDir).toBe(join(alice.teamRoot, "Platform", "app", ".repo"));
		expect(existsSync(join(r.repoDir, "README.md"))).toBe(true);

		const config = await readFile(join(r.repoDir, ".git", "config"), "utf8");
		const token = await alice.api.client.ensureToken();
		expect(config).not.toContain(token);
		expect(config.toLowerCase()).not.toContain("bearer");
		expect(config).not.toContain("extraheader");
		expect(await gitOk(["remote", "get-url", "origin"], { cwd: r.repoDir })).toBe(`${tw.hubUrl}/plugins/team/git/${tw.world.wsId}.git`);

		// Checking out again just fetches, and the clone is not a Prometheus workspace (nothing was opened).
		await alice.ctx.call("workspace.checkout", { workspaceId: tw.world.wsId });
		expect(alice.ctx.opened).toHaveLength(0);
		expect(alice.api.state.get().workspaces[tw.world.wsId]).toMatchObject({ repoDir: r.repoDir, teamName: "Platform", workspaceName: "app" });
	});

	it("session.start creates the worktree, branch, local session and Hub session", async () => {
		const r = await alice.ctx.call("session.start", { workspaceId: tw.world.wsId, title: "加登录页" });
		localId = r.sessionId;
		hubId = r.hubSessionId;
		worktree = r.worktree;
		expect(r.branch).toMatch(new RegExp(`^session/${tw.world.alice.userId}/`));
		expect(existsSync(join(worktree, "README.md"))).toBe(true);
		expect(await gitOk(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree })).toBe(r.branch);
		expect(worktree.startsWith(join(alice.teamRoot, "Platform", "app", "sessions"))).toBe(true);

		expect(alice.ctx.opened).toHaveLength(1);
		expect(alice.ctx.opened[0]).toMatchObject({ cwd: worktree, name: "加登录页", workspaceName: "Platform/app: 加登录页", runtime: "pi" });
		const hub = await hubSession(hubId);
		expect(hub).toMatchObject({ title: "加登录页", branch: r.branch, ownerUserId: tw.world.alice.userId, localSessionId: localId, status: "idle" });
		expect(hub.baseCommit).toBe(await gitOk(["rev-parse", "origin/main"], { cwd: join(alice.teamRoot, "Platform", "app", ".repo") }));
		expect(alice.api.state.get().sessions[localId]).toMatchObject({ hubSessionId: hubId, worktree, branch: r.branch, workspaceId: tw.world.wsId });
	});

	it("condenses events: drops streaming deltas, caps tool results, numbers events monotonically", async () => {
		const e = alice.ctx.emit;
		e.session(localId, { type: "agent_start" });
		e.session(localId, { type: "message_update", delta: { type: "text_end", contentIndex: 0 } } as never);
		e.session(localId, { type: "turn_start" });
		e.session(localId, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你好" }] } as never });
		e.session(localId, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		e.session(localId, { type: "tool_execution_update", toolCallId: "t1", toolName: "bash", partialResult: "..." });
		e.session(localId, { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "x".repeat(50_000) }] }, isError: false });
		e.session(localId, { type: "session_info_changed", name: "新标题" });
		await alice.api.mirror.idle();

		const events = await hubEvents(hubId);
		expect(events.map((x) => x.kind)).toEqual(["agent_start", "message_end", "tool_execution_start", "tool_execution_end", "session_info_changed"]);
		expect(events.map((x) => x.seq)).toEqual([0, 1, 2, 3, 4]);
		const end = events[3]!.payload;
		expect(end.toolName).toBe("bash");
		expect(end.result.length).toBeLessThan(21 * 1024);
		expect(end.result.startsWith("xxx")).toBe(true);
		const hub = await hubSession(hubId);
		expect(hub.status).toBe("running");
		expect(hub.title).toBe("新标题");
		expect(alice.api.state.get().sessions[localId]?.nextSeq).toBe(5);
	});

	it("ignores sessions that are not in the mapping", async () => {
		const before = (await hubEvents(hubId)).length;
		alice.ctx.emit.session("some-personal-session", { type: "agent_start" });
		alice.ctx.emit.uiRequest("some-personal-session", { id: "r", method: "confirm", title: "t", message: "m" });
		await alice.api.mirror.idle();
		expect((await hubEvents(hubId)).length).toBe(before);
		expect((await hubSessions()).filter((s) => s.title === "some-personal-session")).toHaveLength(0);
	});

	it("batches at most 50 events per upload and continues numbering after a restart", async () => {
		const posts = () => alice.fetchLog.filter((f) => f.method === "POST" && f.url.endsWith(`/sessions/${hubId}/events`)).length;
		const before = posts();
		for (let i = 0; i < 120; i++) alice.ctx.emit.session(localId, { type: "message_end", message: { role: "user", content: [{ type: "text", text: `m${i}` }] } as never });
		await alice.api.mirror.idle();
		expect(posts() - before).toBeGreaterThanOrEqual(3);
		const events = await hubEvents(hubId);
		expect(events).toHaveLength(5 + 120);
		expect(events.map((x) => x.seq)).toEqual(Array.from({ length: 125 }, (_, i) => i));

		// A second instance on the same data folder picks the numbering up from team.json.
		const root = alice.root;
		await alice.stop();
		alice = await startMember(tw, "alice@corp.test", { root, login: false });
		alice.ctx.emit.session(localId, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "after restart" }] } as never });
		await alice.api.mirror.idle();
		const after = await hubEvents(hubId);
		expect(after[after.length - 1]).toMatchObject({ seq: 125, kind: "message_end" });
	});

	it("marks the session waiting while a UI request is open and running again once it is answered", async () => {
		alice.ctx.emit.session(localId, { type: "agent_start" });
		alice.ctx.emit.uiRequest(localId, { id: "perm-1", method: "permission", kind: "tool", toolName: "bash", summary: "rm -rf build" } as UIRequestLike);
		alice.ctx.emit.uiRequest(localId, { id: "n-1", method: "notify", message: "fyi", level: "info" });
		await alice.api.mirror.idle();
		expect((await hubSession(hubId)).status).toBe("waiting");
		const req = (await hubEvents(hubId)).filter((x) => x.kind === "ui_request");
		expect(req).toHaveLength(1);
		expect(req[0]!.payload).toMatchObject({ requestId: "perm-1", method: "permission", toolName: "bash" });

		alice.ctx.emit.uiResolved(localId, "perm-1");
		await alice.api.mirror.idle();
		expect((await hubSession(hubId)).status).toBe("running");
		expect((await hubEvents(hubId)).some((x) => x.kind === "ui_resolved" && x.payload.requestId === "perm-1")).toBe(true);
	});

	it("after a finished turn it uploads the transcript and a snapshot without touching the user's index or files", async () => {
		await writeFile(join(worktree, "README.md"), "# edited by the agent\n");
		await writeFile(join(worktree, "tracked-new.txt"), "staged by the user\n");
		await gitOk(["add", "tracked-new.txt"], { cwd: worktree });
		await writeFile(join(worktree, "untracked.txt"), "never added\n");
		await mkdir(join(worktree, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(worktree, "node_modules", "pkg", "index.js"), "ignored\n");
		await writeFile(join(worktree, "debug.log"), "ignored\n");

		const gitDir = await gitOk(["rev-parse", "--absolute-git-dir"], { cwd: worktree });
		const snapshotState = async () => ({
			status: await gitOk(["status", "--porcelain=v1", "-uall"], { cwd: worktree }),
			staged: await gitOk(["ls-files", "--stage"], { cwd: worktree }),
			head: await gitOk(["rev-parse", "HEAD"], { cwd: worktree }),
			// The index file itself, byte for byte.
			index: createHash("sha1").update(readFileSync(join(gitDir, "index"))).digest("hex"),
			files: await Promise.all(["README.md", "tracked-new.txt", "untracked.txt"].map((f) => readFile(join(worktree, f), "utf8"))),
		});
		const before = await snapshotState();

		alice.ctx.transcripts.set(localId, '{"type":"session"}\n{"type":"message","text":"hello"}\n');
		alice.ctx.emit.session(localId, { type: "agent_end", willRetry: false });
		await alice.api.mirror.idle();

		expect(await snapshotState()).toEqual(before);

		const hub = await waitFor(async () => {
			const s = await hubSession(hubId);
			return s.snapshotCommit ? s : undefined;
		}, "snapshotCommit");
		expect(hub.status).toBe("idle");
		const ref = `refs/prometheus/snapshots/${tw.world.alice.userId}/${hubId}`;
		const tip = await gitOk(["--git-dir", tw.world.repoPath, "rev-parse", ref]);
		expect(tip).toBe(hub.snapshotCommit);
		const files = (await gitOk(["--git-dir", tw.world.repoPath, "ls-tree", "-r", "--name-only", tip])).split("\n");
		expect(files).toEqual(expect.arrayContaining(["README.md", "tracked-new.txt", "untracked.txt"]));
		expect(files.some((f) => f.startsWith("node_modules/") || f.endsWith(".log"))).toBe(false);
		expect(await gitOk(["--git-dir", tw.world.repoPath, "show", `${tip}:README.md`])).toBe("# edited by the agent");
		expect(await gitOk(["--git-dir", tw.world.repoPath, "rev-parse", `${tip}^`])).toBe(before.head);

		const transcript = (await tw.world.t.api("GET", `/api/sessions/${hubId}/transcript`, { token: tw.world.alice.token })).data;
		expect(gunzipSync(Buffer.from(transcript.content, "base64")).toString("utf8")).toBe('{"type":"session"}\n{"type":"message","text":"hello"}\n');
	});
});

type UIRequestLike = Parameters<Member["ctx"]["emit"]["uiRequest"]>[1];
